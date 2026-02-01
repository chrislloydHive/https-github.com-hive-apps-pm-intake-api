/**
 * Project identifier validation and logging.
 *
 * Two Airtable bases:
 * - clientPmProjectRecordId: Projects record ID in Client PM OS base
 * - hiveOsProjectRecordId: Projects record ID in HIVE OS base
 *
 * For Client PM OS automation endpoints: always use clientPmProjectRecordId.
 * Never pass hiveOsProjectRecordId into Client PM OS automations.
 */

/**
 * Validates that a value is a valid Airtable record ID (starts with "rec").
 */
export function validateRecordIdFormat(
  value: unknown
): { ok: true; value: string } | { ok: false; error: string } {
  if (value == null) {
    return { ok: false, error: "Record ID is required" };
  }
  if (typeof value !== "string") {
    return { ok: false, error: "Record ID must be a string" };
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return { ok: false, error: "Record ID cannot be empty" };
  }
  if (!trimmed.startsWith("rec")) {
    return {
      ok: false,
      error: "Record ID must be an Airtable record ID (must start with 'rec')",
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * Validates clientPmProjectRecordId (Client PM OS Projects record ID).
 */
export function validateClientPmProjectRecordId(
  value: unknown
): { ok: true; value: string } | { ok: false; error: string } {
  const result = validateRecordIdFormat(value);
  if (!result.ok) {
    return { ok: false, error: result.error.replace("Record ID", "clientPmProjectRecordId") };
  }
  return result;
}

/**
 * Resolves clientPmProjectRecordId from request body.
 * Accepts: clientPmProjectRecordId (canonical) or recordId (legacy).
 * Rejects hiveOsProjectRecordId when used alone — Client PM OS endpoints require clientPmProjectRecordId.
 */
export function resolveClientPmProjectRecordId(
  body: Record<string, unknown>
): string | null {
  const canonical = body.clientPmProjectRecordId;
  const legacy = body.recordId;
  const hiveOs = body.hiveOsProjectRecordId;

  // If only hiveOsProjectRecordId provided, reject — must not pass HIVE OS ID to Client PM OS
  if (!canonical && !legacy && hiveOs) {
    return null;
  }

  const value = (canonical ?? legacy) as unknown;
  const result = validateClientPmProjectRecordId(value);
  return result.ok ? result.value : null;
}

/**
 * Debug logging — prints both IDs when present. Never logs secrets.
 */
export function logProjectRouteDebug(params: {
  route: string;
  clientPmProjectRecordId: string;
  hiveOsProjectRecordId?: string | null;
  baseId?: string;
  tableName?: string;
}): void {
  const {
    route,
    clientPmProjectRecordId,
    hiveOsProjectRecordId,
    baseId,
    tableName,
  } = params;
  const parts: string[] = [
    `route=${route}`,
    `clientPmProjectRecordId=${clientPmProjectRecordId}`,
  ];
  if (hiveOsProjectRecordId) {
    parts.push(`hiveOsProjectRecordId=${hiveOsProjectRecordId}`);
  }
  if (baseId) parts.push(`baseId=${baseId}`);
  if (tableName) parts.push(`tableName=${tableName}`);
  console.log(`[pm-intake-api] ${parts.join(", ")}`);
}
