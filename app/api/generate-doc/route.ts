import { NextResponse } from "next/server";
import { z } from "zod";
import Airtable from "airtable";

/**
 * POST /api/generate-doc
 *
 * Generates a branded Google Doc from source notes using OpenAI for content
 * structuring, then calls a Google Apps Script to create the doc in Drive.
 *
 * WHY THIS EXISTS:
 * - Airtable Automations cannot follow HTTP redirects
 * - Google Apps Script web apps always return 302 redirects
 * - This endpoint orchestrates OpenAI + Apps Script calls server-side
 *
 * REQUIRED ENV VARS:
 * - OPENAI_API_KEY: OpenAI API key for content generation
 * - APPS_SCRIPT_DOC_WEBAPP_URL: Google Apps Script /exec URL for doc creation
 * - PM_INTAKE_SHARED_SECRET: Shared secret for x-hive-secret header auth
 * - AIRTABLE_API_KEY: Airtable API key for template lookup
 * - AIRTABLE_BASE_ID: Airtable base ID containing Doc Templates table
 *
 * OPTIONAL ENV VARS:
 * - AIRTABLE_DOC_TEMPLATES_TABLE: Table name for templates (default: "Doc Templates")
 * - TEMPLATE_DOC_ID: Fallback Google Doc template ID if no Airtable match
 *
 * Example curl:
 * curl -X POST https://pm-intake-api.vercel.app/api/generate-doc \
 *   -H "Content-Type: application/json" \
 *   -H "x-hive-secret: YOUR_SECRET" \
 *   -d '{
 *     "projectName": "Birthday Bash Promo",
 *     "clientName": "Car Toys",
 *     "docType": "Branded Doc",
 *     "sourceNotes": "Meeting notes here...",
 *     "projectFolderId": "1AbC..."
 *   }'
 */

const DEFAULT_DOC_TEMPLATES_TABLE = "Doc Templates";

// --- Zod Schemas ---

// Transform empty strings to null for optional fields
const optionalString = z.string().optional().nullable().transform((val) => (val?.trim() || null));

const InputSchema = z.object({
  docRecordId: optionalString,
  projectName: z.string().min(1, "projectName is required"),
  clientName: z.string().min(1, "clientName is required"),
  docType: z.string().min(1, "docType is required"),
  sourceNotes: z.string().min(1, "sourceNotes is required"),
  docTitleOverride: optionalString,
  subtitleOverride: optionalString,
  highlightsLabelOverride: optionalString,
  projectFolderId: optionalString,
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

// --- Project Folder Creation ---

const APPS_SCRIPT_FOLDER_URL =
  "https://script.google.com/macros/s/AKfycbx617qRmIJ8C-AJViav7FDdVvfrXRn7jNie1PdAIPW5Jz66peu4iM0yt8hSkrsuU9PVWA/exec";

type FolderResult =
  | { ok: true; folderId: string; folderUrl: string; created: boolean }
  | { ok: false; error: string };

async function createProjectFolder(
  clientName: string,
  projectName: string,
  requestId: string
): Promise<FolderResult> {
  const folderName = `${clientName} — ${projectName}`;

  console.log(`[generate-doc][${requestId}] Creating project folder: ${folderName}`);

  try {
    const response = await fetch(APPS_SCRIPT_FOLDER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recordId: requestId, // Use requestId as a reference
        projectName: folderName,
      }),
      redirect: "follow",
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error(`[generate-doc][${requestId}] Folder creation failed: ${response.status}`, responseText.slice(0, 300));
      return { ok: false, error: `Folder creation failed: ${response.status}` };
    }

    const result = JSON.parse(responseText);
    if (!result.ok || !result.folderId) {
      return { ok: false, error: result.error || "Folder creation returned no folderId" };
    }

    console.log(`[generate-doc][${requestId}] Folder created: ${result.folderId}`);
    return {
      ok: true,
      folderId: result.folderId,
      folderUrl: result.folderUrl || "",
      created: true,
    };
  } catch (error: any) {
    console.error(`[generate-doc][${requestId}] Folder creation error:`, error);
    return { ok: false, error: error?.message ?? "Unknown folder creation error" };
  }
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

async function checkExistingDoc(
  docRecordId: string,
  requestId: string
): Promise<ExistingDocResult> {
  const base = getAirtableBase();
  const docsTable = process.env.AIRTABLE_DOCS_TABLE || "Docs";

  if (!base) {
    console.warn(`[generate-doc][${requestId}] Airtable not configured, skipping idempotency check`);
    return { exists: false };
  }

  try {
    console.log(`[generate-doc][${requestId}] Checking for existing doc on record: ${docRecordId}`);
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
        projectFolderId: (record.get("Project Folder ID") as string) || "",
      };
    }

    return { exists: false };
  } catch (error: any) {
    console.warn(`[generate-doc][${requestId}] Failed to check existing doc:`, error?.message ?? error);
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

  if (!base) {
    console.warn(`[generate-doc][${requestId}] Airtable not configured, skipping write-back`);
    return;
  }

  try {
    console.log(`[generate-doc][${requestId}] Writing back to Airtable record: ${docRecordId}`, Object.keys(fields));
    await base(docsTable).update(docRecordId, fields);
    console.log(`[generate-doc][${requestId}] Airtable write-back successful`);
  } catch (error: any) {
    // Best-effort: log but don't fail
    console.error(`[generate-doc][${requestId}] Failed to write to Airtable:`, error?.message ?? error);
  }
}

// --- Airtable Template Lookup ---

type TemplateResolutionResult =
  | { ok: true; templateDocId: string; source: "airtable" | "env_fallback" }
  | { ok: false; error: string; status: 400 | 500 | 502 };

async function resolveTemplateDocId(
  docType: string,
  requestId: string
): Promise<TemplateResolutionResult> {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableName = process.env.AIRTABLE_DOC_TEMPLATES_TABLE || DEFAULT_DOC_TEMPLATES_TABLE;

  if (!apiKey || !baseId) {
    // Fall back to env var if Airtable not configured
    const fallbackId = process.env.TEMPLATE_DOC_ID;
    if (fallbackId) {
      console.log(
        `[generate-doc][${requestId}] Airtable not configured, using TEMPLATE_DOC_ID fallback`
      );
      return { ok: true, templateDocId: fallbackId, source: "env_fallback" };
    }
    return {
      ok: false,
      error: "Airtable not configured and no TEMPLATE_DOC_ID fallback set",
      status: 500,
    };
  }

  const base = new Airtable({ apiKey }).base(baseId);

  try {
    console.log(
      `[generate-doc][${requestId}] Querying Airtable for template: docType=${docType}`
    );

    // Query for active default templates matching the doc type
    const records = await base(tableName)
      .select({
        filterByFormula: `AND({Active}, {Default for Doc Type}, {Doc Type} = "${docType}")`,
        maxRecords: 10,
      })
      .firstPage();

    if (records.length === 0) {
      // No matching template found, try env fallback
      const fallbackId = process.env.TEMPLATE_DOC_ID;
      if (fallbackId) {
        console.log(
          `[generate-doc][${requestId}] No Airtable template found for docType=${docType}, using TEMPLATE_DOC_ID fallback`
        );
        return { ok: true, templateDocId: fallbackId, source: "env_fallback" };
      }
      return {
        ok: false,
        error: `No active default template found for docType: ${docType}`,
        status: 400,
      };
    }

    if (records.length > 1) {
      const templateNames = records.map((r) => r.get("Template Name")).join(", ");
      console.error(
        `[generate-doc][${requestId}] Multiple default templates found for docType=${docType}: ${templateNames}`
      );
      return {
        ok: false,
        error: `Multiple default templates found for docType: ${docType}. Expected exactly one. Found: ${templateNames}`,
        status: 500,
      };
    }

    const templateDocId = records[0].get("Template Doc ID") as string;
    if (!templateDocId) {
      return {
        ok: false,
        error: `Template record found but Template Doc ID is empty for docType: ${docType}`,
        status: 500,
      };
    }

    console.log(
      `[generate-doc][${requestId}] Resolved template for docType=${docType} → ${templateDocId}`
    );
    return { ok: true, templateDocId, source: "airtable" };
  } catch (error: any) {
    console.error(
      `[generate-doc][${requestId}] Airtable lookup failed:`,
      error?.message ?? error
    );
    return {
      ok: false,
      error: `Failed to resolve template from Airtable: ${error?.message ?? "Unknown error"}`,
      status: 502,
    };
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
- appendixBlocks: (optional) Array of blocks for supplementary content

Guidelines:
- Headings and structure should fit the content; do not use generic placeholders
- Keep content concise and business-ready
- Use bullets for lists of items, action items, or next steps
- Use tables only when comparing data or presenting structured info
- The highlights label can be "Key Takeaways", "Action Items", "Next Steps", or similar based on content`;

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

  console.log(`[generate-doc][${requestId}] Calling OpenAI for content generation`);

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
      response_format: {
        type: "json_schema",
        json_schema: jsonSchema,
      },
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[generate-doc][${requestId}] OpenAI error: ${response.status}`, errorText);
    // Include error details in thrown error for debugging
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
  const validated = GeneratedContentSchema.parse(parsed);

  console.log(`[generate-doc][${requestId}] OpenAI content generated successfully`);
  return validated;
}

// --- Apps Script Doc Creation ---

async function createDocInDrive(
  content: GeneratedContent,
  projectFolderId: string,
  templateDocId: string,
  requestId: string
): Promise<{ ok: boolean; docId?: string; docUrl?: string; pdfUrl?: string; error?: string }> {
  const appsScriptUrl = process.env.APPS_SCRIPT_DOC_WEBAPP_URL;

  if (!appsScriptUrl) {
    // TODO: Replace with actual Apps Script URL when deployed
    console.warn(`[generate-doc][${requestId}] APPS_SCRIPT_DOC_WEBAPP_URL not configured, returning stub response`);
    return {
      ok: true,
      docId: "STUB_DOC_ID",
      docUrl: "https://docs.google.com/document/d/STUB_DOC_ID/edit",
      pdfUrl: undefined,
    };
  }

  const payload = {
    templateDocId,
    projectFolderId,
    docTitle: content.docTitle,
    subtitle: content.subtitle,
    date: new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
    execSummary: content.execSummary,
    bodyBlocks: content.bodyBlocks,
    highlights: content.highlights,
    appendixBlocks: content.appendixBlocks || [],
  };

  console.log(`[generate-doc][${requestId}] Calling Apps Script to create doc`);

  const response = await fetch(appsScriptUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "follow",
  });

  const responseText = await response.text();

  if (!response.ok) {
    console.error(
      `[generate-doc][${requestId}] Apps Script error: ${response.status}`,
      responseText.slice(0, 500)
    );
    return {
      ok: false,
      error: `Apps Script returned ${response.status}: ${responseText.slice(0, 200)}`,
    };
  }

  try {
    const result = JSON.parse(responseText);
    if (!result.ok) {
      return {
        ok: false,
        error: result.error || "Apps Script returned ok:false",
      };
    }
    console.log(`[generate-doc][${requestId}] Doc created successfully: ${result.docId}`);
    return result;
  } catch {
    return {
      ok: false,
      error: `Failed to parse Apps Script response: ${responseText.slice(0, 200)}`,
    };
  }
}

// --- Main Handler ---

export async function POST(req: Request) {
  // TEMPORARY: Version check - remove after confirming deployment
  if (Date.now() > 0) {
    return new Response(
      JSON.stringify({ ok: false, debug: { version: "generate-doc_vPERM_001" } }),
      { status: 418, headers: { "content-type": "application/json" } }
    );
  }

  const requestId = generateRequestId();

  try {
    // Auth check
    const authCheck = isAuthorized(req);
    if (!authCheck.ok) {
      console.warn(`[generate-doc][${requestId}] Auth failed: ${authCheck.reason}`);
      return NextResponse.json(
        { ok: false, error: authCheck.reason, requestId },
        { status: 401 }
      );
    }

    // Parse body
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch (e) {
      console.error(`[generate-doc][${requestId}] JSON parse error:`, e);
      return NextResponse.json(
        { ok: false, error: "Invalid JSON body", debug: "Could not parse request body as JSON", requestId },
        { status: 400 }
      );
    }

    // Log received fields (safe fields only, no sensitive data)
    const safeLog = {
      docRecordId: body.docRecordId ?? "(missing)",
      projectName: body.projectName ?? "(missing)",
      clientName: body.clientName ?? "(missing)",
      docType: body.docType ?? "(missing)",
      hasProjectFolderId: !!body.projectFolderId,
      hasSourceNotes: !!body.sourceNotes,
    };
    console.log(`[generate-doc][${requestId}] Received request:`, safeLog);

    // Validate input
    const parseResult = InputSchema.safeParse(body);
    if (!parseResult.success) {
      const errors = parseResult.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
      const firstError = parseResult.error.errors[0];
      const missingField = firstError?.path?.[0] || "unknown";
      console.warn(`[generate-doc][${requestId}] Validation failed:`, errors);
      return NextResponse.json(
        {
          ok: false,
          error: `Missing or invalid field: ${missingField}`,
          details: errors,
          received: safeLog,
          debug: "Request validation failed",
          requestId,
        },
        { status: 400 }
      );
    }

    const input = parseResult.data;
    const docRecordId = input.docRecordId; // Already trimmed/normalized by schema
    const receivedProjectFolderId = input.projectFolderId || null;
    console.log(`[generate-doc][${requestId}] Processing request for project: ${input.projectName}`);

    // Idempotency check: if doc already exists, return it
    if (docRecordId) {
      const existingDoc = await checkExistingDoc(docRecordId, requestId);
      if (existingDoc.exists) {
        console.log(`[generate-doc][${requestId}] Returning existing doc (idempotency)`);
        return NextResponse.json({
          ok: true,
          docRecordId,
          docId: existingDoc.docId,
          docUrl: existingDoc.docUrl,
          pdfUrl: existingDoc.pdfUrl,
          projectFolderId: existingDoc.projectFolderId,
          folderCreated: false,
          reusedExisting: true,
          debug: {
            message: "Reused existing doc",
            receivedProjectFolderId,
            usedProjectFolderId: existingDoc.projectFolderId,
            folderCreated: false,
          },
          requestId,
        });
      }
    }

    // Resolve project folder (create if missing)
    let projectFolderId = receivedProjectFolderId || "";
    let folderCreated = false;

    if (!projectFolderId) {
      console.log(`[generate-doc][${requestId}] projectFolderId missing, creating folder automatically`);

      const folderResult = await createProjectFolder(
        input.clientName,
        input.projectName,
        requestId
      );

      if (!folderResult.ok) {
        return NextResponse.json(
          {
            ok: false,
            error: `Failed to create project folder: ${folderResult.error}`,
            debug: {
              message: "Folder creation failed",
              receivedProjectFolderId,
              folderError: folderResult.error,
            },
            requestId,
          },
          { status: 502 }
        );
      }

      projectFolderId = folderResult.folderId;
      folderCreated = true;

      // Best-effort write-back folder ID to Airtable
      if (docRecordId) {
        await writeBackToAirtable(docRecordId, { "Project Folder ID": projectFolderId }, requestId);
      }
    }

    // Generate content via OpenAI
    let content: GeneratedContent;
    try {
      content = await generateStructuredContent(input, requestId);
    } catch (error: any) {
      console.error(`[generate-doc][${requestId}] OpenAI generation failed:`, error);
      return NextResponse.json(
        {
          ok: false,
          error: `Content generation failed: ${error.message}`,
          debug: {
            message: "OpenAI error",
            receivedProjectFolderId,
            usedProjectFolderId: projectFolderId,
            folderCreated,
            openaiError: error.message,
          },
          requestId,
        },
        { status: 500 }
      );
    }

    // Resolve template from Airtable (or fallback)
    const templateResult = await resolveTemplateDocId(input.docType, requestId);
    if (!templateResult.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: templateResult.error,
          debug: {
            message: "Template lookup failed",
            receivedProjectFolderId,
            usedProjectFolderId: projectFolderId,
            folderCreated,
          },
          requestId,
        },
        { status: templateResult.status }
      );
    }
    const templateDocId = templateResult.templateDocId;

    // Create doc in Drive via Apps Script
    const docResult = await createDocInDrive(
      content,
      projectFolderId,
      templateDocId,
      requestId
    );

    if (!docResult.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: docResult.error,
          debug: {
            message: "Apps Script doc creation failed",
            receivedProjectFolderId,
            usedProjectFolderId: projectFolderId,
            folderCreated,
            appsScriptError: docResult.error,
          },
          requestId,
        },
        { status: 502 }
      );
    }

    // Best-effort write-back doc info to Airtable
    if (docRecordId && docResult.docId && docResult.docUrl) {
      const writeBackFields: Record<string, string> = {
        "Doc ID": docResult.docId,
        "Doc URL": docResult.docUrl,
        "Project Folder ID": projectFolderId,
      };
      if (docResult.pdfUrl) {
        writeBackFields["PDF URL"] = docResult.pdfUrl;
      }
      await writeBackToAirtable(docRecordId, writeBackFields, requestId);
    }

    return NextResponse.json({
      ok: true,
      docRecordId: docRecordId || null,
      docId: docResult.docId,
      docUrl: docResult.docUrl,
      pdfUrl: docResult.pdfUrl || "",
      projectFolderId,
      folderCreated,
      reusedExisting: false,
      debug: {
        message: folderCreated ? "Created folder and doc" : "Created doc in existing folder",
        receivedProjectFolderId,
        usedProjectFolderId: projectFolderId,
        folderCreated,
      },
      requestId,
    });
  } catch (error: any) {
    console.error(`[generate-doc][${requestId}] Unexpected error:`, error);
    return NextResponse.json(
      {
        ok: false,
        error: error?.message ?? "Unknown error",
        debug: {
          message: "Unexpected error",
          errorStack: error?.stack?.slice(0, 500),
        },
        requestId,
      },
      { status: 500 }
    );
  }
}

// Reject non-POST requests
export async function GET() {
  return NextResponse.json(
    { ok: false, error: "Method not allowed. Use POST." },
    { status: 405 }
  );
}

export async function PUT() {
  return NextResponse.json(
    { ok: false, error: "Method not allowed. Use POST." },
    { status: 405 }
  );
}

export async function DELETE() {
  return NextResponse.json(
    { ok: false, error: "Method not allowed. Use POST." },
    { status: 405 }
  );
}
