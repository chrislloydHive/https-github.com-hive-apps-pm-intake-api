import { NextResponse } from "next/server";

/**
 * Gmail Inbound API - Company Only
 * Creates or finds Companies in Client PM OS Airtable
 *
 * IMPORTANT: This route writes ONLY to Client PM OS, never to the Hive Database.
 * Requires AIRTABLE_INBOUND_* env vars - no fallback to DB vars.
 */

const INBOUND_BASE_ID = process.env.AIRTABLE_INBOUND_BASE_ID;
const INBOUND_COMPANY_TABLE = process.env.AIRTABLE_INBOUND_TABLE_COMPANIES;

if (!INBOUND_BASE_ID || !INBOUND_COMPANY_TABLE) {
  throw new Error("Gmail inbound misconfigured: AIRTABLE_INBOUND_* env vars missing");
}

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

    const { companyName, website, industry, notes } = body;

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

    // Search for existing company in Client PM OS
    const searchUrl = `${AIRTABLE_API}/${INBOUND_BASE_ID}/${INBOUND_COMPANY_TABLE}?filterByFormula=${encodeURIComponent(
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

      const createRes = await fetch(`${AIRTABLE_API}/${INBOUND_BASE_ID}/${INBOUND_COMPANY_TABLE}`, {
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
    });
  } catch (e: any) {
    console.error("[os/inbound/gmail/company] Error:", e);
    return NextResponse.json(
      { ok: false, error: e?.message || "Internal error" },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, route: "os/inbound/gmail/company" });
}
