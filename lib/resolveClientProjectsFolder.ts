/**
 * Resolve the client's Google Drive "Projects" folder (parent for new project folders).
 *
 * Source of truth: Companies."Drive Folder ID" in Client PM OS (appQLwoVH8JyGSTIo).
 * Never match by client name under a shared clients root — that causes prefix collisions
 * (e.g. "Car Toys Oregon" nested under "Car Toys").
 */

import { config, tables } from "./config";

const AIRTABLE_API = "https://api.airtable.com/v0";

/** Client PM OS Companies table */
export const COMPANIES_TABLE =
  process.env.AIRTABLE_COMPANIES_TABLE_NAME?.trim() || "Companies";

export const COMPANY_NAME_FIELD =
  process.env.AIRTABLE_COMPANY_NAME_FIELD?.trim() || "Company Name";

export const COMPANY_DRIVE_FOLDER_ID_FIELD =
  process.env.AIRTABLE_COMPANY_DRIVE_FOLDER_ID_FIELD?.trim() || "Drive Folder ID";

/** Projects → linked client (Companies) */
export const PROJECTS_CLIENT_LINK_FIELD =
  process.env.AIRTABLE_PROJECTS_CLIENT_LINK_FIELD?.trim() || "Client";

export type ResolveClientProjectsFolderInput = {
  /** Explicit destination Projects folder id (from automation lookup field). */
  clientFolderId?: string | null;
  clientPmProjectRecordId: string;
  /** Used only for exact Companies name match when Project link is missing. */
  clientName?: string | null;
};

export type ResolveClientProjectsFolderResult =
  | {
      ok: true;
      folderId: string;
      source:
        | "clientFolderId"
        | "project-client-link"
        | "exact-company-name";
      companyRecordId?: string;
    }
  | { ok: false; error: string };

function airtableHeaders(): Record<string, string> {
  const apiKey = config.airtableApiKey;
  if (!apiKey) {
    throw new Error("AIRTABLE_API_KEY is not configured");
  }
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function escapeFormulaString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function fetchRecord(
  baseId: string,
  tableName: string,
  recordId: string,
): Promise<{ id: string; fields: Record<string, unknown> } | null> {
  const url = `${AIRTABLE_API}/${baseId}/${encodeURIComponent(tableName)}/${recordId}`;
  const res = await fetch(url, { headers: airtableHeaders(), cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Airtable ${res.status} fetching ${tableName}/${recordId}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as { id: string; fields: Record<string, unknown> };
}

async function findCompanyByExactName(
  baseId: string,
  clientName: string,
): Promise<{ id: string; fields: Record<string, unknown> } | null> {
  const escaped = escapeFormulaString(clientName.trim());
  const formula = `{${COMPANY_NAME_FIELD}} = '${escaped}'`;
  const params = new URLSearchParams({
    filterByFormula: formula,
    maxRecords: "2",
  });
  params.append("fields[]", COMPANY_DRIVE_FOLDER_ID_FIELD);
  params.append("fields[]", COMPANY_NAME_FIELD);

  const url = `${AIRTABLE_API}/${baseId}/${encodeURIComponent(COMPANIES_TABLE)}?${params}`;
  const res = await fetch(url, { headers: airtableHeaders(), cache: "no-store" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Airtable ${res.status} listing Companies: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    records: Array<{ id: string; fields: Record<string, unknown> }>;
  };
  const records = data.records ?? [];
  if (records.length === 0) return null;
  if (records.length > 1) {
    console.warn(
      `[resolveClientProjectsFolder] Multiple Companies rows match exact name "${clientName}"; using first`,
    );
  }
  return records[0];
}

function readDriveFolderId(fields: Record<string, unknown>): string | null {
  const v = fields[COMPANY_DRIVE_FOLDER_ID_FIELD];
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

function readClientLinkId(fields: Record<string, unknown>): string | null {
  const v = fields[PROJECTS_CLIENT_LINK_FIELD];
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string" && v[0].startsWith("rec")) {
    return v[0].trim();
  }
  if (typeof v === "string" && v.startsWith("rec")) {
    return v.trim();
  }
  return null;
}

/**
 * Resolve the client's Projects folder id for create-project-folder.
 */
export async function resolveClientProjectsFolder(
  input: ResolveClientProjectsFolderInput,
): Promise<ResolveClientProjectsFolderResult> {
  const explicit = input.clientFolderId?.trim();
  if (explicit) {
    return { ok: true, folderId: explicit, source: "clientFolderId" };
  }

  const baseId = config.clientPmOsBaseId;
  if (!baseId) {
    return {
      ok: false,
      error:
        "CLIENT_PM_OS_BASE_ID (or AIRTABLE_BASE_ID) is not configured — cannot resolve client Projects folder.",
    };
  }

  const projectsTable = tables.projects;

  // 1) Projects record → Client link → Companies.Drive Folder ID
  const project = await fetchRecord(baseId, projectsTable, input.clientPmProjectRecordId);
  if (!project) {
    return {
      ok: false,
      error: `Projects record ${input.clientPmProjectRecordId} not found in Client PM OS.`,
    };
  }

  const clientRecordId = readClientLinkId(project.fields);
  if (clientRecordId) {
    const company = await fetchRecord(baseId, COMPANIES_TABLE, clientRecordId);
    if (!company) {
      return {
        ok: false,
        error: `Linked Companies record ${clientRecordId} not found for project ${input.clientPmProjectRecordId}.`,
      };
    }
    const folderId = readDriveFolderId(company.fields);
    if (folderId) {
      return {
        ok: true,
        folderId,
        source: "project-client-link",
        companyRecordId: company.id,
      };
    }
  }

  // 2) Exact Company Name match (no contains / prefix)
  const name = input.clientName?.trim();
  if (name) {
    const company = await findCompanyByExactName(baseId, name);
    if (company) {
      const folderId = readDriveFolderId(company.fields);
      if (folderId) {
        return {
          ok: true,
          folderId,
          source: "exact-company-name",
          companyRecordId: company.id,
        };
      }
      return {
        ok: false,
        error:
          `Companies record for "${name}" has no ${COMPANY_DRIVE_FOLDER_ID_FIELD}. ` +
          "Set it to the client's Google Drive Projects folder id before creating project folders.",
      };
    }
    return {
      ok: false,
      error:
        `No Companies record with exact ${COMPANY_NAME_FIELD} "${name}". ` +
        "Link the Project to a Client or fix the client name.",
    };
  }

  if (!clientRecordId) {
    return {
      ok: false,
      error:
        `Project ${input.clientPmProjectRecordId} has no ${PROJECTS_CLIENT_LINK_FIELD} link and no clientName was provided. ` +
        "Link a Client on the Project or pass clientName for an exact Companies lookup.",
    };
  }

  return {
    ok: false,
    error:
      `Linked client has no ${COMPANY_DRIVE_FOLDER_ID_FIELD} on Companies. ` +
      "Set Drive Folder ID to the client's Projects folder (not the agency client root). " +
      "Do not rely on name-based folder search under a shared clients root.",
  };
}
