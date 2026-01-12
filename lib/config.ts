// Environment variables
export const config = {
  pmIntakeToken: process.env.PM_INTAKE_TOKEN ?? "",
  airtableApiKey: process.env.AIRTABLE_API_KEY ?? "",
  airtableBaseId: process.env.AIRTABLE_BASE_ID ?? "",
};

// Table names
export const tables = {
  inbox: process.env.AIRTABLE_INBOX_TABLE_NAME ?? "Inbox",
};

// Field names for Inbox
export const inboxFields = {
  project: "Project",
  client: "Client",
  program: "Program",
  workstream: "Workstream",
  details: "Details",
  owner: "Owner",
  dueDate: "Due Date",
  status: "Status",
  source: "Source",
  confidence: "Confidence",
};
