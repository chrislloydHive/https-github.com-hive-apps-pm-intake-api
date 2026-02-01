/**
 * Cross-base project record ID mapping.
 *
 * Two Airtable bases:
 * - Client PM OS: Projects table with "Hive OS Project Record ID" field
 * - HIVE OS: Projects table with "Client PM OS Project Record ID" field
 *
 * Mapping is stored on BOTH records. Input either ID, output both.
 */

import { config, tables } from "./config";

const AIRTABLE_API = "https://api.airtable.com/v0";

// Field names for cross-base mapping (stored on both records)
const CLIENT_PM_OS_FIELD_HIVE_OS_ID = "Hive OS Project Record ID";
const HIVE_OS_FIELD_CLIENT_PM_ID = "Client PM OS Project Record ID";

export interface ProjectIdMapping {
  clientPmProjectRecordId: string;
  hiveOsProjectRecordId: string | null;
}

async function getRecord(
  baseId: string,
  tableName: string,
  recordId: string
): Promise<Record<string, unknown> | null> {
  const apiKey = config.airtableApiKey;
  if (!apiKey) {
    console.warn("[projectMapping] AIRTABLE_API_KEY not configured");
    return null;
  }

  const url = `${AIRTABLE_API}/${baseId}/${encodeURIComponent(tableName)}/${recordId}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    if (res.status === 404) return null;
    const text = await res.text();
    console.warn("[projectMapping] Airtable fetch failed:", res.status, text.slice(0, 200));
    return null;
  }

  const data = (await res.json()) as { id: string; fields: Record<string, unknown> };
  return data?.fields ?? null;
}

/**
 * Resolve both project record IDs from either ID.
 * Input: clientPmProjectRecordId OR hiveOsProjectRecordId
 * Output: both ids; hiveOsProjectRecordId may be null if not linked
 */
export async function resolveProjectIds(input: {
  clientPmProjectRecordId?: string;
  hiveOsProjectRecordId?: string;
}): Promise<ProjectIdMapping | null> {
  const clientPmBase = config.clientPmOsBaseId;
  const hiveOsBase = config.hiveOsBaseId;
  const tableName = tables.projects;

  if (!clientPmBase || !hiveOsBase) {
    console.warn("[projectMapping] Base IDs not configured: clientPmOsBaseId, hiveOsBaseId");
    return null;
  }

  const { clientPmProjectRecordId: inputClientPm, hiveOsProjectRecordId: inputHiveOs } = input;

  // Case 1: We have clientPmProjectRecordId — fetch from Client PM OS, get Hive OS ID
  if (inputClientPm && inputClientPm.trim().startsWith("rec")) {
    const fields = await getRecord(clientPmBase, tableName, inputClientPm.trim());
    if (!fields) return null;

    const hiveOsId = fields[CLIENT_PM_OS_FIELD_HIVE_OS_ID];
    const hiveOsProjectRecordId =
      typeof hiveOsId === "string" && hiveOsId.trim().startsWith("rec") ? hiveOsId.trim() : null;

    return {
      clientPmProjectRecordId: inputClientPm.trim(),
      hiveOsProjectRecordId,
    };
  }

  // Case 2: We have hiveOsProjectRecordId — fetch from HIVE OS, get Client PM OS ID
  if (inputHiveOs && inputHiveOs.trim().startsWith("rec")) {
    const fields = await getRecord(hiveOsBase, tableName, inputHiveOs.trim());
    if (!fields) return null;

    const clientPmId = fields[HIVE_OS_FIELD_CLIENT_PM_ID];
    const clientPmProjectRecordId =
      typeof clientPmId === "string" && clientPmId.trim().startsWith("rec") ? clientPmId.trim() : null;

    if (!clientPmProjectRecordId) {
      console.warn(
        "[projectMapping] HIVE OS record has no Client PM OS Project Record ID — cannot resolve"
      );
      return null;
    }

    return {
      clientPmProjectRecordId,
      hiveOsProjectRecordId: inputHiveOs.trim(),
    };
  }

  return null;
}

/**
 * Verify that a record exists in Client PM OS Projects.
 * Returns true if the record exists.
 */
export async function verifyClientPmProjectExists(
  clientPmProjectRecordId: string
): Promise<boolean> {
  const clientPmBase = config.clientPmOsBaseId;
  const tableName = tables.projects;

  if (!clientPmBase) return false;

  const fields = await getRecord(clientPmBase, tableName, clientPmProjectRecordId);
  return fields !== null;
}
