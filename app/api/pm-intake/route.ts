import { NextResponse } from "next/server";
import Airtable from "airtable";

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(
  process.env.AIRTABLE_BASE_ID as string
);

function isAuthorized(req: Request) {
  const expected = process.env.PM_INTAKE_TOKEN;

  // If token isn't set in the deployed environment, it will ALWAYS 401
  if (!expected || expected.trim().length === 0) {
    return { ok: false, reason: "PM_INTAKE_TOKEN missing on server" };
  }

  const auth = req.headers.get("authorization") || "";
  const alt = req.headers.get("x-pm-intake-token") || "";

  // Support:
  // - Authorization: Bearer <token>
  // - Authorization: <token>
  let provided = "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    provided = auth.slice(7).trim();
  } else if (auth.trim().length > 0) {
    provided = auth.trim();
  } else if (alt.trim().length > 0) {
    provided = alt.trim();
  }

  if (!provided) return { ok: false, reason: "No token provided" };
  if (provided !== expected) return { ok: false, reason: "Token mismatch" };

  return { ok: true as const };
}

export async function POST(req: Request) {
  console.log("[pm-intake] POST route hit");
  console.log("[pm-intake] Headers present:", {
    authorization: !!req.headers.get("authorization"),
    "x-pm-intake-token": !!req.headers.get("x-pm-intake-token"),
  });

  const authCheck = isAuthorized(req);
  if (!authCheck.ok) {
    return NextResponse.json({ error: "Unauthorized", details: authCheck.reason }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { inbox_items } = body;

    if (!Array.isArray(inbox_items) || inbox_items.length === 0) {
      return NextResponse.json(
        { error: "Invalid payload: inbox_items must be a non-empty array" },
        { status: 400 }
      );
    }

    const records = inbox_items.map((item: any) => {
      const fields: Record<string, any> = {};

      if (item.title && item.title !== "TBD") fields["Project"] = item.title;
      if (item.item_type) fields["Item Type"] = item.item_type;
      if (item.details && item.details !== "TBD") {
        fields["Details"] = item.details;
        fields["Description"] = item.details;
      }
      if (item.client && item.client !== "TBD") fields["Client"] = item.client;
      if (item.program && item.program !== "TBD") fields["Program"] = item.program;
      if (item.workstream && item.workstream !== "TBD") fields["Workstream"] = item.workstream;
      if (item.owner && item.owner !== "TBD") fields["Owner"] = item.owner;
      if (item.due_date && /^\d{4}-\d{2}-\d{2}$/.test(item.due_date)) fields["Due Date"] = item.due_date;
      if (item.source && item.source !== "TBD") fields["Source"] = item.source;
      if (item.confidence && item.confidence !== "TBD") fields["Confidence"] = item.confidence;

      fields["Status"] = "New";
      return { fields };
    });

    // Airtable REST has a 10-record batch limit; chunk to be safe
    const created: any[] = [];
    for (let i = 0; i < records.length; i += 10) {
      const chunk = records.slice(i, i + 10);
      console.log("[pm-intake] Calling Airtable.create for chunk", i / 10 + 1, "with", chunk.length, "records");
      console.log("AIRTABLE_BASE_ID:", process.env.AIRTABLE_BASE_ID);
      console.log("AIRTABLE_TABLE:", "Inbox");
      console.log("AIRTABLE_KEY_PREFIX:", (process.env.AIRTABLE_API_KEY || "").slice(0, 3));
      const res = await base("Inbox").create(chunk, { typecast: true });
      created.push(...res);
    }

    return NextResponse.json({ success: true, createdCount: created.length }, { status: 200 });
  } catch (error: any) {
    console.error(error);
    return NextResponse.json(
      { error: "Failed to create Inbox records", details: error?.message ?? String(error) },
      { status: 500 }
    );
  }
}
