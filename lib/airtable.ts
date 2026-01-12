import { config } from "./config";

const BASE_URL = `https://api.airtable.com/v0/${config.airtableBaseId}`;
const MAX_RETRIES = 3;

export interface AirtableRecord<T = Record<string, unknown>> {
  id: string;
  fields: T;
  createdTime: string;
}

interface AirtableListResponse<T> {
  records: AirtableRecord<T>[];
  offset?: string;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  attempt = 1
): Promise<Response> {
  const response = await fetch(url, options);

  if (response.status === 429 && attempt < MAX_RETRIES) {
    // Exponential backoff: 1s, 2s, 4s
    const delay = Math.pow(2, attempt - 1) * 1000;
    await sleep(delay);
    return fetchWithRetry(url, options, attempt + 1);
  }

  return response;
}

function getHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${config.airtableApiKey}`,
    "Content-Type": "application/json",
  };
}

export async function listRecords<T = Record<string, unknown>>(
  table: string,
  filterByFormula?: string
): Promise<AirtableRecord<T>[]> {
  const encodedTable = encodeURIComponent(table);
  let url = `${BASE_URL}/${encodedTable}`;

  if (filterByFormula) {
    url += `?filterByFormula=${encodeURIComponent(filterByFormula)}`;
  }

  const res = await fetchWithRetry(url, {
    method: "GET",
    headers: getHeaders(),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(
      `Airtable API error ${res.status} ${res.statusText}: ${text}`
    );
  }

  const data: AirtableListResponse<T> = JSON.parse(text);
  return data.records;
}

export async function createRecord<T = Record<string, unknown>>(
  table: string,
  fields: Record<string, unknown>
): Promise<AirtableRecord<T>> {
  const encodedTable = encodeURIComponent(table);
  const url = `${BASE_URL}/${encodedTable}`;
  const requestBody = JSON.stringify({ fields });

  console.log("[DEBUG] createRecord URL:", url);
  console.log("[DEBUG] createRecord table:", table);
  console.log("[DEBUG] createRecord body:", requestBody);

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: getHeaders(),
    body: requestBody,
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(
      `Airtable API error ${res.status} ${res.statusText}: ${text}`
    );
  }

  const parsed: AirtableRecord<T> = JSON.parse(text);
  console.log("[DEBUG] createRecord response id:", parsed.id);
  return parsed;
}

export async function getRecordById<T = Record<string, unknown>>(
  table: string,
  recordId: string
): Promise<AirtableRecord<T>> {
  const encodedTable = encodeURIComponent(table);
  const url = `${BASE_URL}/${encodedTable}/${recordId}`;

  const res = await fetchWithRetry(url, {
    method: "GET",
    headers: getHeaders(),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(
      `Airtable API error ${res.status} ${res.statusText}: ${text}`
    );
  }

  return JSON.parse(text);
}

export async function updateRecord<T = Record<string, unknown>>(
  table: string,
  recordId: string,
  fields: Record<string, unknown>
): Promise<AirtableRecord<T>> {
  const encodedTable = encodeURIComponent(table);
  const url = `${BASE_URL}/${encodedTable}/${recordId}`;

  const res = await fetchWithRetry(url, {
    method: "PATCH",
    headers: getHeaders(),
    body: JSON.stringify({ fields }),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(
      `Airtable API error ${res.status} ${res.statusText}: ${text}`
    );
  }

  return JSON.parse(text);
}
