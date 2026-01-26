/**
 * Placeholder normalization and building utilities for Google Docs generation.
 *
 * These functions handle the various payload shapes that Airtable may send:
 * - placeholders: { "{{PROJECT}}": "...", "{{CONTENT}}": "..." }
 * - mergeFields: { PROJECT: "...", CONTENT: "..." }
 * - fields / replacements / structuredInputs (same format as mergeFields)
 */

// =============================================================================
// VALUE COERCION
// =============================================================================

/**
 * Coerces various Airtable value types to a string or null.
 * Handles: strings, arrays, objects with .name or .value, numbers
 */
export function coerceToString(val: unknown): string | null {
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

// =============================================================================
// KEY NORMALIZATION
// =============================================================================

/**
 * Normalizes a placeholder key to uppercase without braces.
 * "{{CONTENT}}" -> "CONTENT"
 * "content" -> "CONTENT"
 * "CONTENT" -> "CONTENT"
 * "  {{PROJECT}}  " -> "PROJECT"
 */
export function normalizeKey(key: string): string {
  // Trim first, then remove braces, then trim again and uppercase
  return key.trim().replace(/^\{\{|\}\}$/g, "").trim().toUpperCase();
}

// =============================================================================
// MERGE MAP EXTRACTION
// =============================================================================

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
export function normalizeMerge(rawBody: Record<string, any>): Record<string, string> {
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

// =============================================================================
// PLACEHOLDER BUILDING
// =============================================================================

/**
 * Builds a placeholders map with {{KEY}} format from a normalized merge map.
 * Input: { PROJECT: "...", CONTENT: "..." }
 * Output: { "{{PROJECT}}": "...", "{{CONTENT}}": "..." }
 */
export function buildPlaceholders(merge: Record<string, string>): Record<string, string> {
  const placeholders: Record<string, string> = {};
  for (const [key, value] of Object.entries(merge)) {
    // Ensure key is uppercase and wrapped in braces
    const normalizedKey = key.toUpperCase();
    placeholders[`{{${normalizedKey}}}`] = value;
  }
  return placeholders;
}

// =============================================================================
// GOOGLE DOCS API REQUEST BUILDING
// =============================================================================

/**
 * Builds Google Docs API batchUpdate replaceAllText requests from placeholders.
 * @param placeholders Map of "{{KEY}}" -> value
 * @returns Array of replaceAllText request objects
 */
export function buildReplaceRequests(placeholders: Record<string, string>): Array<{
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

// =============================================================================
// LOGGING UTILITIES
// =============================================================================

/**
 * Logs placeholder information for debugging (safe, no secrets).
 */
export function logPlaceholderInfo(
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
