import { NextResponse } from "next/server";

/**
 * Gmail Inbound API - Company Only
 * Creates or finds Companies in Client PM OS Airtable
 *
 * IMPORTANT: This route writes ONLY to Client PM OS, never to the Hive Database.
 * Requires AIRTABLE_INBOUND_* env vars - no fallback to DB vars.
 */

const ROUTE_VERSION = "gmail-inbound-company-os-debug-001";

// Inbound-specific env vars (MUST be set)
const inboundBaseId = process.env.AIRTABLE_INBOUND_BASE_ID || "";
const inboundOppTable = process.env.AIRTABLE_INBOUND_TABLE_OPPORTUNITIES || "";
const inboundCompanyTable = process.env.AIRTABLE_INBOUND_TABLE_COMPANIES || "";

// Fallback env vars (should NOT be used, but captured for debug)
const fallbackBaseId = process.env.AIRTABLE_BASE_ID || "";
const fallbackOppTable = process.env.AIRTABLE_TABLE_OPPORTUNITIES || "";
const fallbackCompanyTable = process.env.AIRTABLE_TABLE_COMPANIES || "";

// ACTUAL IDs used for writes - NO FALLBACK, inbound only
const usedBaseId = inboundBaseId;
const usedOppTable = inboundOppTable;
const usedCompanyTable = inboundCompanyTable;

if (!usedBaseId || !usedCompanyTable) {
  throw new Error("Gmail inbound misconfigured: AIRTABLE_INBOUND_* env vars missing");
}

const AIRTABLE_API = "https://api.airtable.com/v0";

function getDebugPayload() {
  return {
    routeVersion: ROUTE_VERSION,
    inboundBaseId,
    inboundOppTable,
    inboundCompanyTable,
    fallbackBaseId,
    fallbackOppTable,
    fallbackCompanyTable,
    usedBaseId,
    usedOppTable,
    usedCompanyTable,
    inboundViewUrl: process.env.AIRTABLE_INBOUND_OPP_VIEW_URL || "",
  };
}

export async function POST(req: Request) {
  // Log to prove we're writing to OS, not DB
  console.log("GMAIL INBOUND COMPANY DEBUG", {
    ROUTE_VERSION,
    usedBaseId,
    usedCompanyTable,
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
    const searchUrl = `${AIRTABLE_API}/${usedBaseId}/${usedCompanyTable}?filterByFormula=${encodeURIComponent(
      `{Name}="${companyName.replace(/"/g, '\\"')}"`
    )}&maxRecords=1`;

    const searchRes = await fetch(searchUrl, { headers });
    const searchData = await searchRes.json();

    let companyRecordId: string;
    let created = false;

    if (searchData.records?.length > 0) {
      companyRecordId = searchData.records[0].id;
    } else {
      // Create new company in Client PM OS
      const fields: Record<string, any> = { Name: companyName };
      if (website) fields["Website"] = website;
      if (industry) fields["Industry"] = industry;
      if (notes) fields["Notes"] = notes;

      const createRes = await fetch(`${AIRTABLE_API}/${usedBaseId}/${usedCompanyTable}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ fields }),
      });
      const createData = await createRes.json();
      companyRecordId = createData.id;
      created = true;
    }

    return NextResponse.json({
      status: "success",
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
