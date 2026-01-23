import { NextResponse } from "next/server";

/**
 * Gmail Inbound API - Company Only
 * Creates or finds Companies in Client PM OS Airtable
 *
 * IMPORTANT: This route writes ONLY to Client PM OS, never to the Hive Database.
 * Requires AIRTABLE_INBOUND_* env vars - no fallback to DB vars.
 */

// Client PM OS env vars - NO DB FALLBACKS
const INBOUND_BASE_ID = process.env.AIRTABLE_INBOUND_BASE_ID;
const INBOUND_COMPANY_TABLE = process.env.AIRTABLE_INBOUND_TABLE_COMPANIES;

if (!INBOUND_BASE_ID || !INBOUND_COMPANY_TABLE) {
  throw new Error("Gmail inbound misconfigured: AIRTABLE_INBOUND_* env vars missing");
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

export async function POST(req: Request) {
  // Unique marker for this request (for tracing through logs)
  const marker = `gmail_co_${Date.now()}_${Math.random().toString(16).slice(2)}`;

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

    const { companyName, website, industry, notes } = body;

    if (!companyName) {
      return NextResponse.json(
        { ok: false, error: "Missing companyName", _debug: getDebugPayload() },
        { status: 400 }
      );
    }

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

    // Search for existing company in Client PM OS
    const searchUrl = `${AIRTABLE_API}/${INBOUND_BASE_ID}/${INBOUND_COMPANY_TABLE}?filterByFormula=${encodeURIComponent(
      `{Name}="${companyName.replace(/"/g, '\\"')}"`
    )}&maxRecords=1`;

    const searchRes = await tracedFetch(marker, searchUrl, { headers });
    const searchData = await searchRes.json();

    let companyRecordId: string;
    let created = false;

    if (searchData.records?.length > 0) {
      companyRecordId = searchData.records[0].id;
      console.log("COMPANY_FOUND", { marker, companyRecordId });
    } else {
      // Create new company in Client PM OS
      const fields: Record<string, any> = { Name: companyName };
      if (website) fields["Website"] = website;
      if (industry) fields["Industry"] = industry;
      if (notes) fields["Notes"] = notes;

      const createUrl = `${AIRTABLE_API}/${INBOUND_BASE_ID}/${INBOUND_COMPANY_TABLE}`;
      const createRes = await tracedFetch(marker, createUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ fields }),
      });
      const createData = await createRes.json();
      companyRecordId = createData.id;
      created = true;
      console.log("COMPANY_CREATED", { marker, companyRecordId });
    }

    console.log("GMAIL_INBOUND_COMPANY_COMPLETE", { marker, companyRecordId, created });

    return NextResponse.json({
      status: "success",
      marker,
      company: {
        id: companyRecordId,
        name: companyName,
        created,
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
