import { NextResponse } from "next/server";

/**
 * Gmail Inbound API - Company Only
 * Creates or finds Companies in Client PM OS Airtable
 *
 * IMPORTANT: This route writes ONLY to Client PM OS, never to the Hive Database.
 * Requires AIRTABLE_INBOUND_* env vars - no fallback to DB vars.
 *
 * Company lookup uses domain-based matching - does NOT rely on linked-field auto-create.
 */

// Client PM OS env vars - NO DB FALLBACKS
const INBOUND_BASE_ID = process.env.AIRTABLE_INBOUND_BASE_ID;
const INBOUND_COMPANY_TABLE = process.env.AIRTABLE_INBOUND_TABLE_COMPANIES;

// Check at runtime, not module load
function checkEnvVars(): string | null {
  if (!INBOUND_BASE_ID || !INBOUND_COMPANY_TABLE) {
    return "Gmail inbound misconfigured: AIRTABLE_INBOUND_* env vars missing";
  }
  return null;
}

const AIRTABLE_API = "https://api.airtable.com/v0";

/**
 * Assert that a value is a valid Airtable record ID (starts with "rec").
 * Throws with a clear error message if not.
 */
function assertValidRecordId(
  value: unknown,
  context: string,
  marker: string
): asserts value is string {
  if (typeof value !== "string") {
    console.error("INVALID_RECORD_ID", {
      marker,
      context,
      value,
      type: typeof value,
      expected: "string starting with 'rec'",
    });
    throw new Error(
      `${context}: expected Airtable record ID (rec...), got ${typeof value}: ${JSON.stringify(value)}`
    );
  }

  if (!value.startsWith("rec")) {
    console.error("INVALID_RECORD_ID", {
      marker,
      context,
      value,
      startsWithRec: false,
      startsWithTbl: value.startsWith("tbl"),
      startsWithApp: value.startsWith("app"),
      expected: "string starting with 'rec'",
    });
    throw new Error(
      `${context}: expected Airtable record ID (rec...), got '${value}'. ` +
        (value.startsWith("tbl")
          ? "This looks like a TABLE ID, not a record ID. Check that you're using .id from the record, not the table ID from env vars."
          : value.startsWith("app")
          ? "This looks like a BASE ID, not a record ID."
          : "This does not look like an Airtable record ID.")
    );
  }
}

function getDebugPayload() {
  return {
    base: INBOUND_BASE_ID,
    companyTable: INBOUND_COMPANY_TABLE,
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
    website?: string;
    industry?: string;
    notes?: string;
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
    assertValidRecordId(recordId, "Company lookup by normalizedDomain_text", marker);
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
    assertValidRecordId(recordId, "Company lookup by domain", marker);
    console.log("COMPANY_FOUND_BY_DOMAIN", { marker, recordId, normalizedDomain });
    return { recordId, created: false, matchedBy: "domain" };
  }

  // Not found - create new Company
  const companyFields: Record<string, any> = {
    Name: opts.companyName || normalizedDomain,
    domain: normalizedDomain,
    normalizedDomain_text: normalizedDomain,
  };

  // Add optional fields
  if (opts.website) companyFields["Website"] = opts.website;
  if (opts.industry) companyFields["Industry"] = opts.industry;
  if (opts.notes) companyFields["Notes"] = opts.notes;

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
  assertValidRecordId(recordId, "Company create response", marker);
  console.log("COMPANY_CREATED", { marker, recordId, normalizedDomain });

  return { recordId, created: true };
}

export async function POST(req: Request) {
  // Unique marker for this request (for tracing through logs)
  const marker = `gmail_co_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  // Check env vars at runtime
  const envError = checkEnvVars();
  if (envError) {
    return NextResponse.json(
      { ok: false, error: envError, _debug: getDebugPayload() },
      { status: 500 }
    );
  }

  console.log("GMAIL_INBOUND_MARKER", marker);
  console.log("GMAIL INBOUND COMPANY → OS (APP ROUTER)", {
    marker,
    base: INBOUND_BASE_ID,
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
      email,        // Sender email to extract domain from
      domain,       // Explicit domain override
      website,
      industry,
      notes,
    } = body;

    // Extract domain from email or use provided domain
    const extractedDomain = domain || extractDomainFromEmail(email);

    if (!extractedDomain) {
      return NextResponse.json(
        {
          ok: false,
          error: "Missing or invalid email/domain. Cannot determine company domain.",
          hint: "Provide email (sender email) or domain field",
          _debug: getDebugPayload(),
        },
        { status: 400 }
      );
    }

    console.log("GMAIL_INBOUND_COMPANY_PARSED", {
      marker,
      companyName,
      email,
      extractedDomain,
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

    // Get or create Company by domain
    const companyResult = await getOrCreateCompany(marker, headers, {
      domain: extractedDomain,
      companyName: companyName || undefined,
      website: website || undefined,
      industry: industry || undefined,
      notes: notes || undefined,
    });

    console.log("GMAIL_INBOUND_COMPANY_COMPLETE", {
      marker,
      companyRecordId: companyResult.recordId,
      created: companyResult.created,
      matchedBy: companyResult.matchedBy,
    });

    return NextResponse.json({
      status: "success",
      marker,
      company: {
        id: companyResult.recordId,
        name: companyName || extractedDomain,
        domain: extractedDomain,
        created: companyResult.created,
        matchedBy: companyResult.matchedBy,
      },
      _debug: getDebugPayload(),
    });
  } catch (e: any) {
    console.error("[os/inbound/gmail/company] Error:", e);
    return NextResponse.json(
      { ok: false, error: e?.message || "Internal error", _debug: getDebugPayload() },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    route: "os/inbound/gmail/company",
    _debug: getDebugPayload(),
  });
}
