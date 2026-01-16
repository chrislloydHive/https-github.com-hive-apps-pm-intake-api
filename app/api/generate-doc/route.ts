import { NextResponse } from "next/server";
import { z } from "zod";
import Airtable from "airtable";

/**
 * POST /api/generate-doc
 *
 * Generates a branded Google Doc from source notes using OpenAI for content
 * structuring, then calls a Google Apps Script to create the doc in Drive.
 *
 * All docs are created directly in a single Shared Drive folder controlled
 * by the DOCS_DEFAULT_FOLDER_ID environment variable. Airtable does NOT
 * need to pass folder IDs — this API is the source of truth for placement.
 *
 * REQUIRED ENV VARS:
 * - OPENAI_API_KEY: OpenAI API key for content generation
 * - APPS_SCRIPT_DOC_WEBAPP_URL: Google Apps Script /exec URL for doc creation
 * - PM_INTAKE_SHARED_SECRET: Shared secret for x-hive-secret header auth
 * - DOCS_DEFAULT_FOLDER_ID: Shared Drive folder ID where all docs are created
 *
 * OPTIONAL ENV VARS:
 * - AIRTABLE_API_KEY: Airtable API key for template lookup and write-back
 * - AIRTABLE_BASE_ID: Airtable base ID containing Doc Templates table
 * - AIRTABLE_DOC_TEMPLATES_TABLE: Table name for templates (default: "Doc Templates")
 * - AIRTABLE_DOCS_TABLE: Table name for docs (default: "Docs")
 * - TEMPLATE_DOC_ID: Fallback Google Doc template ID if no Airtable match
 */

const DEFAULT_DOC_TEMPLATES_TABLE = "Doc Templates";

// --- Airtable Value Coercion ---

/**
 * Coerces Airtable field values into strings.
 * Airtable lookup/linked fields may arrive as:
 * - string: "value"
 * - array: ["value"] or [{ name: "value" }] or [{ value: "value" }]
 * - object: { name: "value" } or { value: "value" }
 */
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
    "docTitleOverride",
    "subtitleOverride",
    "highlightsLabelOverride",
    "projectFolderId",
  ];

  for (const field of fieldsToCoerce) {
    if (field in body) {
      coerced[field] = coerceToString(body[field]);
    }
  }

  return coerced;
}

// --- Zod Schemas ---

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
  docTitleOverride: optionalString,
  subtitleOverride: optionalString,
  highlightsLabelOverride: optionalString,
  projectFolderId: optionalString, // Optional override - env var is source of truth
});

const BlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("h1"), text: z.string() }),
  z.object({ type: z.literal("h2"), text: z.string() }),
  z.object({ type: z.literal("h3"), text: z.string() }),
  z.object({ type: z.literal("p"), text: z.string() }),
  z.object({ type: z.literal("bullets"), items: z.array(z.string()) }),
  z.object({
    type: z.literal("table"),
    headers: z.array(z.string()),
    rows: z.array(z.array(z.string())),
  }),
]);

const GeneratedContentSchema = z.object({
  docTitle: z.string(),
  subtitle: z.string(),
  execSummary: z.array(z.string()),
  bodyBlocks: z.array(BlockSchema),
  highlights: z.object({
    label: z.string(),
    items: z.array(z.string()),
  }),
  appendixBlocks: z.array(BlockSchema).optional(),
});

type GeneratedContent = z.infer<typeof GeneratedContentSchema>;

// --- Helpers ---

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

// --- Folder Resolution ---

/**
 * Extracts a Google Drive folder ID from various formats.
 * Returns null if input is empty, an Airtable record ID, or unparseable.
 */
function normalizeFolderId(input: string | null | undefined): string | null {
  if (!input) return null;

  const trimmed = input.trim();
  if (!trimmed) return null;

  // Reject Airtable record IDs
  if (/^rec[a-zA-Z0-9]{10,}$/i.test(trimmed)) {
    return null;
  }

  // Extract from URL patterns
  const foldersMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (foldersMatch) return foldersMatch[1];

  const idParamMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idParamMatch) return idParamMatch[1];

  // Raw folder ID
  if (
    /^[a-zA-Z0-9_-]{10,}$/.test(trimmed) &&
    !trimmed.includes("/") &&
    !trimmed.includes(".") &&
    !trimmed.toLowerCase().startsWith("rec")
  ) {
    return trimmed;
  }

  return null;
}

type FolderResolution = {
  folderId: string;
  source: "payload" | "env";
};

/**
 * Resolves destination folder ID.
 * Priority: payload.projectFolderId > DOCS_DEFAULT_FOLDER_ID
 * Returns null if neither is available.
 */
function resolveDestinationFolder(payloadFolderId: string | null): FolderResolution | null {
  // Try payload first (normalized)
  const normalizedPayload = normalizeFolderId(payloadFolderId);
  if (normalizedPayload) {
    return { folderId: normalizedPayload, source: "payload" };
  }

  // Fall back to env var
  const envFolderId = process.env.DOCS_DEFAULT_FOLDER_ID?.trim();
  if (envFolderId) {
    return { folderId: envFolderId, source: "env" };
  }

  return null;
}

// --- Airtable Helpers ---

function getAirtableBase() {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!apiKey || !baseId) return null;
  return new Airtable({ apiKey }).base(baseId);
}

type ExistingDocResult =
  | { exists: true; docId: string; docUrl: string; pdfUrl: string; projectFolderId: string }
  | { exists: false };

async function checkExistingDoc(docRecordId: string, requestId: string): Promise<ExistingDocResult> {
  const base = getAirtableBase();
  const docsTable = process.env.AIRTABLE_DOCS_TABLE || "Docs";

  if (!base) {
    return { exists: false };
  }

  try {
    const record = await base(docsTable).find(docRecordId);
    const docId = record.get("Doc ID") as string | undefined;
    const docUrl = record.get("Doc URL") as string | undefined;

    if (docId && docUrl) {
      console.log(`[generate-doc][${requestId}] Found existing doc: docId=${docId}`);
      return {
        exists: true,
        docId,
        docUrl,
        pdfUrl: (record.get("PDF URL") as string) || "",
        projectFolderId: (record.get("Project Folder ID") as string) || "",
      };
    }

    return { exists: false };
  } catch (error: any) {
    console.warn(`[generate-doc][${requestId}] Idempotency check failed:`, error?.message ?? error);
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
    console.log(`[generate-doc][${requestId}] Airtable write-back success: ${Object.keys(fields).join(", ")}`);
  } catch (error: any) {
    console.error(`[generate-doc][${requestId}] Airtable write-back failed:`, error?.message ?? error);
  }
}

// --- Template Resolution ---

type TemplateResolutionResult =
  | { ok: true; templateDocId: string; source: "airtable" | "env_fallback" }
  | { ok: false; error: string };

async function resolveTemplateDocId(docType: string, requestId: string): Promise<TemplateResolutionResult> {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableName = process.env.AIRTABLE_DOC_TEMPLATES_TABLE || DEFAULT_DOC_TEMPLATES_TABLE;

  if (!apiKey || !baseId) {
    const fallbackId = process.env.TEMPLATE_DOC_ID;
    if (fallbackId) {
      return { ok: true, templateDocId: fallbackId, source: "env_fallback" };
    }
    return { ok: false, error: "No template configuration available" };
  }

  const base = new Airtable({ apiKey }).base(baseId);

  try {
    const records = await base(tableName)
      .select({
        filterByFormula: `AND({Active}, {Default for Doc Type}, {Doc Type} = "${docType}")`,
        maxRecords: 10,
      })
      .firstPage();

    if (records.length === 0) {
      const fallbackId = process.env.TEMPLATE_DOC_ID;
      if (fallbackId) {
        return { ok: true, templateDocId: fallbackId, source: "env_fallback" };
      }
      return { ok: false, error: `No template found for docType: ${docType}` };
    }

    if (records.length > 1) {
      return { ok: false, error: `Multiple templates found for docType: ${docType}` };
    }

    const templateDocId = records[0].get("Template Doc ID") as string;
    if (!templateDocId) {
      return { ok: false, error: `Template Doc ID is empty for docType: ${docType}` };
    }

    return { ok: true, templateDocId, source: "airtable" };
  } catch (error: any) {
    return { ok: false, error: `Template lookup failed: ${error?.message ?? "Unknown error"}` };
  }
}

// --- OpenAI Content Generation ---

async function generateStructuredContent(
  input: z.infer<typeof InputSchema>,
  requestId: string
): Promise<GeneratedContent> {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  const systemPrompt = `You are a business document specialist. Given raw notes, generate structured content for a professional branded document.

Output a JSON object with:
- docTitle: A clear, professional title for the document
- subtitle: A brief subtitle/tagline (e.g., "Prepared for [Client]" or a date range)
- execSummary: Array of 2-4 short bullet points summarizing key takeaways
- bodyBlocks: Array of content blocks with types:
  - { "type": "h1", "text": "..." } for major section headings
  - { "type": "h2", "text": "..." } for sub-section headings
  - { "type": "h3", "text": "..." } for minor headings
  - { "type": "p", "text": "..." } for paragraphs
  - { "type": "bullets", "items": ["...", "..."] } for bullet lists
  - { "type": "table", "headers": ["Col1", "Col2"], "rows": [["a", "b"], ["c", "d"]] } for tables
- highlights: { "label": "Key Takeaways" or "Action Items" or "Next Steps", "items": ["...", "..."] }
- appendixBlocks: (optional) Array of blocks for supplementary content`;

  const userPrompt = `Project: ${input.projectName}
Client: ${input.clientName}
Document Type: ${input.docType}
${input.docTitleOverride ? `Title Override: ${input.docTitleOverride}` : ""}
${input.subtitleOverride ? `Subtitle Override: ${input.subtitleOverride}` : ""}
${input.highlightsLabelOverride ? `Highlights Label Override: ${input.highlightsLabelOverride}` : ""}

Source Notes:
${input.sourceNotes}`;

  const jsonSchema = {
    name: "document_content",
    strict: false,
    schema: {
      type: "object",
      properties: {
        docTitle: { type: "string" },
        subtitle: { type: "string" },
        execSummary: { type: "array", items: { type: "string" } },
        bodyBlocks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["h1", "h2", "h3", "p", "bullets", "table"] },
              text: { type: "string" },
              items: { type: "array", items: { type: "string" } },
              headers: { type: "array", items: { type: "string" } },
              rows: { type: "array", items: { type: "array", items: { type: "string" } } },
            },
            required: ["type"],
            additionalProperties: false,
          },
        },
        highlights: {
          type: "object",
          properties: {
            label: { type: "string" },
            items: { type: "array", items: { type: "string" } },
          },
          required: ["label", "items"],
          additionalProperties: false,
        },
        appendixBlocks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["h1", "h2", "h3", "p", "bullets", "table"] },
              text: { type: "string" },
              items: { type: "array", items: { type: "string" } },
              headers: { type: "array", items: { type: "string" } },
              rows: { type: "array", items: { type: "array", items: { type: "string" } } },
            },
            required: ["type"],
            additionalProperties: false,
          },
        },
      },
      required: ["docTitle", "subtitle", "execSummary", "bodyBlocks", "highlights"],
      additionalProperties: false,
    },
  };

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
      response_format: { type: "json_schema", json_schema: jsonSchema },
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorDetail = "";
    try {
      const errJson = JSON.parse(errorText);
      errorDetail = errJson.error?.message || errorText.slice(0, 200);
    } catch {
      errorDetail = errorText.slice(0, 200);
    }
    throw new Error(`OpenAI API error: ${response.status} - ${errorDetail}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("OpenAI returned empty content");
  }

  const parsed = JSON.parse(content);
  return GeneratedContentSchema.parse(parsed);
}

// --- Apps Script Doc Creation ---

async function createDocInDrive(
  content: GeneratedContent,
  destinationFolderId: string,
  templateDocId: string,
  requestId: string
): Promise<{ ok: boolean; docId?: string; docUrl?: string; pdfUrl?: string; error?: string }> {
  const appsScriptUrl = process.env.APPS_SCRIPT_DOC_WEBAPP_URL;

  if (!appsScriptUrl) {
    console.warn(`[generate-doc][${requestId}] APPS_SCRIPT_DOC_WEBAPP_URL not configured`);
    return { ok: false, error: "APPS_SCRIPT_DOC_WEBAPP_URL not configured" };
  }

  const payload = {
    templateDocId,
    projectFolderId: destinationFolderId,
    docTitle: content.docTitle,
    subtitle: content.subtitle,
    date: new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "America/Los_Angeles",
    }),
    generatedAt: new Date().toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }),
    execSummary: content.execSummary,
    bodyBlocks: content.bodyBlocks,
    highlights: content.highlights,
    appendixBlocks: content.appendixBlocks || [],
    // Shared Drive flags for Apps Script to use
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  };

  console.log(
    `[generate-doc][${requestId}] Calling Apps Script: destinationFolderId=${destinationFolderId}, supportsAllDrives=true`
  );

  const response = await fetch(appsScriptUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "follow",
  });

  const responseText = await response.text();

  if (!response.ok) {
    console.error(`[generate-doc][${requestId}] Apps Script error: ${response.status}`);
    return { ok: false, error: `Apps Script returned ${response.status}` };
  }

  try {
    const result = JSON.parse(responseText);
    if (!result.ok) {
      return { ok: false, error: result.error || "Apps Script returned ok:false" };
    }

    console.log(
      `[generate-doc][${requestId}] Drive API response: docId=${result.docId}, placed in folder=${destinationFolderId}`
    );

    return result;
  } catch {
    return { ok: false, error: `Failed to parse Apps Script response` };
  }
}

// --- Main Handler ---

export async function POST(req: Request) {
  const requestId = generateRequestId();

  // Auth check
  const authCheck = isAuthorized(req);
  if (!authCheck.ok) {
    return NextResponse.json(
      { ok: false, error: authCheck.reason, debug: { stage: "AUTH" } },
      { status: 401 }
    );
  }

  // Parse body
  let rawBody: Record<string, unknown>;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body", debug: { stage: "VALIDATION" } },
      { status: 400 }
    );
  }

  // Coerce Airtable field shapes
  const body = coerceRequestBody(rawBody);

  // Validate input
  const parseResult = InputSchema.safeParse(body);
  if (!parseResult.success) {
    const errors = parseResult.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
    const firstError = parseResult.error.errors[0];
    const missingField = firstError?.path?.[0] || "unknown";
    return NextResponse.json(
      { ok: false, error: `Missing or invalid field: ${missingField}`, debug: { stage: "VALIDATION", details: errors } },
      { status: 400 }
    );
  }

  const input = parseResult.data;
  const docRecordId = input.docRecordId;

  // Resolve destination folder (env var is source of truth)
  const folderResolution = resolveDestinationFolder(input.projectFolderId);

  if (!folderResolution) {
    console.error(`[generate-doc][${requestId}] Missing destination folder ID`);
    return NextResponse.json(
      {
        ok: false,
        error: "Missing destination folder ID. Set DOCS_DEFAULT_FOLDER_ID env var.",
        debug: { stage: "FOLDER_RESOLUTION", payloadFolderId: input.projectFolderId, envConfigured: false },
      },
      { status: 500 }
    );
  }

  const destinationFolderId = folderResolution.folderId;
  const folderSource = folderResolution.source;

  console.log(
    `[generate-doc][${requestId}] Folder resolution: id=${destinationFolderId}, source=${folderSource}, supportsAllDrives=true`
  );

  // Idempotency check
  if (docRecordId) {
    const existingDoc = await checkExistingDoc(docRecordId, requestId);
    if (existingDoc.exists) {
      console.log(`[generate-doc][${requestId}] Returning existing doc (idempotent)`);
      return NextResponse.json({
        ok: true,
        docUrl: existingDoc.docUrl,
        docId: existingDoc.docId,
        pdfUrl: existingDoc.pdfUrl,
        projectFolderId: existingDoc.projectFolderId || destinationFolderId,
      });
    }
  }

  // Generate content via OpenAI
  let content: GeneratedContent;
  try {
    content = await generateStructuredContent(input, requestId);
  } catch (error: any) {
    console.error(`[generate-doc][${requestId}] OpenAI error:`, error.message);
    return NextResponse.json(
      { ok: false, error: `Content generation failed: ${error.message}`, debug: { stage: "OPENAI" } },
      { status: 500 }
    );
  }

  // Resolve template
  const templateResult = await resolveTemplateDocId(input.docType, requestId);
  if (!templateResult.ok) {
    return NextResponse.json(
      { ok: false, error: templateResult.error, debug: { stage: "TEMPLATE" } },
      { status: 500 }
    );
  }

  // Create doc in Drive (directly in destination folder)
  const docResult = await createDocInDrive(content, destinationFolderId, templateResult.templateDocId, requestId);

  if (!docResult.ok) {
    console.error(`[generate-doc][${requestId}] Doc creation failed:`, docResult.error);
    return NextResponse.json(
      { ok: false, error: docResult.error, debug: { stage: "DOC_CREATE", destinationFolderId, folderSource } },
      { status: 500 }
    );
  }

  if (!docResult.docId || !docResult.docUrl) {
    return NextResponse.json(
      { ok: false, error: "Doc creation succeeded but missing docId/docUrl", debug: { stage: "DOC_CREATE" } },
      { status: 500 }
    );
  }

  // Write back to Airtable (URLs + IDs only)
  if (docRecordId) {
    const writeBackFields: Record<string, string> = {
      "Doc ID": docResult.docId,
      "Doc URL": docResult.docUrl,
      "Project Folder ID": destinationFolderId,
    };
    if (docResult.pdfUrl) {
      writeBackFields["PDF URL"] = docResult.pdfUrl;
    }
    await writeBackToAirtable(docRecordId, writeBackFields, requestId);
  }

  // Summary log
  console.log(
    `[generate-doc][${requestId}] SUCCESS: docRecordId=${docRecordId || "(none)"}, docId=${docResult.docId}, folderId=${destinationFolderId}, folderSource=${folderSource}`
  );

  // Success response (exact keys as specified)
  return NextResponse.json({
    ok: true,
    docUrl: docResult.docUrl,
    docId: docResult.docId,
    pdfUrl: docResult.pdfUrl || "",
    projectFolderId: destinationFolderId,
  });
}

// Reject non-POST requests
export async function GET() {
  return NextResponse.json({ ok: false, error: "Method not allowed. Use POST." }, { status: 405 });
}

export async function PUT() {
  return NextResponse.json({ ok: false, error: "Method not allowed. Use POST." }, { status: 405 });
}

export async function DELETE() {
  return NextResponse.json({ ok: false, error: "Method not allowed. Use POST." }, { status: 405 });
}
