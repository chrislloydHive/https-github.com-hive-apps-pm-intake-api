import { NextResponse } from "next/server";
import Airtable from "airtable";

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(
  process.env.AIRTABLE_BASE_ID as string
);

function isAuthorized(req: Request): { ok: true } | { ok: false; reason: string } {
  const expected = process.env.PM_INTAKE_BEARER_TOKEN;

  if (!expected || expected.trim().length === 0) {
    return { ok: false, reason: "PM_INTAKE_BEARER_TOKEN missing on server" };
  }

  const auth = req.headers.get("authorization") || "";

  if (!auth) {
    return { ok: false, reason: "Authorization header missing" };
  }

  let provided = "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    provided = auth.slice(7).trim();
  }

  if (!provided) {
    return { ok: false, reason: "Bearer token not provided" };
  }

  if (provided !== expected) {
    return { ok: false, reason: "Token mismatch" };
  }

  return { ok: true };
}

function notEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.toUpperCase() !== "TBD";
}

function generateTitleFromDescription(description: string): string {
  const trimmed = description.trim();
  const firstSentenceMatch = trimmed.match(/^[^.!?]+[.!?]?/);
  const firstSentence = firstSentenceMatch ? firstSentenceMatch[0].trim() : trimmed;
  if (firstSentence.length <= 80) {
    return firstSentence;
  }
  return firstSentence.slice(0, 80).trim();
}

export async function POST(req: Request) {
  try {
    const authCheck = isAuthorized(req);
    if (!authCheck.ok) {
      return NextResponse.json(
        { success: false, createdCount: 0, errors: [{ index: -1, message: authCheck.reason }] },
        { status: 401 }
      );
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { success: false, createdCount: 0, errors: [{ index: -1, message: "Invalid JSON body" }] },
        { status: 400 }
      );
    }

    const { inbox_items } = body;

    if (!Array.isArray(inbox_items) || inbox_items.length === 0) {
      return NextResponse.json(
        { success: false, createdCount: 0, errors: [{ index: -1, message: "inbox_items must be a non-empty array" }] },
        { status: 400 }
      );
    }

    const records = inbox_items.map((item: any) => {
      const fields: Record<string, any> = {};

      // Title: required, auto-generate from description if missing
      let title = notEmpty(item.title) ? item.title : null;
      const description = notEmpty(item.description) ? item.description : null;
      if (!title && description) {
        title = generateTitleFromDescription(description);
      }
      if (!title) {
        title = "Untitled Inbox Item";
      }
      fields["Title"] = title;

      // Description
      if (description) {
        fields["Description"] = description;
      }

      // Project: preserve as plain text, do not remap
      if (notEmpty(item.project)) {
        fields["Project"] = item.project;
      }

      // Optional fields
      if (notEmpty(item.client)) fields["Client"] = item.client;
      if (notEmpty(item.program)) fields["Program"] = item.program;
      if (notEmpty(item.workstream)) fields["Workstream"] = item.workstream;
      if (notEmpty(item.owner)) fields["Owner"] = item.owner;
      if (notEmpty(item.item_type)) fields["Item Type"] = item.item_type;
      if (item.due_date && /^\d{4}-\d{2}-\d{2}$/.test(item.due_date)) fields["Due Date"] = item.due_date;
      if (notEmpty(item.source)) fields["Source"] = item.source;
      if (notEmpty(item.confidence)) fields["Confidence"] = item.confidence;

      fields["Status"] = "New";

      return { fields };
    });

    const created: any[] = [];
    const errors: { index: number; message: string }[] = [];

    for (let i = 0; i < records.length; i += 10) {
      const chunk = records.slice(i, i + 10);
      try {
        const res = await base("Inbox").create(chunk, { typecast: true });
        created.push(...res);
      } catch (err: any) {
        for (let j = 0; j < chunk.length; j++) {
          errors.push({ index: i + j, message: err?.message ?? String(err) });
        }
      }
    }

    return NextResponse.json({ success: true, createdCount: created.length, errors }, { status: 200 });
  } catch (error: any) {
    console.error("[pm-intake] Unexpected error:", error);
    return NextResponse.json(
      { success: false, createdCount: 0, errors: [{ index: -1, message: error?.message ?? "Unknown error" }] },
      { status: 500 }
    );
  }
}
