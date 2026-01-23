import { NextResponse } from "next/server";

/**
 * Gmail Inbound API - Creates Opportunities and Companies in Client PM OS Airtable
 *
 * Uses inbound-specific env vars with fallback to default DB vars:
 * - AIRTABLE_INBOUND_BASE_ID → AIRTABLE_BASE_ID
 * - AIRTABLE_INBOUND_TABLE_OPPORTUNITIES → AIRTABLE_TABLE_OPPORTUNITIES
 * - AIRTABLE_INBOUND_TABLE_COMPANIES → AIRTABLE_TABLE_COMPANIES
 */

const AIRTABLE_API = "https://api.airtable.com/v0";

export async function POST(req: Request) {
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

    // Inbound-specific env vars with fallbacks
    const baseId =
      process.env.AIRTABLE_INBOUND_BASE_ID ??
      process.env.AIRTABLE_BASE_ID;

    const opportunitiesTableId =
      process.env.AIRTABLE_INBOUND_TABLE_OPPORTUNITIES ??
      process.env.AIRTABLE_TABLE_OPPORTUNITIES;

    const companiesTableId =
      process.env.AIRTABLE_INBOUND_TABLE_COMPANIES ??
      process.env.AIRTABLE_TABLE_COMPANIES;

    const apiKey = process.env.AIRTABLE_API_KEY;

    if (!baseId || !apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing Airtable configuration" },
        { status: 500 }
      );
    }

    if (!companiesTableId) {
      return NextResponse.json(
        { ok: false, error: "Missing companies table configuration" },
        { status: 500 }
      );
    }

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    // 1. Find or create Company
    let companyRecordId: string | null = null;

    // Search for existing company
    const companySearchUrl = `${AIRTABLE_API}/${baseId}/${companiesTableId}?filterByFormula=${encodeURIComponent(
      `{Name}="${companyName.replace(/"/g, '\\"')}"`
    )}&maxRecords=1`;

    const companySearchRes = await fetch(companySearchUrl, { headers });
    const companySearchData = await companySearchRes.json();

    if (companySearchData.records?.length > 0) {
      companyRecordId = companySearchData.records[0].id;
    } else {
      // Create new company
      const createCompanyRes = await fetch(`${AIRTABLE_API}/${baseId}/${companiesTableId}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          fields: {
            Name: companyName,
          },
        }),
      });
      const createCompanyData = await createCompanyRes.json();
      companyRecordId = createCompanyData.id;
    }

    // 2. Create Opportunity (if opportunitiesTableId is configured)
    let opportunityRecordId: string | null = null;
    let opportunityUrl: string | undefined;

    if (opportunitiesTableId && opportunityName) {
      const opportunityFields: Record<string, any> = {
        Name: opportunityName,
      };

      if (opportunityStage) opportunityFields["Stage"] = opportunityStage;
      if (companyRecordId) opportunityFields["Company"] = [companyRecordId];
      if (contactEmail) opportunityFields["Contact Email"] = contactEmail;
      if (contactName) opportunityFields["Contact Name"] = contactName;
      if (source) opportunityFields["Source"] = source;
      if (notes) opportunityFields["Notes"] = notes;

      const createOppRes = await fetch(`${AIRTABLE_API}/${baseId}/${opportunitiesTableId}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ fields: opportunityFields }),
      });
      const createOppData = await createOppRes.json();
      opportunityRecordId = createOppData.id;

      // Generate opportunity URL for Client PM OS view
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
