/**
 * OS-specific Airtable API client using fetch.
 * Designed for the Gmail inbox ingestion pipeline.
 * Does NOT use the airtable npm package or shared config.
 */

const AIRTABLE_API_BASE = "https://api.airtable.com/v0";

export interface AirtableRecord<T = Record<string, unknown>> {
  id: string;
  createdTime: string;
  fields: T;
}

export interface AirtableError {
  error: {
    type: string;
    message: string;
  };
}

export interface AirtableListResponse<T = Record<string, unknown>> {
  records: AirtableRecord<T>[];
  offset?: string;
}

export class AirtableOSClient {
  private apiKey: string;
  private baseId: string;

  constructor(apiKey: string, baseId: string) {
    if (!apiKey) throw new Error("AirtableOSClient: apiKey is required");
    if (!baseId) throw new Error("AirtableOSClient: baseId is required");
    this.apiKey = apiKey;
    this.baseId = baseId;
  }

  get baseIdValue(): string {
    return this.baseId;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  private tableUrl(tableId: string): string {
    return `${AIRTABLE_API_BASE}/${this.baseId}/${tableId}`;
  }

  /**
   * Find a single record by formula.
   * Returns null if no match found.
   */
  async findOneByFormula<T = Record<string, unknown>>(
    tableId: string,
    formula: string,
    traceId?: string
  ): Promise<AirtableRecord<T> | null> {
    const url = `${this.tableUrl(tableId)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;

    console.log("AIRTABLE_FIND", { traceId, baseId: this.baseId, tableId, formula });

    const res = await fetch(url, { headers: this.headers });
    const data = await res.json();

    if (!res.ok) {
      console.error("AIRTABLE_FIND_ERROR", { traceId, tableId, status: res.status, data });
      throw new Error(`Airtable find failed: ${data?.error?.message || JSON.stringify(data)}`);
    }

    const records = (data as AirtableListResponse<T>).records;
    console.log("AIRTABLE_FIND_RESULT", { traceId, tableId, found: records.length > 0, recordId: records[0]?.id });

    return records.length > 0 ? records[0] : null;
  }

  /**
   * Find multiple records by formula.
   */
  async findByFormula<T = Record<string, unknown>>(
    tableId: string,
    formula: string,
    maxRecords = 100,
    traceId?: string
  ): Promise<AirtableRecord<T>[]> {
    const url = `${this.tableUrl(tableId)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=${maxRecords}`;

    console.log("AIRTABLE_FIND_MANY", { traceId, baseId: this.baseId, tableId, formula, maxRecords });

    const res = await fetch(url, { headers: this.headers });
    const data = await res.json();

    if (!res.ok) {
      console.error("AIRTABLE_FIND_MANY_ERROR", { traceId, tableId, status: res.status, data });
      throw new Error(`Airtable find failed: ${data?.error?.message || JSON.stringify(data)}`);
    }

    const records = (data as AirtableListResponse<T>).records;
    console.log("AIRTABLE_FIND_MANY_RESULT", { traceId, tableId, count: records.length });

    return records;
  }

  /**
   * Create a new record.
   */
  async createRecord<T = Record<string, unknown>>(
    tableId: string,
    fields: Record<string, unknown>,
    traceId?: string
  ): Promise<AirtableRecord<T>> {
    const url = this.tableUrl(tableId);

    console.log("AIRTABLE_CREATE", { traceId, baseId: this.baseId, tableId, fields });

    const res = await fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ fields }),
    });

    const data = await res.json();

    if (!res.ok || data.error) {
      console.error("AIRTABLE_CREATE_ERROR", { traceId, tableId, status: res.status, data });
      throw new Error(`Airtable create failed: ${data?.error?.message || JSON.stringify(data)}`);
    }

    console.log("AIRTABLE_CREATE_SUCCESS", { traceId, tableId, recordId: data.id });

    return data as AirtableRecord<T>;
  }

  /**
   * Update an existing record (PATCH - partial update).
   */
  async updateRecord<T = Record<string, unknown>>(
    tableId: string,
    recordId: string,
    fields: Record<string, unknown>,
    traceId?: string
  ): Promise<AirtableRecord<T>> {
    const url = `${this.tableUrl(tableId)}/${recordId}`;

    console.log("AIRTABLE_UPDATE", { traceId, baseId: this.baseId, tableId, recordId, fields });

    const res = await fetch(url, {
      method: "PATCH",
      headers: this.headers,
      body: JSON.stringify({ fields }),
    });

    const data = await res.json();

    if (!res.ok || data.error) {
      console.error("AIRTABLE_UPDATE_ERROR", { traceId, tableId, recordId, status: res.status, data });
      throw new Error(`Airtable update failed: ${data?.error?.message || JSON.stringify(data)}`);
    }

    console.log("AIRTABLE_UPDATE_SUCCESS", { traceId, tableId, recordId });

    return data as AirtableRecord<T>;
  }

  /**
   * Get a single record by ID.
   */
  async getRecord<T = Record<string, unknown>>(
    tableId: string,
    recordId: string,
    traceId?: string
  ): Promise<AirtableRecord<T>> {
    const url = `${this.tableUrl(tableId)}/${recordId}`;

    console.log("AIRTABLE_GET", { traceId, baseId: this.baseId, tableId, recordId });

    const res = await fetch(url, { headers: this.headers });
    const data = await res.json();

    if (!res.ok || data.error) {
      console.error("AIRTABLE_GET_ERROR", { traceId, tableId, recordId, status: res.status, data });
      throw new Error(`Airtable get failed: ${data?.error?.message || JSON.stringify(data)}`);
    }

    return data as AirtableRecord<T>;
  }
}

/**
 * Escape a string value for use in Airtable formulas.
 */
export function escapeFormulaValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Normalize a domain: lowercase, trim, remove protocol/www/paths.
 */
export function normalizeDomain(input: string): string {
  if (!input) return "";

  let domain = input.trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, "");
  domain = domain.split("/")[0].split("?")[0];
  domain = domain.replace(/^www\./, "");

  return domain;
}

/**
 * Extract domain from an email address.
 * Handles "Name <email>" format.
 */
export function extractDomainFromEmail(email: string): string | null {
  if (!email) return null;

  // Handle "Name <email>" format
  const angleMatch = email.match(/<([^>]+)>/);
  const emailAddr = angleMatch ? angleMatch[1] : email;

  const atIndex = emailAddr.lastIndexOf("@");
  if (atIndex === -1) return null;

  return normalizeDomain(emailAddr.slice(atIndex + 1));
}

/**
 * Generate a trace ID for request tracking.
 */
export function generateTraceId(prefix = "inb"): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}_${rand}`;
}
