import { NextResponse } from "next/server";
import { z } from "zod";
import Airtable from "airtable";

/**
 * POST /api/generate-doc
 *
 * HYBRID GENERATOR:
 * 1. GPT "polish" step produces { title, subtitle, content } JSON
 * 2. Copy a Google Docs template into a NEW doc in the Shared Drive
 * 3. Replace placeholders: {{TITLE}}, {{SUBTITLE}}, {{GENERATED_AT}}, {{CONTENT}}
 * 4. Return docUrl/docId
 *
 * All docs are placed in a single Shared Drive folder: "Prepared Documents"
 * controlled by PREPARED_DOCUMENTS_FOLDER_ID env var.
 *
 * REQUIRED ENV VARS:
 * - OPENAI_API_KEY: OpenAI API key for GPT polish
 * - APPS_SCRIPT_DOC_WEBAPP_URL: Google Apps Script URL for doc creation
 * - PM_INTAKE_SHARED_SECRET: Shared secret for x-hive-secret header auth
 * - PREPARED_DOCUMENTS_FOLDER_ID: Shared Drive folder ID for all generated docs
 *
 * OPTIONAL ENV VARS:
 * - AIRTABLE_API_KEY: For template lookup fallback and write-back
 * - AIRTABLE_BASE_ID: Airtable base ID
 * - AIRTABLE_DOCS_TABLE: Table name for docs (default: "Docs")
 */

// =============================================================================
// TEMPLATE CONFIGURATION
// =============================================================================

/**
 * Template IDs for each document type.
 * - Document Template (default): General purpose
 * - Project Brief: Project-specific template
 * - Project Timeline: Timeline-focused template
 */
const TEMPLATE_IDS = {
  DEFAULT: "1f8Zn0Bd62c1RuvUN1k6YKfrrVkYhH6ugXbW9geh29vo",
  PROJECT_BRIEF: "11PXHM5b8GhR9D2DzuC2ztLOEvV87RXHBSYJkdjuxc_A",
  PROJECT_TIMELINE: "1XTyZXgICgBfupXyhslVn15f8H119j7GPT5wXR2igJvc",
} as const;

/**
 * Maps docType to template ID.
 * - "Project Brief" -> PROJECT_BRIEF template
 * - "Project Timeline" -> PROJECT_TIMELINE template
 * - Everything else -> DEFAULT template
 */
function selectTemplateId(docType: string): string {
  const normalized = docType.trim().toLowerCase();

  if (normalized === "project brief") {
    return TEMPLATE_IDS.PROJECT_BRIEF;
  }

  if (normalized === "project timeline") {
    return TEMPLATE_IDS.PROJECT_TIMELINE;
  }

  // Default for: Branded Doc, SOW, Analytics Report, Meeting Recap, Strategy Memo, Other, etc.
  return TEMPLATE_IDS.DEFAULT;
}

// =============================================================================
// AIRTABLE VALUE COERCION
// =============================================================================

function coerceToString(val: unknown): string | null {
  if (val === null || val === undefined) return null;

  if (typeof val === "string") {
    const trimmed = val.trim();
    return trimmed || null;
  }

  if (Array.isArray(val)) {
    if (val.length === 0) return null;
    const first = val[0];
    if (first && typeof first === "object") {
      const obj = first as Record<string, unknown>;
      if (typeof obj.name === "string") return obj.name.trim() || null;
      if (typeof obj.value === "string") return obj.value.trim() || null;
      try {
        return JSON.stringify(first);
      } catch {
        return null;
      }
    }
    if (typeof first === "string") return first.trim() || null;
    if (typeof first === "number") return String(first);
    return null;
  }

  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    if (typeof obj.name === "string") return obj.name.trim() || null;
    if (typeof obj.value === "string") return obj.value.trim() || null;
    try {
      return JSON.stringify(val);
    } catch {
      return null;
    }
  }

  if (typeof val === "number") return String(val);
  return null;
}

function coerceRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const coerced: Record<string, unknown> = { ...body };
  const fieldsToCoerce = [
    "docRecordId",
    "projectName",
    "clientName",
    "docType",
    "sourceNotes",
    "polishNotes",
    "projectFolderId",
  ];

  for (const field of fieldsToCoerce) {
    if (field in body) {
      coerced[field] = coerceToString(body[field]);
    }
  }

  return coerced;
}

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

const optionalString = z
  .string()
  .optional()
  .nullable()
  .transform((val) => (val?.trim() || null));

const InputSchema = z.object({
  docRecordId: optionalString,
  projectName: z.string().min(1, "projectName is required"),
  clientName: z.string().min(1, "clientName is required"),
  docType: z.string().min(1, "docType is required"),
  sourceNotes: z.string().min(1, "sourceNotes is required"),
  polishNotes: optionalString, // Optional additional instructions for polish
  projectFolderId: optionalString, // IGNORED for placement - always use PREPARED_DOCUMENTS_FOLDER_ID
});

// GPT Polish output schema (strict)
const PolishOutputSchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  content: z.string(),
});

type PolishOutput = z.infer<typeof PolishOutputSchema>;

// =============================================================================
// HELPERS
// =============================================================================

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getPacificTimestamp(): string {
  return new Date().toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function isAuthorized(req: Request): { ok: true } | { ok: false; reason: string } {
  const envSecret = (process.env.PM_INTAKE_SHARED_SECRET || "").trim();
  const headerSecret = (req.headers.get("x-hive-secret") || "").trim();

  if (!envSecret) {
    return { ok: false, reason: "PM_INTAKE_SHARED_SECRET not configured on server" };
  }

  if (!headerSecret) {
    return { ok: false, reason: "x-hive-secret header missing" };
  }

  if (headerSecret !== envSecret) {
    return { ok: false, reason: "Invalid secret" };
  }

  return { ok: true };
}

// =============================================================================
// AIRTABLE HELPERS
// =============================================================================

function getAirtableBase() {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!apiKey || !baseId) return null;
  return new Airtable({ apiKey }).base(baseId);
}

type ExistingDocResult =
  | { exists: true; docId: string; docUrl: string; pdfUrl: string }
  | { exists: false };

async function checkExistingDoc(docRecordId: string, requestId: string): Promise<ExistingDocResult> {
  const base = getAirtableBase();
  const docsTable = process.env.AIRTABLE_DOCS_TABLE || "Docs";

  if (!base) return { exists: false };

  try {
    const record = await base(docsTable).find(docRecordId);
    const docId = record.get("Doc ID") as string | undefined;
    const docUrl = record.get("Doc URL") as string | undefined;

    if (docId && docUrl) {
      console.log(`[generate-doc][${requestId}] Found existing doc: ${docId}`);
      return {
        exists: true,
        docId,
        docUrl,
        pdfUrl: (record.get("PDF URL") as string) || "",
      };
    }

    return { exists: false };
  } catch (error: any) {
    console.warn(`[generate-doc][${requestId}] Idempotency check failed:`, error?.message);
    return { exists: false };
  }
}

async function writeBackToAirtable(
  docRecordId: string,
  fields: Record<string, string>,
  requestId: string
): Promise<void> {
  const base = getAirtableBase();
  const docsTable = process.env.AIRTABLE_DOCS_TABLE || "Docs";

  if (!base) return;

  try {
    await base(docsTable).update(docRecordId, fields);
    console.log(`[generate-doc][${requestId}] Airtable write-back: ${Object.keys(fields).join(", ")}`);
  } catch (error: any) {
    console.error(`[generate-doc][${requestId}] Airtable write-back failed:`, error?.message);
  }
}

// =============================================================================
// GPT POLISH
// =============================================================================

/**
 * Calls GPT to "polish" the source notes into structured content.
 * Output: { title, subtitle, content } as strict JSON.
 *
 * Rules:
 * - No invention: only use information from sourceNotes
 * - Content-adaptive: may skip or reuse sections as appropriate
 * - Do not force optional modules
 */
async function gptPolish(
  input: {
    docType: string;
    clientName: string;
    projectName: string;
    generatedAt: string;
    sourceNotes: string;
    polishNotes?: string | null;
  },
  requestId: string
): Promise<{ ok: true; data: PolishOutput } | { ok: false; error: string; raw?: string }> {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    return { ok: false, error: "OPENAI_API_KEY not configured" };
  }

  const systemPrompt = `You are a professional document editor. Your job is to polish raw notes into clean, professional document content.

OUTPUT FORMAT (strict JSON, no code fences):
{
  "title": "Document title",
  "subtitle": "Optional subtitle or tagline",
  "content": "The main body content, formatted with markdown"
}

RULES:
1. NO INVENTION: Only use information present in the source notes. Do not add facts, dates, or details not provided.
2. CONTENT-ADAPTIVE: Structure the content to fit what's provided. Skip sections that don't apply. Reuse sections if helpful.
3. PROFESSIONAL TONE: Write in clear, professional business language.
4. MARKDOWN FORMATTING: Use markdown in the content field (headers, bullets, bold, etc.) for structure.
5. TITLE: Create a clear, descriptive title. If unsure, use format: "[Client] — [Doc Type]"
6. SUBTITLE: Brief tagline or description. Can be empty string if not applicable.

Document Type: ${input.docType}
Client: ${input.clientName}
Project: ${input.projectName}`;

  const userPrompt = `Please polish these notes into a professional ${input.docType}.

SOURCE NOTES:
${input.sourceNotes}
${input.polishNotes ? `\nADDITIONAL INSTRUCTIONS:\n${input.polishNotes}` : ""}

Return ONLY the JSON object with title, subtitle, and content. No code fences or explanation.`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[generate-doc][${requestId}] OpenAI error: ${response.status}`);
      return { ok: false, error: `OpenAI API error: ${response.status}`, raw: errorText.slice(0, 500) };
    }

    const data = await response.json();
    const rawContent = data.choices?.[0]?.message?.content;

    if (!rawContent) {
      return { ok: false, error: "OpenAI returned empty content" };
    }

    // Clean potential code fences
    let cleanedContent = rawContent.trim();
    if (cleanedContent.startsWith("```json")) {
      cleanedContent = cleanedContent.slice(7);
    } else if (cleanedContent.startsWith("```")) {
      cleanedContent = cleanedContent.slice(3);
    }
    if (cleanedContent.endsWith("```")) {
      cleanedContent = cleanedContent.slice(0, -3);
    }
    cleanedContent = cleanedContent.trim();

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleanedContent);
    } catch (parseErr) {
      console.error(`[generate-doc][${requestId}] JSON parse failed:`, cleanedContent.slice(0, 200));
      return { ok: false, error: "GPT output is not valid JSON", raw: cleanedContent.slice(0, 500) };
    }

    // Validate schema
    const validated = PolishOutputSchema.safeParse(parsed);
    if (!validated.success) {
      const errors = validated.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
      return { ok: false, error: `GPT output schema invalid: ${errors}`, raw: cleanedContent.slice(0, 500) };
    }

    console.log(`[generate-doc][${requestId}] GPT polish success: title="${validated.data.title.slice(0, 50)}..."`);
    return { ok: true, data: validated.data };
  } catch (error: any) {
    return { ok: false, error: `GPT polish exception: ${error?.message}` };
  }
}

// =============================================================================
// APPS SCRIPT DOC CREATION
// =============================================================================

/**
 * Calls Apps Script to:
 * 1. Copy the template doc to the destination folder
 * 2. Replace placeholders: {{TITLE}}, {{SUBTITLE}}, {{GENERATED_AT}}, {{CONTENT}}
 * 3. Return docId, docUrl, pdfUrl
 */
async function createDocFromTemplate(
  params: {
    templateDocId: string;
    destinationFolderId: string;
    title: string;
    subtitle: string;
    generatedAt: string;
    content: string;
    docName: string; // Name for the new doc file
  },
  requestId: string
): Promise<{ ok: true; docId: string; docUrl: string; pdfUrl: string } | { ok: false; error: string }> {
  const appsScriptUrl = process.env.APPS_SCRIPT_DOC_WEBAPP_URL;

  if (!appsScriptUrl) {
    return { ok: false, error: "APPS_SCRIPT_DOC_WEBAPP_URL not configured" };
  }

  const payload = {
    action: "createFromTemplate",
    templateDocId: params.templateDocId,
    destinationFolderId: params.destinationFolderId,
    docName: params.docName,
    placeholders: {
      "{{TITLE}}": params.title,
      "{{SUBTITLE}}": params.subtitle || "",
      "{{GENERATED_AT}}": params.generatedAt || "",
      "{{CONTENT}}": params.content || " ", // Single space if empty to avoid replacement issues
    },
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  };

  console.log(
    `[generate-doc][${requestId}] Calling Apps Script: template=${params.templateDocId}, folder=${params.destinationFolderId}`
  );

  try {
    const response = await fetch(appsScriptUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow",
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error(`[generate-doc][${requestId}] Apps Script HTTP error: ${response.status}`);
      return { ok: false, error: `Apps Script returned ${response.status}` };
    }

    let result: any;
    try {
      result = JSON.parse(responseText);
    } catch {
      return { ok: false, error: "Apps Script returned invalid JSON" };
    }

    if (!result.ok) {
      return { ok: false, error: result.error || "Apps Script returned ok:false" };
    }

    if (!result.docId || !result.docUrl) {
      return { ok: false, error: "Apps Script response missing docId or docUrl" };
    }

    console.log(`[generate-doc][${requestId}] Doc created: ${result.docId}`);
    return {
      ok: true,
      docId: result.docId,
      docUrl: result.docUrl,
      pdfUrl: result.pdfUrl || "",
    };
  } catch (error: any) {
    return { ok: false, error: `Apps Script exception: ${error?.message}` };
  }
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

export async function POST(req: Request) {
  const requestId = generateRequestId();
  const generatedAt = getPacificTimestamp();

  // ---------------------------------------------------------------------------
  // AUTH
  // ---------------------------------------------------------------------------
  const authCheck = isAuthorized(req);
  if (!authCheck.ok) {
    return NextResponse.json(
      { ok: false, status: 401, error: authCheck.reason, debug: { stage: "AUTH" } },
      { status: 401 }
    );
  }

  // ---------------------------------------------------------------------------
  // PARSE & VALIDATE
  // ---------------------------------------------------------------------------
  let rawBody: Record<string, unknown>;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, status: 400, error: "Invalid JSON body", debug: { stage: "PARSE" } },
      { status: 400 }
    );
  }

  const body = coerceRequestBody(rawBody);
  const parseResult = InputSchema.safeParse(body);

  if (!parseResult.success) {
    const errors = parseResult.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
    return NextResponse.json(
      { ok: false, status: 400, error: `Validation failed: ${errors[0]}`, debug: { stage: "VALIDATE", errors } },
      { status: 400 }
    );
  }

  const input = parseResult.data;
  const docRecordId = input.docRecordId;

  console.log(
    `[generate-doc][${requestId}] Request: docType="${input.docType}", client="${input.clientName}", project="${input.projectName}"`
  );

  // ---------------------------------------------------------------------------
  // FOLDER RESOLUTION (constant: PREPARED_DOCUMENTS_FOLDER_ID)
  // ---------------------------------------------------------------------------
  const destinationFolderId = process.env.PREPARED_DOCUMENTS_FOLDER_ID?.trim();

  if (!destinationFolderId) {
    console.error(`[generate-doc][${requestId}] PREPARED_DOCUMENTS_FOLDER_ID not configured`);
    return NextResponse.json(
      {
        ok: false,
        status: 500,
        error: "PREPARED_DOCUMENTS_FOLDER_ID env var is not configured. All docs go to Prepared Documents folder.",
        debug: { stage: "FOLDER" },
      },
      { status: 500 }
    );
  }

  console.log(`[generate-doc][${requestId}] Destination folder: ${destinationFolderId} (Prepared Documents)`);

  // ---------------------------------------------------------------------------
  // TEMPLATE SELECTION
  // ---------------------------------------------------------------------------
  const templateDocId = selectTemplateId(input.docType);
  console.log(`[generate-doc][${requestId}] Template: ${templateDocId} (docType="${input.docType}")`);

  // ---------------------------------------------------------------------------
  // IDEMPOTENCY CHECK
  // ---------------------------------------------------------------------------
  if (docRecordId) {
    const existing = await checkExistingDoc(docRecordId, requestId);
    if (existing.exists) {
      console.log(`[generate-doc][${requestId}] Returning existing doc (idempotent)`);
      return NextResponse.json({
        ok: true,
        status: 200,
        docId: existing.docId,
        docUrl: existing.docUrl,
        pdfUrl: existing.pdfUrl,
        debug: { reused: true },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // GPT POLISH
  // ---------------------------------------------------------------------------
  const polishResult = await gptPolish(
    {
      docType: input.docType,
      clientName: input.clientName,
      projectName: input.projectName,
      generatedAt,
      sourceNotes: input.sourceNotes,
      polishNotes: input.polishNotes,
    },
    requestId
  );

  if (!polishResult.ok) {
    console.error(`[generate-doc][${requestId}] GPT polish failed: ${polishResult.error}`);
    return NextResponse.json(
      {
        ok: false,
        status: 500,
        error: polishResult.error,
        debug: { stage: "GPT_POLISH", raw: polishResult.raw?.slice(0, 300) },
      },
      { status: 500 }
    );
  }

  const polished = polishResult.data;

  // Fallback title if GPT returned empty
  const finalTitle =
    polished.title.trim() || `${input.clientName} — ${input.docType} (${input.projectName})`;

  // Doc file name (for Drive)
  const docName = `${finalTitle} — ${new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" })}`;

  // ---------------------------------------------------------------------------
  // CREATE DOC FROM TEMPLATE
  // ---------------------------------------------------------------------------
  const docResult = await createDocFromTemplate(
    {
      templateDocId,
      destinationFolderId,
      title: finalTitle,
      subtitle: polished.subtitle,
      generatedAt,
      content: polished.content,
      docName,
    },
    requestId
  );

  if (!docResult.ok) {
    console.error(`[generate-doc][${requestId}] Doc creation failed: ${docResult.error}`);
    return NextResponse.json(
      {
        ok: false,
        status: 500,
        error: docResult.error,
        debug: { stage: "DOC_CREATE", templateDocId, destinationFolderId },
      },
      { status: 500 }
    );
  }

  // ---------------------------------------------------------------------------
  // AIRTABLE WRITE-BACK
  // ---------------------------------------------------------------------------
  if (docRecordId) {
    const writeBackFields: Record<string, string> = {
      "Doc ID": docResult.docId,
      "Doc URL": docResult.docUrl,
    };
    if (docResult.pdfUrl) {
      writeBackFields["PDF URL"] = docResult.pdfUrl;
    }
    await writeBackToAirtable(docRecordId, writeBackFields, requestId);
  }

  // ---------------------------------------------------------------------------
  // SUCCESS RESPONSE
  // ---------------------------------------------------------------------------
  console.log(
    `[generate-doc][${requestId}] SUCCESS: docId=${docResult.docId}, docUrl=${docResult.docUrl}`
  );

  return NextResponse.json({
    ok: true,
    status: 200,
    docId: docResult.docId,
    docUrl: docResult.docUrl,
    pdfUrl: docResult.pdfUrl,
    debug: {
      templateDocId,
      destinationFolderId,
      title: finalTitle.slice(0, 100),
    },
  });
}

// =============================================================================
// REJECT NON-POST
// =============================================================================

export async function GET() {
  return NextResponse.json({ ok: false, error: "Method not allowed. Use POST." }, { status: 405 });
}

export async function PUT() {
  return NextResponse.json({ ok: false, error: "Method not allowed. Use POST." }, { status: 405 });
}

export async function DELETE() {
  return NextResponse.json({ ok: false, error: "Method not allowed. Use POST." }, { status: 405 });
}
