import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { config, tables, inboxFields } from "@/lib/config";
import { createRecord } from "@/lib/airtable";

const inboxItemSchema = z.object({
  project: z.string().min(1),
  details: z.string().optional(),
  client: z.string().optional(),
  program: z.string().optional(),
  workstream: z.string().optional(),
  owner: z.string().optional(),
  due_date: z.string().optional(),
  source: z.string().optional(),
  confidence: z.enum(["High", "Medium", "Low", "TBD"]).optional(),
});

const requestSchema = z.object({
  inbox_items: z.array(inboxItemSchema).min(1),
});

type InboxItemInput = z.infer<typeof inboxItemSchema>;

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value: string | undefined): boolean {
  return !!value && DATE_REGEX.test(value);
}

function isTBD(value: string | undefined): boolean {
  return value?.toUpperCase() === "TBD";
}

function buildInboxFields(item: InboxItemInput): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  fields[inboxFields.project] = item.project;
  fields[inboxFields.status] = "New";

  if (item.details && !isTBD(item.details)) {
    fields[inboxFields.details] = item.details;
  }
  if (item.client && !isTBD(item.client)) {
    fields[inboxFields.client] = item.client;
  }
  if (item.program && !isTBD(item.program)) {
    fields[inboxFields.program] = item.program;
  }
  if (item.workstream && !isTBD(item.workstream)) {
    fields[inboxFields.workstream] = item.workstream;
  }
  if (item.owner && !isTBD(item.owner)) {
    fields[inboxFields.owner] = item.owner;
  }
  if (isValidDate(item.due_date)) {
    fields[inboxFields.dueDate] = item.due_date;
  }
  if (item.source && !isTBD(item.source)) {
    fields[inboxFields.source] = item.source;
  }
  if (item.confidence && !isTBD(item.confidence)) {
    fields[inboxFields.confidence] = item.confidence;
  }

  return fields;
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.replace(/^Bearer\s+/i, "");

  if (!token || token !== config.pmIntakeToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parseResult = requestSchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parseResult.error.issues },
      { status: 400 }
    );
  }

  const { inbox_items } = parseResult.data;

  let createdCount = 0;
  const errors: { index: number; message: string }[] = [];

  for (let i = 0; i < inbox_items.length; i++) {
    const item = inbox_items[i];
    try {
      const fields = buildInboxFields(item);
      await createRecord(tables.inbox, fields);
      createdCount++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ index: i, message });
    }
  }

  const response: {
    status: string;
    createdCount: number;
    errors?: { index: number; message: string }[];
  } = {
    status: "ok",
    createdCount,
  };

  if (errors.length > 0) {
    response.errors = errors;
  }

  return NextResponse.json(response);
}
