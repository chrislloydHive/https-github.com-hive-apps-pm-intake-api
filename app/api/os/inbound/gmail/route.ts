import { NextResponse } from "next/server";

/**
 * Gmail Inbound API - Creates Opportunities and Companies in Client PM OS Airtable
 *
 * IMPORTANT: This route writes ONLY to Client PM OS, never to the Hive Database.
 * Requires AIRTABLE_INBOUND_* env vars - no fallback to DB vars.
 */

const INBOUND_BASE_ID = process.env.AIRTABLE_INBOUND_BASE_ID;
const INBOUND_OPP_TABLE = process.env.AIRTABLE_INBOUND_TABLE_OPPORTUNITIES;
const INBOUND_COMPANY_TABLE = process.env.AIRTABLE_INBOUND_TABLE_COMPANIES;

if (!INBOUND_BASE_ID || !INBOUND_OPP_TABLE || !INBOUND_COMPANY_TABLE) {
  throw new Error("Gmail inbound misconfigured: AIRTABLE_INBOUND_* env vars missing");
}

const AIRTABLE_API = "https://api.airtable.com/v0";

export async function POST(req: Request) {
  // Log to prove we're writing to OS, not DB
  console.log("GMAIL INBOUND → OS", {
    base: INBOUND_BASE_ID,
    oppTable: INBOUND_OPP_TABLE,
    companyTable: INBOUND_COMPANY_TABLE,
  });

  try {
    // Auth
    const authHeader = req.headers.get("authorization");
    const expectedToken = process.env.PM_INTAKE_TOKEN || process.env.PM_INTAKE_BEARER_TOKEN;

    if (!expectedToken || !authHeader || authHeader !== `Bearer ${expectedToken}`) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    // Parse body
    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
    }

    const {
      companyName,
      opportunityName,
      opportunityStage,
      contactEmail,
      contactName,
      source,
      notes,
    } = body;

    if (!companyName) {
      return NextResponse.json({ ok: false, error: "Missing companyName" }, { status: 400 });
    }

    const apiKey = process.env.AIRTABLE_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ ok: false, error: "Missing AIRTABLE_API_KEY" }, { status: 500 });
    }

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    // 1. Find or create Company in Client PM OS
    let companyRecordId: string | null = null;

    const companySearchUrl = `${AIRTABLE_API}/${INBOUND_BASE_ID}/${INBOUND_COMPANY_TABLE}?filterByFormula=${encodeURIComponent(
      `{Name}="${companyName.replace(/"/g, '\\"')}"`
    )}&maxRecords=1`;

    const companySearchRes = await fetch(companySearchUrl, { headers });
    const companySearchData = await companySearchRes.json();

    if (companySearchData.records?.length > 0) {
      companyRecordId = companySearchData.records[0].id;
    } else {
      const createCompanyRes = await fetch(`${AIRTABLE_API}/${INBOUND_BASE_ID}/${INBOUND_COMPANY_TABLE}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          fields: { Name: companyName },
        }),
      });
      const createCompanyData = await createCompanyRes.json();
      companyRecordId = createCompanyData.id;
    }

    // 2. Create Opportunity in Client PM OS
    let opportunityRecordId: string | null = null;
    let opportunityUrl: string | undefined;

    if (opportunityName) {
      const opportunityFields: Record<string, any> = {
        Name: opportunityName,
      };

      if (opportunityStage) opportunityFields["Stage"] = opportunityStage;
      if (companyRecordId) opportunityFields["Company"] = [companyRecordId];
      if (contactEmail) opportunityFields["Contact Email"] = contactEmail;
      if (contactName) opportunityFields["Contact Name"] = contactName;
      if (source) opportunityFields["Source"] = source;
      if (notes) opportunityFields["Notes"] = notes;

      const createOppRes = await fetch(`${AIRTABLE_API}/${INBOUND_BASE_ID}/${INBOUND_OPP_TABLE}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ fields: opportunityFields }),
      });
      const createOppData = await createOppRes.json();
      opportunityRecordId = createOppData.id;

      const inboundViewUrl = process.env.AIRTABLE_INBOUND_OPP_VIEW_URL;
      if (inboundViewUrl && opportunityRecordId) {
        opportunityUrl = `${inboundViewUrl}/${opportunityRecordId}`;
      }
    }

    return NextResponse.json({
      status: "success",
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
        name: companyName,
      },
    });
  } catch (e: any) {
    console.error("[os/inbound/gmail] Error:", e);
    return NextResponse.json(
      { ok: false, error: e?.message || "Internal error" },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, route: "os/inbound/gmail" });
}
