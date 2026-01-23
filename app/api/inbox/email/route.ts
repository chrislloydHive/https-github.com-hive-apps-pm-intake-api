import { NextResponse } from "next/server";
import {
  AirtableOSClient,
  escapeFormulaValue,
  extractDomainFromEmail,
  normalizeDomain,
  generateTraceId,
} from "@/lib/airtable-os";
import type {
  InboxEmailPayload,
  InboxEmailResponse,
  InboxMode,
  CompanyFields,
  OpportunityFields,
  InboxItemFields,
  CompanyResult,
  OpportunityResult,
} from "@/lib/inbox-types";

/**
 * Gmail Inbox Ingestion Pipeline
 *
 * OS-only ingestion endpoint with:
 * - Explicit Company get-or-create (no linked-field auto-create)
 * - Full observability (trace id, logging, raw payload storage)
 * - 3 modes: opportunity, company_only, log_only
 * - Dedupe by gmailMessageId, thread attach by gmailThreadId
 */

// ============================================================================
// Environment Configuration (OS-only)
// ============================================================================

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_OS_BASE_ID = process.env.AIRTABLE_OS_BASE_ID;
const AIRTABLE_OS_TABLE_COMPANIES = process.env.AIRTABLE_OS_TABLE_COMPANIES;
const AIRTABLE_OS_TABLE_OPPORTUNITIES = process.env.AIRTABLE_OS_TABLE_OPPORTUNITIES;
const AIRTABLE_OS_TABLE_INBOX_ITEMS = process.env.AIRTABLE_OS_TABLE_INBOX_ITEMS;
const INBOX_SHARED_SECRET = process.env.INBOX_SHARED_SECRET;

// Validate required env vars at startup
const missingEnvVars: string[] = [];
if (!AIRTABLE_API_KEY) missingEnvVars.push("AIRTABLE_API_KEY");
if (!AIRTABLE_OS_BASE_ID) missingEnvVars.push("AIRTABLE_OS_BASE_ID");
if (!AIRTABLE_OS_TABLE_COMPANIES) missingEnvVars.push("AIRTABLE_OS_TABLE_COMPANIES");
if (!AIRTABLE_OS_TABLE_OPPORTUNITIES) missingEnvVars.push("AIRTABLE_OS_TABLE_OPPORTUNITIES");
if (!AIRTABLE_OS_TABLE_INBOX_ITEMS) missingEnvVars.push("AIRTABLE_OS_TABLE_INBOX_ITEMS");
if (!INBOX_SHARED_SECRET) missingEnvVars.push("INBOX_SHARED_SECRET");

if (missingEnvVars.length > 0) {
  console.error("INBOX_EMAIL_CONFIG_ERROR", { missing: missingEnvVars });
}

const IS_PRODUCTION = process.env.NODE_ENV === "production";

// ============================================================================
// Helpers
// ============================================================================

function getDebugPayload() {
  if (IS_PRODUCTION) return undefined;
  return {
    baseId: AIRTABLE_OS_BASE_ID,
    tables: {
      companies: AIRTABLE_OS_TABLE_COMPANIES,
      opportunities: AIRTABLE_OS_TABLE_OPPORTUNITIES,
      inboxItems: AIRTABLE_OS_TABLE_INBOX_ITEMS,
    },
  };
}

function jsonResponse(data: InboxEmailResponse, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

function errorResponse(
  traceId: string,
  error: string,
  status = 500
): NextResponse {
  return jsonResponse(
    {
      ok: false,
      status: "error",
      traceId,
      error,
      _debug: getDebugPayload(),
    },
    status
  );
}

// ============================================================================
// Core Business Logic
// ============================================================================

/**
 * Get or create a Company by normalized domain.
 * Searches by "Normalized Domain" field first, then "Domain" field.
 * Creates if not found.
 */
async function getOrCreateCompany(
  client: AirtableOSClient,
  traceId: string,
  domain: string,
  fromName?: string
): Promise<CompanyResult> {
  const normalizedDomain = normalizeDomain(domain);

  if (!normalizedDomain) {
    throw new Error("Cannot determine company domain");
  }

  console.log("COMPANY_LOOKUP", { traceId, domain, normalizedDomain });

  // Search by Normalized Domain first
  const escapedDomain = escapeFormulaValue(normalizedDomain);
  let existing = await client.findOneByFormula<CompanyFields>(
    AIRTABLE_OS_TABLE_COMPANIES!,
    `{Normalized Domain}="${escapedDomain}"`,
    traceId
  );

  if (existing) {
    console.log("COMPANY_FOUND_BY_NORMALIZED_DOMAIN", {
      traceId,
      companyId: existing.id,
      normalizedDomain,
    });
    return {
      id: existing.id,
      name: existing.fields["Company Name"] || normalizedDomain,
      domain: normalizedDomain,
      created: false,
    };
  }

  // Fallback: search by Domain field
  existing = await client.findOneByFormula<CompanyFields>(
    AIRTABLE_OS_TABLE_COMPANIES!,
    `{Domain}="${escapedDomain}"`,
    traceId
  );

  if (existing) {
    console.log("COMPANY_FOUND_BY_DOMAIN", {
      traceId,
      companyId: existing.id,
      domain: normalizedDomain,
    });
    return {
      id: existing.id,
      name: existing.fields["Company Name"] || normalizedDomain,
      domain: normalizedDomain,
      created: false,
    };
  }

  // Not found - create new Company
  const companyName = fromName || normalizedDomain;
  const fields: CompanyFields = {
    "Company Name": companyName,
    Domain: normalizedDomain,
    "Normalized Domain": normalizedDomain,
    "Source System": "OS – Gmail Inbox",
  };

  console.log("COMPANY_CREATING", { traceId, fields });

  const created = await client.createRecord<CompanyFields>(
    AIRTABLE_OS_TABLE_COMPANIES!,
    fields,
    traceId
  );

  console.log("COMPANY_CREATED", { traceId, companyId: created.id });

  return {
    id: created.id,
    name: companyName,
    domain: normalizedDomain,
    created: true,
  };
}

/**
 * Check for duplicate by gmailMessageId.
 * Returns the existing Inbox Item if found.
 */
async function findDuplicateInboxItem(
  client: AirtableOSClient,
  traceId: string,
  gmailMessageId: string
): Promise<{ id: string; activityLog?: string } | null> {
  const escaped = escapeFormulaValue(gmailMessageId);
  const existing = await client.findOneByFormula<InboxItemFields>(
    AIRTABLE_OS_TABLE_INBOX_ITEMS!,
    `{Gmail Message ID}="${escaped}"`,
    traceId
  );

  if (existing) {
    console.log("INBOX_ITEM_DUPLICATE_FOUND", {
      traceId,
      existingId: existing.id,
      gmailMessageId,
    });
    return {
      id: existing.id,
      activityLog: existing.fields["Activity Log"] as string | undefined,
    };
  }

  return null;
}

/**
 * Find existing Opportunity by Gmail Thread ID.
 */
async function findOpportunityByThreadId(
  client: AirtableOSClient,
  traceId: string,
  gmailThreadId: string
): Promise<{ id: string; name: string } | null> {
  const escaped = escapeFormulaValue(gmailThreadId);
  const existing = await client.findOneByFormula<OpportunityFields>(
    AIRTABLE_OS_TABLE_OPPORTUNITIES!,
    `{Gmail Thread ID}="${escaped}"`,
    traceId
  );

  if (existing) {
    console.log("OPPORTUNITY_THREAD_MATCH", {
      traceId,
      opportunityId: existing.id,
      gmailThreadId,
    });
    return {
      id: existing.id,
      name: existing.fields["Opportunity Name"] || "Unnamed",
    };
  }

  return null;
}

/**
 * Create an Inbox Item record.
 */
async function createInboxItem(
  client: AirtableOSClient,
  traceId: string,
  payload: InboxEmailPayload,
  domain: string,
  companyId: string,
  disposition: string,
  opportunityId?: string
): Promise<string> {
  const fields: Record<string, unknown> = {
    "Trace ID": traceId,
    "Gmail Message ID": payload.gmailMessageId,
    "Gmail Thread ID": payload.gmailThreadId,
    Subject: payload.subject || "(no subject)",
    "From Email": payload.from.email,
    Domain: domain,
    Disposition: disposition,
    Company: [companyId],
  };

  if (payload.gmailUrl) fields["Gmail URL"] = payload.gmailUrl;
  if (payload.snippet) fields["Snippet"] = payload.snippet;
  if (payload.bodyText) fields["Body Text"] = payload.bodyText.slice(0, 10000); // Limit size
  if (payload.from.name) fields["From Name"] = payload.from.name;
  if (payload.receivedAt) fields["Received At"] = payload.receivedAt;
  if (opportunityId) fields["Opportunity"] = [opportunityId];

  // Store raw payload for debugging
  fields["Raw Payload"] = JSON.stringify(payload).slice(0, 50000);

  // Initialize activity log
  fields["Activity Log"] = `[${new Date().toISOString()}] Created via inbox ingestion (${traceId})`;

  console.log("INBOX_ITEM_CREATING", { traceId, disposition, companyId, opportunityId });

  const created = await client.createRecord<InboxItemFields>(
    AIRTABLE_OS_TABLE_INBOX_ITEMS!,
    fields,
    traceId
  );

  console.log("INBOX_ITEM_CREATED", { traceId, inboxItemId: created.id });

  return created.id;
}

/**
 * Append to activity log on duplicate.
 */
async function appendActivityLog(
  client: AirtableOSClient,
  traceId: string,
  inboxItemId: string,
  existingLog: string | undefined
): Promise<void> {
  const timestamp = new Date().toISOString();
  const newEntry = `[${timestamp}] Duplicate ingestion attempt (${traceId})`;
  const updatedLog = existingLog ? `${existingLog}\n${newEntry}` : newEntry;

  await client.updateRecord(
    AIRTABLE_OS_TABLE_INBOX_ITEMS!,
    inboxItemId,
    { "Activity Log": updatedLog },
    traceId
  );

  console.log("INBOX_ITEM_ACTIVITY_APPENDED", { traceId, inboxItemId });
}

/**
 * Create a new Opportunity.
 */
async function createOpportunity(
  client: AirtableOSClient,
  traceId: string,
  subject: string,
  companyId: string,
  companyName: string,
  gmailThreadId: string
): Promise<OpportunityResult> {
  const opportunityName = subject || `${companyName} — New Opportunity`;

  const fields: OpportunityFields = {
    "Opportunity Name": opportunityName,
    Company: [companyId],
    Stage: "Qualification",
    "Source System": "OS – Gmail Inbox",
    "Gmail Thread ID": gmailThreadId,
  };

  console.log("OPPORTUNITY_CREATING", { traceId, fields });

  const created = await client.createRecord<OpportunityFields>(
    AIRTABLE_OS_TABLE_OPPORTUNITIES!,
    fields,
    traceId
  );

  console.log("OPPORTUNITY_CREATED", { traceId, opportunityId: created.id });

  return {
    id: created.id,
    name: opportunityName,
    attached: false,
  };
}

// ============================================================================
// Main Handler
// ============================================================================

export async function POST(req: Request): Promise<NextResponse> {
  const traceId = generateTraceId("inb");

  console.log("INBOX_EMAIL_START", { traceId });

  try {
    // Check env vars
    if (missingEnvVars.length > 0) {
      return errorResponse(
        traceId,
        `Missing env vars: ${missingEnvVars.join(", ")}`,
        500
      );
    }

    // Auth check
    const providedSecret = req.headers.get("x-inbox-secret");
    if (!providedSecret || providedSecret !== INBOX_SHARED_SECRET) {
      console.warn("INBOX_EMAIL_UNAUTHORIZED", { traceId });
      return errorResponse(traceId, "Unauthorized", 401);
    }

    // Parse body
    let payload: InboxEmailPayload;
    try {
      payload = await req.json();
    } catch {
      return errorResponse(traceId, "Invalid JSON body", 400);
    }

    // Validate required fields
    if (!payload.gmailMessageId) {
      return errorResponse(traceId, "Missing gmailMessageId", 400);
    }
    if (!payload.gmailThreadId) {
      return errorResponse(traceId, "Missing gmailThreadId", 400);
    }
    if (!payload.from?.email) {
      return errorResponse(traceId, "Missing from.email", 400);
    }
    if (!payload.subject) {
      return errorResponse(traceId, "Missing subject", 400);
    }

    // Extract and normalize domain
    const domain = extractDomainFromEmail(payload.from.email);
    if (!domain) {
      return errorResponse(traceId, "Cannot extract domain from sender email", 400);
    }
    const normalizedDomain = normalizeDomain(domain);

    const mode: InboxMode = payload.mode || "opportunity";

    console.log("INBOX_EMAIL_PARSED", {
      traceId,
      mode,
      gmailMessageId: payload.gmailMessageId,
      gmailThreadId: payload.gmailThreadId,
      fromEmail: payload.from.email,
      domain: normalizedDomain,
      subject: payload.subject?.slice(0, 100),
    });

    // Initialize Airtable client
    const client = new AirtableOSClient(AIRTABLE_API_KEY!, AIRTABLE_OS_BASE_ID!);

    // Step 1: Get or create Company
    const company = await getOrCreateCompany(
      client,
      traceId,
      normalizedDomain,
      payload.from.name
    );

    // Step 2: Check for duplicate by gmailMessageId
    const duplicate = await findDuplicateInboxItem(
      client,
      traceId,
      payload.gmailMessageId
    );

    if (duplicate) {
      // Append activity log to existing item
      await appendActivityLog(client, traceId, duplicate.id, duplicate.activityLog);

      console.log("INBOX_EMAIL_DUPLICATE", { traceId, existingId: duplicate.id });

      return jsonResponse({
        ok: true,
        status: "duplicate",
        traceId,
        company: {
          id: company.id,
          name: company.name,
          domain: company.domain,
          created: company.created,
        },
        inboxItem: { id: duplicate.id },
        _debug: getDebugPayload(),
      });
    }

    // Step 3: Handle based on mode
    let opportunityResult: OpportunityResult | undefined;
    let disposition: string;
    let finalStatus: InboxEmailResponse["status"];

    if (mode === "log_only") {
      // Log-only mode: just create inbox item
      disposition = "Logged";
      finalStatus = "logged";
    } else if (mode === "company_only") {
      // Company-only mode: no opportunity
      disposition = company.created ? "Company Created" : "Company Exists";
      finalStatus = "company_only";
    } else {
      // Opportunity mode (default): find or create opportunity
      const existingOpp = await findOpportunityByThreadId(
        client,
        traceId,
        payload.gmailThreadId
      );

      if (existingOpp) {
        // Attach to existing opportunity
        opportunityResult = {
          id: existingOpp.id,
          name: existingOpp.name,
          attached: true,
        };
        disposition = "Attached";
        finalStatus = "attached";
      } else {
        // Create new opportunity
        opportunityResult = await createOpportunity(
          client,
          traceId,
          payload.subject,
          company.id,
          company.name,
          payload.gmailThreadId
        );
        disposition = "Opportunity Created";
        finalStatus = "opportunity_created";
      }
    }

    // Step 4: Create Inbox Item
    const inboxItemId = await createInboxItem(
      client,
      traceId,
      payload,
      normalizedDomain,
      company.id,
      disposition,
      opportunityResult?.id
    );

    console.log("INBOX_EMAIL_COMPLETE", {
      traceId,
      status: finalStatus,
      companyId: company.id,
      companyCreated: company.created,
      opportunityId: opportunityResult?.id,
      inboxItemId,
    });

    return jsonResponse({
      ok: true,
      status: finalStatus,
      traceId,
      company: {
        id: company.id,
        name: company.name,
        domain: company.domain,
        created: company.created,
      },
      opportunity: opportunityResult
        ? {
            id: opportunityResult.id,
            name: opportunityResult.name,
            attached: opportunityResult.attached,
          }
        : undefined,
      inboxItem: { id: inboxItemId },
      _debug: getDebugPayload(),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("INBOX_EMAIL_ERROR", { traceId, error: message });

    return errorResponse(traceId, message, 500);
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    ok: true,
    route: "inbox/email",
    version: "1.0.0",
    modes: ["opportunity", "company_only", "log_only"],
    _debug: getDebugPayload(),
  });
}
