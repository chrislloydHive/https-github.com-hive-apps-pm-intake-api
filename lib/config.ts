// Environment variables
export const config = {
  pmIntakeToken: process.env.PM_INTAKE_TOKEN ?? "",
  airtableApiKey: process.env.AIRTABLE_API_KEY ?? "",
  airtableBaseId: process.env.AIRTABLE_BASE_ID ?? "",
  /** Client PM OS base — Projects table used by Client PM automations */
  clientPmOsBaseId: process.env.CLIENT_PM_OS_BASE_ID ?? process.env.AIRTABLE_BASE_ID ?? "",
  /** HIVE OS base — Projects table in Hive agency OS */
  hiveOsBaseId: process.env.HIVE_OS_BASE_ID ?? process.env.AIRTABLE_OS_BASE_ID ?? "",
};

// Table names
export const tables = {
  inbox: process.env.AIRTABLE_INBOX_TABLE_NAME ?? "Inbox",
  projects: process.env.AIRTABLE_PROJECTS_TABLE_NAME ?? "Projects",
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
