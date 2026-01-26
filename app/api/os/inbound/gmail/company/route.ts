import { NextResponse } from "next/server";

/**
 * Gmail Inbound API - Company Only
 * POST /api/os/inbound/gmail/company
 *
 * Creates or finds Companies in Client PM OS Airtable
 *
 * IMPORTANT: This route writes ONLY to Client PM OS, never to the Hive Database.
 * Requires AIRTABLE_INBOUND_* env vars - no fallback to DB vars.
 *
 * Authentication (supports BOTH):
 * - X-Hive-Secret: <HIVE_INBOUND_SECRET>  (Gmail Add-on / Apps Script direct calls)
 * - Authorization: Bearer <PM_INTAKE_TOKEN>  (Proxy calls)
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
 * Dual auth check - supports both X-Hive-Secret and Bearer token
 * Returns { ok: true, method: "secret" | "bearer" } or { ok: false, error: string }
 */
function checkAuth(req: Request): { ok: true; method: "secret" | "bearer" } | { ok: false; error: string } {
  // Method 1: X-Hive-Secret header (Gmail Add-on / Apps Script)
  const hiveSecret = req.headers.get("x-hive-secret");
  const expectedSecret = process.env.HIVE_INBOUND_SECRET;

  if (hiveSecret && expectedSecret && hiveSecret === expectedSecret) {
    return { ok: true, method: "secret" };
  }

  // Method 2: Authorization Bearer token (Proxy calls)
  const authHeader = req.headers.get("authorization");
  const expectedToken = process.env.PM_INTAKE_TOKEN || process.env.PM_INTAKE_BEARER_TOKEN;

  if (authHeader && expectedToken && authHeader === `Bearer ${expectedToken}`) {
    return { ok: true, method: "bearer" };
  }

  // Neither auth method succeeded
  return { ok: false, error: "Unauthorized: provide X-Hive-Secret or Bearer token" };
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
      { ok: false, status: "error", error: envError, marker, _debug: getDebugPayload() },
      { status: 500 }
    );
  }

  console.log("GMAIL_INBOUND_MARKER", marker);

  try {
    // Dual auth check - supports both X-Hive-Secret and Bearer token
    const authResult = checkAuth(req);
    if (!authResult.ok) {
      console.log("GMAIL_INBOUND_AUTH_FAILED", { marker, error: authResult.error });
      return NextResponse.json(
        { ok: false, status: "error", error: authResult.error, marker },
        { status: 401 }
      );
    }

    // Log which auth method was used
    console.log("GMAIL_INBOUND_AUTH_OK", { marker, authMethod: authResult.method });

    console.log("GMAIL INBOUND COMPANY → OS (APP ROUTER)", {
      marker,
      authMethod: authResult.method,
      base: INBOUND_BASE_ID,
      companyTable: INBOUND_COMPANY_TABLE,
    });

    // Parse body
    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, status: "error", error: "Invalid JSON", marker },
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
          status: "error",
          error: "Missing or invalid email/domain. Cannot determine company domain.",
          hint: "Provide email (sender email) or domain field",
          marker,
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
        { ok: false, status: "error", error: "Missing AIRTABLE_API_KEY", marker },
        { status: 500 }
      );
    }

    // Log env vars being used (prefixes only for security)
    console.log("GMAIL_INBOUND_AIRTABLE_CONFIG", {
      marker,
      baseId: INBOUND_BASE_ID || "(not set)",
      baseIdPrefix: (INBOUND_BASE_ID || "").slice(0, 6) + "...",
      companyTable: INBOUND_COMPANY_TABLE || "(not set)",
      apiKeyPrefix: apiKey.slice(0, 6) + "...",
    });

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
      ok: true,
      status: companyResult.created ? "created" : "existing",
      marker,
      company: {
        id: companyResult.recordId,
        name: companyName || extractedDomain,
        domain: extractedDomain,
        created: companyResult.created,
        matchedBy: companyResult.matchedBy,
      },
    });
  } catch (e: any) {
    console.error("[os/inbound/gmail/company] Error:", { marker, error: e?.message || e });
    return NextResponse.json(
      {
        ok: false,
        status: "error",
        error: e?.message || "Internal error",
        marker,
        _config: {
          baseId: INBOUND_BASE_ID ? `${INBOUND_BASE_ID.slice(0, 6)}...` : "(not set)",
          companyTable: INBOUND_COMPANY_TABLE || "(not set)",
        },
      },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    route: "/api/os/inbound/gmail/company",
    description: "Gmail inbound - Company only",
    auth: {
      supports: ["x-hive-secret", "bearer"],
      headers: {
        "x-hive-secret": "HIVE_INBOUND_SECRET env var",
        "authorization": "Bearer <PM_INTAKE_TOKEN or PM_INTAKE_BEARER_TOKEN>",
      },
    },
  });
}
