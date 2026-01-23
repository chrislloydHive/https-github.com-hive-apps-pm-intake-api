import { NextResponse } from "next/server";

/**
 * Gmail Inbound API - Creates Opportunities and Companies in Client PM OS Airtable
 *
 * IMPORTANT: This route writes ONLY to Client PM OS, never to the Hive Database.
 * Requires AIRTABLE_INBOUND_* env vars - no fallback to DB vars.
 *
 * Company linking uses explicit record IDs - does NOT rely on linked-field auto-create.
 */

// Client PM OS env vars - NO DB FALLBACKS
const INBOUND_BASE_ID = process.env.AIRTABLE_INBOUND_BASE_ID;
const INBOUND_OPP_TABLE = process.env.AIRTABLE_INBOUND_TABLE_OPPORTUNITIES;
const INBOUND_COMPANY_TABLE = process.env.AIRTABLE_INBOUND_TABLE_COMPANIES;

if (!INBOUND_BASE_ID || !INBOUND_OPP_TABLE || !INBOUND_COMPANY_TABLE) {
  throw new Error("Gmail inbound misconfigured: AIRTABLE_INBOUND_* env vars missing");
}

const AIRTABLE_API = "https://api.airtable.com/v0";

// Field name for inbound marker (for tracing)
const INBOUND_MARKER_FIELD = "Inbound Marker";

function getDebugPayload() {
  return {
    base: INBOUND_BASE_ID,
    oppTable: INBOUND_OPP_TABLE,
    companyTable: INBOUND_COMPANY_TABLE,
    viewUrl: process.env.AIRTABLE_INBOUND_OPP_VIEW_URL || "",
  };
}

// Extract baseId from Airtable URL for logging
function extractBaseId(url: string): string {
  const match = url.match(/airtable\.com\/v0\/([^/]+)/);
  return match ? match[1] : "unknown";
}

// Traced fetch wrapper - logs all Airtable requests
async function tracedFetch(
  marker: string,
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const method = options.method || "GET";
  const baseId = extractBaseId(url);

  console.log("AIRTABLE_REQUEST", {
    marker,
    method,
    url,
    baseId,
    expectedBaseId: INBOUND_BASE_ID,
    match: baseId === INBOUND_BASE_ID,
  });

  const response = await fetch(url, options);

  console.log("AIRTABLE_RESPONSE", {
    marker,
    method,
    baseId,
    status: response.status,
    ok: response.ok,
  });

  return response;
}

/**
 * Normalize domain: lowercase, trim, remove protocol/paths, keep only hostname
 * Examples:
 *   "https://Example.COM/path" -> "example.com"
 *   "WWW.Example.com" -> "example.com"
 *   "example.com" -> "example.com"
 */
function normalizeDomain(input: string): string {
  if (!input) return "";

  let domain = input.trim().toLowerCase();

  // Remove protocol if present
  domain = domain.replace(/^https?:\/\//, "");

  // Remove path and query string
  domain = domain.split("/")[0].split("?")[0];

  // Remove www. prefix
  domain = domain.replace(/^www\./, "");

  return domain;
}

/**
 * Extract domain from email address
 * Examples:
 *   "user@example.com" -> "example.com"
 *   "User Name <user@example.com>" -> "example.com"
 */
function extractDomainFromEmail(email: string): string | null {
  if (!email) return null;

  // Handle "Name <email>" format
  const angleMatch = email.match(/<([^>]+)>/);
  const emailAddr = angleMatch ? angleMatch[1] : email;

  // Extract domain from email
  const atIndex = emailAddr.lastIndexOf("@");
  if (atIndex === -1) return null;

  const domain = emailAddr.slice(atIndex + 1).trim();
  return normalizeDomain(domain);
}

/**
 * Get or create a Company by domain.
 * Search priority:
 *   1. normalizedDomain_text == normalized domain
 *   2. domain field == domain
 * If not found, creates a new Company with Name, domain, and normalizedDomain_text.
 * Returns the Company record ID.
 */
async function getOrCreateCompany(
  marker: string,
  headers: Record<string, string>,
  opts: {
    domain: string;
    companyName?: string;
  }
): Promise<{ recordId: string; created: boolean; matchedBy?: string }> {
  const normalizedDomain = normalizeDomain(opts.domain);

  if (!normalizedDomain) {
    throw new Error("Cannot create company: no valid domain provided");
  }

  console.log("COMPANY_LOOKUP", { marker, domain: opts.domain, normalizedDomain });

  // Search by normalizedDomain_text first
  const searchByNormalizedUrl = `${AIRTABLE_API}/${INBOUND_BASE_ID}/${INBOUND_COMPANY_TABLE}?filterByFormula=${encodeURIComponent(
    `{normalizedDomain_text}="${normalizedDomain.replace(/"/g, '\\"')}"`
  )}&maxRecords=1`;

  const searchRes1 = await tracedFetch(marker, searchByNormalizedUrl, { headers });
  const searchData1 = await searchRes1.json();

  if (searchData1.records?.length > 0) {
    const recordId = searchData1.records[0].id;
    console.log("COMPANY_FOUND_BY_NORMALIZED_DOMAIN", { marker, recordId, normalizedDomain });
    return { recordId, created: false, matchedBy: "normalizedDomain_text" };
  }

  // Search by domain field
  const searchByDomainUrl = `${AIRTABLE_API}/${INBOUND_BASE_ID}/${INBOUND_COMPANY_TABLE}?filterByFormula=${encodeURIComponent(
    `{domain}="${normalizedDomain.replace(/"/g, '\\"')}"`
  )}&maxRecords=1`;

  const searchRes2 = await tracedFetch(marker, searchByDomainUrl, { headers });
  const searchData2 = await searchRes2.json();

  if (searchData2.records?.length > 0) {
    const recordId = searchData2.records[0].id;
    console.log("COMPANY_FOUND_BY_DOMAIN", { marker, recordId, normalizedDomain });
    return { recordId, created: false, matchedBy: "domain" };
  }

  // Not found - create new Company
  const companyFields: Record<string, any> = {
    Name: opts.companyName || normalizedDomain,
    domain: normalizedDomain,
    normalizedDomain_text: normalizedDomain,
  };

  console.log("COMPANY_CREATING", { marker, fields: companyFields });

  const createUrl = `${AIRTABLE_API}/${INBOUND_BASE_ID}/${INBOUND_COMPANY_TABLE}`;
  const createRes = await tracedFetch(marker, createUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ fields: companyFields }),
  });

  const createData = await createRes.json();

  if (createData.error) {
    console.error("COMPANY_CREATE_ERROR", { marker, error: createData.error });
    throw new Error(`Failed to create company: ${createData.error.message || JSON.stringify(createData.error)}`);
  }

  const recordId = createData.id;
  console.log("COMPANY_CREATED", { marker, recordId, normalizedDomain });

  return { recordId, created: true };
}

export async function POST(req: Request) {
  // Unique marker for this request (for tracing through logs)
  const marker = `gmail_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  console.log("GMAIL_INBOUND_MARKER", marker);
  console.log("GMAIL INBOUND → OS (APP ROUTER)", {
    marker,
    base: INBOUND_BASE_ID,
    oppTable: INBOUND_OPP_TABLE,
    companyTable: INBOUND_COMPANY_TABLE,
  });

  try {
    // Auth
    const authHeader = req.headers.get("authorization");
    const expectedToken = process.env.PM_INTAKE_TOKEN || process.env.PM_INTAKE_BEARER_TOKEN;

    if (!expectedToken || !authHeader || authHeader !== `Bearer ${expectedToken}`) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized", _debug: getDebugPayload() },
        { status: 401 }
      );
    }

    // Parse body
    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "Invalid JSON", _debug: getDebugPayload() },
        { status: 400 }
      );
    }

    const {
      companyName,
      opportunityName,
      opportunityStage,
      contactEmail,
      contactName,
      source,
      notes,
      domain, // Optional: explicit domain override
    } = body;

    // Extract domain from contactEmail or use provided domain
    const extractedDomain = domain || extractDomainFromEmail(contactEmail);

    if (!extractedDomain) {
      return NextResponse.json(
        {
          ok: false,
          error: "Missing or invalid sender email. Cannot determine company domain.",
          hint: "Provide contactEmail (sender email) or domain field",
          _debug: getDebugPayload(),
        },
        { status: 400 }
      );
    }

    console.log("GMAIL_INBOUND_PARSED", {
      marker,
      companyName,
      contactEmail,
      extractedDomain,
      opportunityName,
    });

    const apiKey = process.env.AIRTABLE_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing AIRTABLE_API_KEY", _debug: getDebugPayload() },
        { status: 500 }
      );
    }

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    // 1. Get or create Company by domain (explicit record ID, no auto-create)
    const companyResult = await getOrCreateCompany(marker, headers, {
      domain: extractedDomain,
      companyName: companyName || undefined,
    });

    const companyRecordId = companyResult.recordId;

    // 2. Create Opportunity in Client PM OS
    let opportunityRecordId: string | null = null;
    let opportunityUrl: string | undefined;

    if (opportunityName) {
      const opportunityFields: Record<string, any> = {
        Name: opportunityName,
      };

      if (opportunityStage) opportunityFields["Stage"] = opportunityStage;

      // Link Company using record ID array (NOT name string)
      // Note: Company field must be linked to the same table as INBOUND_COMPANY_TABLE
      if (companyRecordId) {
        opportunityFields["Company"] = [companyRecordId];
        console.log("OPPORTUNITY_COMPANY_LINK", {
          marker,
          companyRecordId,
          companyTable: INBOUND_COMPANY_TABLE,
          linkValue: [companyRecordId],
        });
      }

      if (contactEmail) opportunityFields["Contact Email"] = contactEmail;
      if (contactName) opportunityFields["Contact Name"] = contactName;
      if (source) opportunityFields["Source"] = source;
      if (notes) opportunityFields["Notes"] = notes;

      // Add inbound marker for tracing
      opportunityFields[INBOUND_MARKER_FIELD] = marker;

      const createOppUrl = `${AIRTABLE_API}/${INBOUND_BASE_ID}/${INBOUND_OPP_TABLE}`;

      console.log("OPPORTUNITY_CREATE_PAYLOAD", { marker, fields: opportunityFields });

      let createOppRes = await tracedFetch(marker, createOppUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ fields: opportunityFields }),
      });
      let createOppData = await createOppRes.json();

      // If Company link failed, retry without it
      if (createOppData.error && createOppData.error.message?.includes("Company")) {
        console.warn("OPPORTUNITY_COMPANY_LINK_FAILED", {
          marker,
          error: createOppData.error,
          companyRecordId,
          hint: "Check that Opportunities.Company is linked to the correct Companies table",
        });

        // Remove Company and retry
        delete opportunityFields["Company"];
        createOppRes = await tracedFetch(marker, createOppUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({ fields: opportunityFields }),
        });
        createOppData = await createOppRes.json();
      }

      if (createOppData.error) {
        console.error("OPPORTUNITY_CREATE_ERROR", { marker, error: createOppData.error });
        throw new Error(`Failed to create opportunity: ${createOppData.error.message || JSON.stringify(createOppData.error)}`);
      }

      opportunityRecordId = createOppData.id;
      console.log("OPPORTUNITY_CREATED", { marker, opportunityRecordId, companyRecordId });

      const viewUrl = process.env.AIRTABLE_INBOUND_OPP_VIEW_URL;
      if (viewUrl && opportunityRecordId) {
        opportunityUrl = `${viewUrl}/${opportunityRecordId}`;
      }
    }

    console.log("GMAIL_INBOUND_COMPLETE", { marker, opportunityRecordId, companyRecordId });

    return NextResponse.json({
      status: "success",
      marker,
      opportunity: opportunityRecordId
        ? {
            id: opportunityRecordId,
            name: opportunityName,
            stage: opportunityStage,
            url: opportunityUrl,
          }
        : null,
      company: {
        id: companyRecordId,
        name: companyName || extractedDomain,
        domain: extractedDomain,
        created: companyResult.created,
        matchedBy: companyResult.matchedBy,
      },
      _debug: getDebugPayload(),
    });
  } catch (e: any) {
    console.error("[os/inbound/gmail] Error:", e);
    return NextResponse.json(
      { ok: false, error: e?.message || "Internal error", _debug: getDebugPayload() },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    route: "os/inbound/gmail",
    _debug: getDebugPayload(),
  });
}
