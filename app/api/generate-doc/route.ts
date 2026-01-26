import { NextResponse } from "next/server";
import { z } from "zod";
import Airtable from "airtable";
import { google } from "googleapis";

// Build tag for debugging deployed versions
const BUILD_TAG = "generate-doc-2026-01-26-placeholder-fix";

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
 * - GOOGLE_SERVICE_ACCOUNT_EMAIL: Service account email for Google APIs
 * - GOOGLE_PRIVATE_KEY: Service account private key (PEM format)
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
  SOW: "1waa73z1pGRbvgA9hjSAoyi67lkNs46PqoP3YoXZ_pPU",
} as const;

/**
 * Maps docType to template ID.
 * - "Project Brief" -> PROJECT_BRIEF template
 * - "Project Timeline" -> PROJECT_TIMELINE template
 * - "SOW" -> SOW template
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

  if (normalized === "sow") {
    return TEMPLATE_IDS.SOW;
  }

  // Default for: Branded Doc, Analytics Report, Meeting Recap, Strategy Memo, Other, etc.
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

// Placeholder strings that should be treated as empty/null
const PLACEHOLDER_STRINGS = [
  "[NO_SOURCE_TEXT_PROVIDED]",
  "[NO_SOURCE_TEXT]",
  "[NO_CONTENT]",
  "[EMPTY]",
  "[NULL]",
];

/**
 * Checks if a value is a placeholder string that should be treated as empty.
 */
function isPlaceholderValue(val: unknown): boolean {
  if (typeof val !== "string") return false;
  const trimmed = val.trim();
  return PLACEHOLDER_STRINGS.includes(trimmed);
}

/**
 * Normalizes payload keys from uppercase (Airtable) to lowercase (internal schema).
 * CONTENT -> content, PROJECT -> project, etc.
 * Also strips placeholder strings like [NO_SOURCE_TEXT_PROVIDED].
 * Preserves nested objects and arrays.
 */
function normalizeKeysToLowercase(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    // Convert key to lowercase
    const lowerKey = key.toLowerCase();

    // Strip placeholder strings - treat them as empty
    if (isPlaceholderValue(value)) {
      result[lowerKey] = "";
      if (key !== lowerKey) result[key] = "";
      continue;
    }

    // Handle nested objects (but not arrays)
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[lowerKey] = normalizeKeysToLowercase(value as Record<string, unknown>);
    } else {
      result[lowerKey] = value;
    }

    // Also keep original key if different (for backwards compat)
    if (key !== lowerKey) {
      result[key] = value;
    }
  }

  return result;
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
    // Structured input fields
    "docTitleOverride",
    "docSubtitle",
    "docInputOverview",
    "docInputGoals",
    "docInputStrategy",
    "docInputPlan",
    "docInputNextSteps",
    "docInputRawPaste",
    // Direct placeholder fields (from Airtable Automation)
    "project",
    "client",
    "header",
    "shortOverview",
    "content",
    "sourceText",
    "bodyContent",
    "body",
    "text",
    "notes",
    "inlineTable",
    "inlineTableText",
    "templateId",
    "templateDocId",
    "destinationFolderId",
    "generatedAt",
    // Additional merge fields
    "projectNumber",
    "startDate",
    "dueDate",
    "subtitle",
  ];

  for (const field of fieldsToCoerce) {
    if (field in body) {
      coerced[field] = coerceToString(body[field]);
    }
  }

  // Also coerce nested docInputs object if present
  if (body.docInputs && typeof body.docInputs === "object") {
    const nestedInputs = body.docInputs as Record<string, unknown>;
    const coercedInputs: Record<string, unknown> = {};
    const nestedFields = ["overview", "goals", "strategy", "plan", "nextSteps", "rawPaste"];
    for (const field of nestedFields) {
      if (field in nestedInputs) {
        coercedInputs[field] = coerceToString(nestedInputs[field]);
      }
    }
    coerced.docInputs = coercedInputs;
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
  projectName: optionalString, // Now optional for direct placeholder mode
  clientName: optionalString,  // Now optional for direct placeholder mode
  docType: optionalString,     // Now optional for direct placeholder mode
  sourceNotes: optionalString, // Now optional - can be built from structured inputs
  polishNotes: optionalString, // Optional additional instructions for polish
  projectFolderId: optionalString, // IGNORED for placement - always use PREPARED_DOCUMENTS_FOLDER_ID

  // Structured input fields (override title/subtitle, or provide section content)
  docTitleOverride: optionalString,
  docSubtitle: optionalString,
  docInputOverview: optionalString,
  docInputGoals: optionalString,
  docInputStrategy: optionalString,
  docInputPlan: optionalString,
  docInputNextSteps: optionalString,
  docInputRawPaste: optionalString,

  // Direct placeholder fields (from Airtable Automation - bypasses GPT polish)
  project: optionalString,          // Maps to {{PROJECT}}
  client: optionalString,           // Maps to {{CLIENT}}
  header: optionalString,           // Maps to {{HEADER}}
  shortOverview: optionalString,    // Maps to {{SHORT_OVERVIEW}}
  content: optionalString,          // Maps to {{CONTENT}} (direct, no GPT)
  // Content field aliases (keys normalized to lowercase by normalizeKeysToLowercase)
  sourceText: optionalString,       // Alias for content
  bodyContent: optionalString,      // Alias for content
  body: optionalString,             // Alias for content
  text: optionalString,             // Alias for content
  notes: optionalString,            // Alias for content
  inlineTable: optionalString,      // Maps to {{INLINE_TABLE}}
  inlineTableText: optionalString,  // Fallback for {{INLINE_TABLE}}
  templateId: optionalString,       // Override template selection
  templateDocId: optionalString,    // Alias for templateId
  destinationFolderId: optionalString, // Override destination folder
  generatedAt: optionalString,      // Override generated timestamp
  // Additional merge fields
  projectNumber: optionalString,    // Maps to {{PROJECT_NUMBER}}
  startDate: optionalString,        // Maps to {{START_DATE}}
  dueDate: optionalString,          // Maps to {{DUE_DATE}}
  subtitle: optionalString,         // Maps to {{SUBTITLE}}
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

/**
 * Checks if a value is a non-empty string with meaningful content.
 */
function hasMeaningfulText(val: unknown): val is string {
  return typeof val === "string" && val.trim().length > 0;
}

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
// STRUCTURED INPUT BUILDER
// =============================================================================

interface StructuredInputs {
  overview?: string | null;
  goals?: string | null;
  strategy?: string | null;
  plan?: string | null;
  nextSteps?: string | null;
  rawPaste?: string | null;
}

/**
 * Builds a sourceText string from structured input fields.
 * Each non-empty field becomes a section with a markdown header.
 *
 * @returns { text: string, usedFields: string[] }
 */
function buildSourceText(inputs: StructuredInputs): { text: string; usedFields: string[] } {
  const sections: { label: string; key: keyof StructuredInputs; content: string }[] = [];
  const usedFields: string[] = [];

  const fieldMappings: { key: keyof StructuredInputs; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "goals", label: "Goals" },
    { key: "strategy", label: "Strategy" },
    { key: "plan", label: "Plan" },
    { key: "nextSteps", label: "Next Steps" },
    { key: "rawPaste", label: "Additional Notes" },
  ];

  for (const { key, label } of fieldMappings) {
    const val = inputs[key];
    if (hasMeaningfulText(val)) {
      sections.push({ label, key, content: val.trim() });
      usedFields.push(key);
    }
  }

  if (sections.length === 0) {
    return { text: "", usedFields: [] };
  }

  const text = sections.map(({ label, content }) => `## ${label}\n${content}`).join("\n\n");

  return { text, usedFields };
}

/**
 * Extracts structured inputs from body, supporting:
 * - Flat fields: docInputOverview, docInputGoals, etc.
 * - Nested object: body.docInputs.overview, body.docInputs.goals, etc.
 */
function extractStructuredInputs(body: Record<string, unknown>): StructuredInputs {
  // Check both original and normalized (lowercase) key names
  const docInputs = (body.docInputs || body.docinputs || {}) as Record<string, unknown>;

  return {
    overview: coerceToString(body.docInputOverview) ?? coerceToString(docInputs.overview) ?? null,
    goals: coerceToString(body.docInputGoals) ?? coerceToString(docInputs.goals) ?? null,
    strategy: coerceToString(body.docInputStrategy) ?? coerceToString(docInputs.strategy) ?? null,
    plan: coerceToString(body.docInputPlan) ?? coerceToString(docInputs.plan) ?? null,
    nextSteps: coerceToString(body.docInputNextSteps) ?? coerceToString(docInputs.nextSteps) ?? null,
    rawPaste: coerceToString(body.docInputRawPaste) ?? coerceToString(docInputs.rawPaste) ?? null,
  };
}

// =============================================================================
// MERGE MAP EXTRACTION & PLACEHOLDER NORMALIZATION
// =============================================================================

/**
 * Normalizes a placeholder key to uppercase without braces.
 * "{{CONTENT}}" -> "CONTENT"
 * "content" -> "CONTENT"
 * "CONTENT" -> "CONTENT"
 * "  {{PROJECT}}  " -> "PROJECT"
 */
function normalizeKey(key: string): string {
  // Trim first, then remove braces, then trim again and uppercase
  return key.trim().replace(/^\{\{|\}\}$/g, "").trim().toUpperCase();
}

/**
 * Extracts and normalizes all placeholder values from the request body.
 * Handles multiple payload shapes:
 * 1. placeholders: { "{{PROJECT}}": "...", "{{CONTENT}}": "..." }
 * 2. mergeFields: { PROJECT: "...", CONTENT: "..." }
 * 3. fields / replacements / structuredInputs (same format as mergeFields)
 *
 * Returns a normalized map with UPPERCASE keys (no braces):
 * { PROJECT: "...", CONTENT: "...", INLINE_TABLE: "..." }
 */
function normalizeMerge(rawBody: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};

  // 1. Extract from placeholders object (keys like "{{CONTENT}}")
  const placeholders = rawBody.placeholders || rawBody.Placeholders;
  if (placeholders && typeof placeholders === "object") {
    for (const [k, v] of Object.entries(placeholders)) {
      const normalized = normalizeKey(k);
      const s = coerceToString(v);
      if (s !== null && normalized) {
        out[normalized] = s;
      }
    }
  }

  // 2. Extract from mergeFields/fields/replacements/structuredInputs (keys like "CONTENT" or "content")
  const merge =
    rawBody.mergeFields || rawBody.mergefields ||
    rawBody.fields ||
    rawBody.replacements ||
    rawBody.structuredInputs || rawBody.structuredinputs;

  if (merge && typeof merge === "object") {
    for (const [k, v] of Object.entries(merge)) {
      const normalized = normalizeKey(k);
      const s = coerceToString(v);
      // Only set if not already set from placeholders (placeholders take priority)
      if (s !== null && normalized && !(normalized in out)) {
        out[normalized] = s;
      }
    }
  }

  return out;
}

/**
 * Builds a placeholders map with {{KEY}} format from a normalized merge map.
 * Input: { PROJECT: "...", CONTENT: "..." }
 * Output: { "{{PROJECT}}": "...", "{{CONTENT}}": "..." }
 */
function buildPlaceholders(merge: Record<string, string>): Record<string, string> {
  const placeholders: Record<string, string> = {};
  for (const [key, value] of Object.entries(merge)) {
    // Ensure key is uppercase and wrapped in braces
    const normalizedKey = key.toUpperCase();
    placeholders[`{{${normalizedKey}}}`] = value;
  }
  return placeholders;
}

/**
 * Builds Google Docs API batchUpdate replaceAllText requests from placeholders.
 * @param placeholders Map of "{{KEY}}" -> value
 * @returns Array of replaceAllText request objects
 */
function buildReplaceRequests(placeholders: Record<string, string>): Array<{
  replaceAllText: {
    containsText: { text: string; matchCase: boolean };
    replaceText: string;
  };
}> {
  return Object.entries(placeholders).map(([key, value]) => ({
    replaceAllText: {
      containsText: {
        text: key, // Already in {{KEY}} format
        matchCase: true,
      },
      replaceText: value == null ? "" : String(value),
    },
  }));
}

/**
 * Logs placeholder information for debugging (safe, no secrets).
 */
function logPlaceholderInfo(
  merge: Record<string, string>,
  requestId: string
): void {
  const keys = Object.keys(merge);
  const contentLength = merge.CONTENT?.length || 0;
  const inlineTableLength = merge.INLINE_TABLE?.length || 0;

  console.log(`[generate-doc][${requestId}] Placeholder keys being replaced: ${keys.join(", ") || "(none)"}`);
  console.log(`[generate-doc][${requestId}] CONTENT length: ${contentLength}, INLINE_TABLE length: ${inlineTableLength}`);

  if (!merge.CONTENT && !merge.content) {
    console.warn(`[generate-doc][${requestId}] WARNING: No CONTENT placeholder value found in payload`);
  }
}

/**
 * @deprecated Use normalizeMerge() instead
 * Legacy function kept for backwards compatibility during transition.
 */
function extractMergeMap(rawBody: Record<string, any>): Record<string, string> {
  // Delegate to normalizeMerge and convert keys to lowercase for backwards compat
  const normalized = normalizeMerge(rawBody);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(normalized)) {
    // Keep both uppercase and lowercase versions for backwards compat
    out[k] = v;
    out[k.toLowerCase()] = v;
    // Also add with underscores converted (SHORT_OVERVIEW -> short_overview)
    const underscored = k.toLowerCase().replace(/_/g, "_");
    out[underscored] = v;
  }
  return out;
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
// GOOGLE DOCS API - PLACEHOLDER REPLACEMENT
// =============================================================================

/**
 * Gets authenticated Google API clients (Docs + Drive).
 * Uses service account credentials from environment variables.
 */
function getGoogleClients() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!email || !privateKey) {
    return null;
  }

  const auth = new google.auth.JWT({
    email,
    key: privateKey,
    scopes: [
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/drive",
    ],
  });

  return {
    docs: google.docs({ version: "v1", auth }),
    drive: google.drive({ version: "v3", auth }),
  };
}

/**
 * Replaces all placeholders in a Google Doc using the Docs API.
 * Supports {{KEY}} format placeholders.
 *
 * @param documentId - The Google Doc ID
 * @param placeholders - Map of placeholder key ("{{KEY}}") to replacement value
 * @param requestId - For logging
 */
async function replaceDocPlaceholders(
  documentId: string,
  placeholders: Record<string, string>,
  requestId: string
): Promise<{ ok: true; replacedCount: number } | { ok: false; error: string }> {
  const clients = getGoogleClients();

  if (!clients) {
    console.warn(`[generate-doc][${requestId}] Google API credentials not configured - skipping direct replacement`);
    return { ok: true, replacedCount: 0 }; // Not a fatal error - Apps Script may have done it
  }

  // Build batchUpdate requests using the helper function
  const requests = buildReplaceRequests(placeholders);

  if (requests.length === 0) {
    console.log(`[generate-doc][${requestId}] No placeholders to replace`);
    return { ok: true, replacedCount: 0 };
  }

  // Log which placeholders are being replaced (keys only, not values for security)
  const placeholderKeys = Object.keys(placeholders);
  console.log(`[generate-doc][${requestId}] Replacing ${requests.length} placeholders via Docs API: ${placeholderKeys.join(", ")}`);

  // Log content/table lengths for debugging
  const contentLength = placeholders["{{CONTENT}}"]?.length || 0;
  const inlineTableLength = placeholders["{{INLINE_TABLE}}"]?.length || 0;
  if (contentLength > 0 || inlineTableLength > 0) {
    console.log(`[generate-doc][${requestId}] Content lengths - CONTENT: ${contentLength} chars, INLINE_TABLE: ${inlineTableLength} chars`);
  }

  try {
    const response = await clients.docs.documents.batchUpdate({
      documentId,
      requestBody: { requests },
    });

    const repliesCount = response.data.replies?.length || 0;
    console.log(`[generate-doc][${requestId}] Docs API batchUpdate complete: ${repliesCount} replacements processed`);

    return { ok: true, replacedCount: repliesCount };
  } catch (error: any) {
    console.error(`[generate-doc][${requestId}] Docs API batchUpdate failed:`, error?.message);
    return { ok: false, error: `Docs API replacement failed: ${error?.message}` };
  }
}

/**
 * Renames a Google Doc using the Drive API.
 *
 * @param documentId - The Google Doc ID
 * @param newName - The new document name
 * @param requestId - For logging
 */
async function renameDocument(
  documentId: string,
  newName: string,
  requestId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const clients = getGoogleClients();

  if (!clients) {
    return { ok: true }; // Not fatal
  }

  try {
    await clients.drive.files.update({
      fileId: documentId,
      requestBody: { name: newName },
      supportsAllDrives: true,
    });

    console.log(`[generate-doc][${requestId}] Document renamed to: ${newName}`);
    return { ok: true };
  } catch (error: any) {
    console.error(`[generate-doc][${requestId}] Drive API rename failed:`, error?.message);
    return { ok: false, error: `Drive API rename failed: ${error?.message}` };
  }
}

// =============================================================================
// APPS SCRIPT DOC CREATION
// =============================================================================

/**
 * Calls Apps Script to:
 * 1. Copy the template doc to the destination folder
 * 2. Replace placeholders:
 *    {{PROJECT}}, {{CLIENT}}, {{HEADER}}, {{SHORT_OVERVIEW}}, {{CONTENT}}, {{INLINE_TABLE}}, {{GENERATED_AT}}
 *    Legacy: {{TITLE}}, {{SUBTITLE}}
 * 3. Return docId, docUrl, pdfUrl
 */
async function createDocFromTemplate(
  params: {
    templateDocId: string;
    destinationFolderId: string;
    projectFolderId?: string; // For backward compat
    title: string;
    subtitle: string;
    generatedAt: string;
    content: string;
    docName: string; // Name for the new doc file
    // New placeholder params
    project?: string | null;
    client?: string | null;
    header?: string | null;
    shortOverview?: string | null;
    inlineTable?: string | null;
    // Additional placeholder params
    projectNumber?: string | null;
    startDate?: string | null;
    dueDate?: string | null;
  },
  requestId: string
): Promise<{ ok: true; docId: string; docUrl: string; pdfUrl: string } | { ok: false; error: string }> {
  const appsScriptUrl = process.env.APPS_SCRIPT_DOC_WEBAPP_URL;

  if (!appsScriptUrl) {
    return { ok: false, error: "APPS_SCRIPT_DOC_WEBAPP_URL not configured" };
  }

  // Build placeholders with defensive defaults
  const contentValue = params.content || " "; // Single space if empty to avoid replacement issues
  const inlineTableValue = params.inlineTable || ""; // Empty string if not provided

  const placeholders: Record<string, string> = {
    // Primary placeholders (from Airtable Automation)
    "{{PROJECT}}": params.project || params.title || "",
    "{{CLIENT}}": params.client || "",
    "{{HEADER}}": params.header || "",
    "{{SHORT_OVERVIEW}}": params.shortOverview || "",
    "{{CONTENT}}": contentValue,
    "{{INLINE_TABLE}}": inlineTableValue,
    "{{GENERATED_AT}}": params.generatedAt || "",
    // Additional placeholders
    "{{PROJECT_NUMBER}}": params.projectNumber || "",
    "{{START_DATE}}": params.startDate || "",
    "{{DUE_DATE}}": params.dueDate || "",
    // Legacy placeholders (backward compatibility)
    "{{TITLE}}": params.title || "",
    "{{SUBTITLE}}": params.subtitle || "",
  };

  // Debug log: show which placeholder keys have non-empty values
  const populatedKeys = Object.entries(placeholders)
    .filter(([_, v]) => v && v.trim() !== "")
    .map(([k, _]) => k);
  console.log(`[generate-doc][${requestId}] Placeholders present: ${populatedKeys.join(", ")}`);

  const payload = {
    action: "createFromTemplate",
    templateDocId: params.templateDocId,
    destinationFolderId: params.destinationFolderId,
    projectFolderId: params.projectFolderId || params.destinationFolderId, // Backward compat
    docName: params.docName,
    // Send content/inlineTable at top level for Apps Script anchor insertion
    content: params.content || "",
    inlineTable: params.inlineTable || "",
    placeholders,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  };

  console.log(
    `[generate-doc][${requestId}] Calling Apps Script: template=${params.templateDocId}, folder=${params.destinationFolderId}, contentLength=${params.content?.length || 0}`
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

    // ---------------------------------------------------------------------------
    // REPLACE PLACEHOLDERS VIA GOOGLE DOCS API (after Apps Script creates doc)
    // ---------------------------------------------------------------------------
    const replaceResult = await replaceDocPlaceholders(result.docId, placeholders, requestId);
    if (!replaceResult.ok) {
      // Log but don't fail - the doc was created, just placeholders may remain
      console.warn(`[generate-doc][${requestId}] Placeholder replacement warning: ${replaceResult.error}`);
    }

    // Rename document if PROJECT is set
    const projectName = placeholders["{{PROJECT}}"];
    if (projectName && projectName.trim()) {
      const renameResult = await renameDocument(result.docId, params.docName || projectName, requestId);
      if (!renameResult.ok) {
        console.warn(`[generate-doc][${requestId}] Rename warning: ${renameResult.error}`);
      }
    }

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
      { ok: false, status: 401, error: authCheck.reason, build: BUILD_TAG, debug: { stage: "AUTH" } },
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
      { ok: false, status: 400, error: "Invalid JSON body", build: BUILD_TAG, debug: { stage: "PARSE" } },
      { status: 400 }
    );
  }

  // Normalize uppercase keys to lowercase (Airtable sends CONTENT, PROJECT, etc.)
  const normalizedBody = normalizeKeysToLowercase(rawBody);

  // Pull canonical merge map BEFORE coercion/zod, so Airtable automation mergeFields works
  // normalizeMerge handles both placeholders: { "{{CONTENT}}": "..." } and mergeFields: { CONTENT: "..." }
  const mergeNormalized = normalizeMerge(rawBody as Record<string, any>);
  const merge = extractMergeMap(normalizedBody as Record<string, any>); // Legacy for backwards compat

  // Log placeholder info for debugging
  logPlaceholderInfo(mergeNormalized, requestId);

  const body = coerceRequestBody(normalizedBody);
  const parseResult = InputSchema.safeParse(body);

  if (!parseResult.success) {
    const errors = parseResult.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
    return NextResponse.json(
      { ok: false, status: 400, error: `Validation failed: ${errors[0]}`, build: BUILD_TAG, debug: { stage: "VALIDATE", errors } },
      { status: 400 }
    );
  }

  const input = parseResult.data;
  const docRecordId = input.docRecordId;

  console.log(
    `[generate-doc][${requestId}] Request: docType="${input.docType}", client="${input.clientName}", project="${input.projectName}"`
  );

  // ---------------------------------------------------------------------------
  // MODE DETECTION: Direct placeholders vs GPT polish
  // Direct mode: when content field is provided (from Airtable Automation)
  // ---------------------------------------------------------------------------
  // Check both input fields and mergeNormalized (uppercase keys from normalizeMerge)
  const isDirectMode =
    hasMeaningfulText(input.content) ||
    hasMeaningfulText(input.sourceText) ||
    hasMeaningfulText(input.body) ||
    hasMeaningfulText(input.text) ||
    hasMeaningfulText(input.notes) ||
    hasMeaningfulText(mergeNormalized.CONTENT) ||       // From placeholders or mergeFields
    hasMeaningfulText(merge.content) ||                 // Legacy lowercase
    hasMeaningfulText(input.inlineTable) ||
    hasMeaningfulText(mergeNormalized.INLINE_TABLE) ||  // From placeholders or mergeFields
    hasMeaningfulText(input.project) ||
    hasMeaningfulText(mergeNormalized.PROJECT);         // From placeholders or mergeFields

  console.log(`[generate-doc][${requestId}] Mode: ${isDirectMode ? "DIRECT" : "GPT"}`);
  console.log(`[generate-doc][${requestId}] Input fields: content=${!!input.content}, sourceNotes=${!!input.sourceNotes}, project=${!!input.project}, inlineTable=${!!input.inlineTable}`);
  console.log(`[generate-doc][${requestId}] Merge fields (normalized): CONTENT=${!!mergeNormalized.CONTENT}, PROJECT=${!!mergeNormalized.PROJECT}, INLINE_TABLE=${!!mergeNormalized.INLINE_TABLE}`);

  // ---------------------------------------------------------------------------
  // FOLDER RESOLUTION: input.destinationFolderId > PREPARED_DOCUMENTS_FOLDER_ID > projectFolderId
  // ---------------------------------------------------------------------------
  const destinationFolderId =
    input.destinationFolderId?.trim() ||
    process.env.PREPARED_DOCUMENTS_FOLDER_ID?.trim() ||
    input.projectFolderId?.trim() ||
    null;

  if (!destinationFolderId) {
    console.error(`[generate-doc][${requestId}] No destination folder available`);
    return NextResponse.json(
      {
        ok: false,
        status: 500,
        error: "No destination folder. Provide destinationFolderId or set PREPARED_DOCUMENTS_FOLDER_ID env var.",
        build: BUILD_TAG,
        debug: { stage: "FOLDER" },
      },
      { status: 500 }
    );
  }

  const folderSource = input.destinationFolderId?.trim()
    ? "payload"
    : process.env.PREPARED_DOCUMENTS_FOLDER_ID?.trim()
      ? "env"
      : "projectFolderId";
  console.log(`[generate-doc][${requestId}] Destination folder: ${destinationFolderId} (source: ${folderSource})`);

  // Backwards-compat shim: set projectFolderId so legacy helpers pass validation
  (body as Record<string, unknown>).projectFolderId = destinationFolderId;

  // ---------------------------------------------------------------------------
  // TEMPLATE SELECTION: input.templateId > input.templateDocId > docType-based selection
  // ---------------------------------------------------------------------------
  const templateDocId = input.templateId?.trim() || input.templateDocId?.trim() || selectTemplateId(input.docType || "");
  const templateSource = input.templateId ? "templateId" : input.templateDocId ? "templateDocId" : "docType";
  console.log(`[generate-doc][${requestId}] Template: ${templateDocId} (source: ${templateSource})`);

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
  // PREPARE PLACEHOLDER VALUES
  // ---------------------------------------------------------------------------
  let finalTitle: string;
  let finalSubtitle: string;
  let finalContent: string;
  let finalProject: string | null = null;
  let finalClient: string | null = null;
  let finalHeader: string | null = null;
  let finalShortOverview: string | null = null;
  let finalInlineTable: string | null = null;
  let sourceType: string;
  let inputsUsed: string[] = [];

  // Use input.generatedAt if provided, otherwise use generated timestamp
  const finalGeneratedAt = input.generatedAt?.trim() || generatedAt;

  // Resolve inlineTable from either field (used in both modes)
  // Priority: input fields > mergeNormalized (from placeholders/mergeFields) > legacy merge
  finalInlineTable =
    input.inlineTable ||
    input.inlineTableText ||
    mergeNormalized.INLINE_TABLE ||  // From placeholders: {"{{INLINE_TABLE}}": "..."} or mergeFields: {INLINE_TABLE: "..."}
    merge.inline_table ||            // Legacy lowercase
    null;

  if (isDirectMode) {
    // ---------------------------------------------------------------------------
    // DIRECT MODE: Use provided placeholders directly (skip GPT)
    // mergeNormalized has uppercase keys from normalizeMerge()
    // merge has lowercase keys from legacy extractMergeMap()
    // ---------------------------------------------------------------------------

    // PROJECT: Prefer from placeholders/mergeFields (may include job# prefix)
    finalProject =
      mergeNormalized.PROJECT ||     // From placeholders: {"{{PROJECT}}": "..."} or mergeFields: {PROJECT: "..."}
      input.project ||
      merge.project ||               // Legacy lowercase
      input.projectName ||
      null;

    // CLIENT
    finalClient =
      mergeNormalized.CLIENT ||
      input.client ||
      merge.client ||
      input.clientName ||
      null;

    // HEADER
    finalHeader =
      mergeNormalized.HEADER ||
      input.header ||
      merge.header ||
      null;

    // SHORT_OVERVIEW
    finalShortOverview =
      mergeNormalized.SHORT_OVERVIEW ||
      input.shortOverview ||
      merge.short_overview ||
      null;

    // INLINE_TABLE (already set above, but override if direct mode has more specific value)
    if (!finalInlineTable) {
      finalInlineTable =
        mergeNormalized.INLINE_TABLE ||
        input.inlineTable ||
        input.inlineTableText ||
        merge.inline_table ||
        merge.inlinetable ||
        null;
    }

    // CONTENT: prefer placeholders/mergeFields, then input fields, then sourceNotes
    // This is the key fix - we now properly extract CONTENT from placeholders
    finalContent =
      mergeNormalized.CONTENT ||     // From placeholders: {"{{CONTENT}}": "..."} or mergeFields: {CONTENT: "..."}
      input.content ||
      input.sourceText ||
      input.body ||
      input.text ||
      input.notes ||
      merge.content ||               // Legacy lowercase
      input.sourceNotes ||
      " ";

    // Title/subtitle - use PROJECT value (which may include job# prefix) for doc title
    finalTitle =
      finalProject ||
      mergeNormalized.TITLE ||
      merge.title ||
      input.projectName ||
      "Untitled Document";

    finalSubtitle =
      mergeNormalized.SUBTITLE ||
      input.subtitle ||
      merge.subtitle ||
      input.header ||
      "";

    sourceType = "direct";

    // Enhanced logging for direct mode
    console.log(
      `[generate-doc][${requestId}] Direct mode values:`
    );
    console.log(
      `[generate-doc][${requestId}]   PROJECT="${finalProject?.slice(0, 80)}${(finalProject?.length || 0) > 80 ? "..." : ""}"`
    );
    console.log(
      `[generate-doc][${requestId}]   CLIENT="${finalClient}", HEADER="${finalHeader?.slice(0, 50)}..."`
    );
    console.log(
      `[generate-doc][${requestId}]   CONTENT length=${finalContent?.length || 0}, INLINE_TABLE length=${finalInlineTable?.length || 0}`
    );
  } else {
    // ---------------------------------------------------------------------------
    // GPT MODE: Process source text through GPT polish
    // ---------------------------------------------------------------------------
    const structuredInputs = extractStructuredInputs(body);
    const { text: builtSourceText, usedFields } = buildSourceText(structuredInputs);
    inputsUsed = usedFields;

    // Priority: built structured text > sourceNotes
    const finalSourceText = builtSourceText || input.sourceNotes || null;

    if (!finalSourceText) {
      console.error(`[generate-doc][${requestId}] No source content provided`);
      return NextResponse.json(
        {
          ok: false,
          status: 400,
          error: "No source content. Provide sourceNotes, structured inputs, or direct content field.",
          build: BUILD_TAG,
          debug: { stage: "SOURCE_TEXT" },
        },
        { status: 400 }
      );
    }

    sourceType = builtSourceText ? "structured" : "sourceNotes";
    console.log(
      `[generate-doc][${requestId}] Source: type=${sourceType}${inputsUsed.length ? `, fields=[${inputsUsed.join(", ")}]` : ""}`
    );

    // ---------------------------------------------------------------------------
    // GPT POLISH
    // ---------------------------------------------------------------------------
    const polishResult = await gptPolish(
      {
        docType: input.docType || "Document",
        clientName: input.clientName || "Client",
        projectName: input.projectName || "Project",
        generatedAt: finalGeneratedAt,
        sourceNotes: finalSourceText,
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
          build: BUILD_TAG,
          debug: { stage: "GPT_POLISH", raw: polishResult.raw?.slice(0, 300) },
        },
        { status: 500 }
      );
    }

    const polished = polishResult.data;

    // Title priority: docTitleOverride > GPT title > fallback
    const fallbackTitle = `${input.clientName || "Client"} — ${input.docType || "Document"} (${input.projectName || "Project"})`;
    finalTitle = input.docTitleOverride?.trim() || polished.title.trim() || fallbackTitle;

    // Subtitle priority: docSubtitle > GPT subtitle
    finalSubtitle = input.docSubtitle?.trim() || polished.subtitle || "";

    // Content from GPT
    finalContent = polished.content;

    // For backward compat, also set project/client placeholders from legacy fields
    finalProject = input.projectName || null;
    finalClient = input.clientName || null;
  }

  // Doc file name (for Drive) - uses finalTitle which includes job# prefix if PROJECT has it
  const docName = `${finalTitle} — ${new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" })}`;

  // ---------------------------------------------------------------------------
  // CREATE DOC FROM TEMPLATE
  // ---------------------------------------------------------------------------
  const docResult = await createDocFromTemplate(
    {
      templateDocId,
      destinationFolderId,
      projectFolderId: input.projectFolderId || destinationFolderId,
      title: finalTitle,
      subtitle: finalSubtitle,
      generatedAt: finalGeneratedAt,
      content: finalContent,
      docName,
      // Primary placeholders
      project: finalProject,
      client: finalClient,
      header: finalHeader,
      shortOverview: finalShortOverview,
      inlineTable: finalInlineTable,
      // Additional placeholders - use mergeNormalized (uppercase keys) with fallback to legacy
      projectNumber: mergeNormalized.PROJECT_NUMBER || input.projectNumber || merge.project_number || null,
      startDate: mergeNormalized.START_DATE || input.startDate || merge.start_date || null,
      dueDate: mergeNormalized.DUE_DATE || input.dueDate || merge.due_date || null,
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
        build: BUILD_TAG,
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
      sourceType,
      inputsUsed: inputsUsed.length > 0 ? inputsUsed : undefined,
    },
  });
}

// =============================================================================
// REJECT NON-POST
// =============================================================================

export async function GET() {
  return NextResponse.json({ ok: false, error: "Method not allowed. Use POST.", build: BUILD_TAG }, { status: 405 });
}

export async function PUT() {
  return NextResponse.json({ ok: false, error: "Method not allowed. Use POST.", build: BUILD_TAG }, { status: 405 });
}

export async function DELETE() {
  return NextResponse.json({ ok: false, error: "Method not allowed. Use POST.", build: BUILD_TAG }, { status: 405 });
}
