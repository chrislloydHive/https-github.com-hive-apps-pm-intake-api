/**
 * Types for the Gmail inbox ingestion pipeline.
 */

// ============================================================================
// Request/Response types
// ============================================================================

export type InboxMode = "opportunity" | "company_only" | "log_only";

export interface InboxEmailPayload {
  // Gmail identifiers
  gmailMessageId: string;
  gmailThreadId: string;
  gmailUrl?: string;

  // Sender info
  from: {
    email: string;
    name?: string;
  };

  // Email content
  subject: string;
  snippet?: string;
  bodyText?: string;

  // Metadata
  receivedAt?: string; // ISO date string
  mode?: InboxMode; // Default: "opportunity"
}

export type InboxStatus =
  | "duplicate"
  | "attached"
  | "opportunity_created"
  | "company_only"
  | "logged"
  | "error";

export interface InboxEmailResponse {
  ok: boolean;
  status: InboxStatus;
  traceId: string;
  company?: {
    id: string;
    name: string;
    domain: string;
    created: boolean;
  };
  opportunity?: {
    id: string;
    name: string;
    url?: string;
    attached?: boolean; // true if attached to existing thread
  };
  inboxItem?: {
    id: string;
  };
  error?: string;
  _debug?: {
    baseId: string;
    tables: {
      companies: string;
      opportunities: string;
      inboxItems: string;
    };
  };
}

// ============================================================================
// Airtable field types
// ============================================================================

export interface CompanyFields {
  "Company Name": string;
  Domain?: string;
  "Normalized Domain"?: string;
  "Source System"?: string;
}

export interface OpportunityFields {
  "Opportunity Name": string;
  Company?: string[]; // Linked record IDs
  Stage?: string;
  "Source System"?: string;
  "Gmail Thread ID"?: string;
  "Inbox Items"?: string[]; // Linked record IDs
}

export interface InboxItemFields {
  "Trace ID": string;
  "Gmail Message ID": string;
  "Gmail Thread ID": string;
  "Gmail URL"?: string;
  Subject: string;
  Snippet?: string;
  "Body Text"?: string;
  "From Email": string;
  "From Name"?: string;
  Domain?: string;
  "Received At"?: string;
  Company?: string[]; // Linked record IDs
  Opportunity?: string[]; // Linked record IDs
  Disposition?: string;
  "Activity Log"?: string;
  "Raw Payload"?: string;
}

// ============================================================================
// Internal types
// ============================================================================

export interface ProcessingContext {
  traceId: string;
  mode: InboxMode;
  payload: InboxEmailPayload;
  domain: string;
  normalizedDomain: string;
}

export interface CompanyResult {
  id: string;
  name: string;
  domain: string;
  created: boolean;
}

export interface OpportunityResult {
  id: string;
  name: string;
  url?: string;
  attached: boolean;
}
