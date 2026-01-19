# PM Intake API

A minimal Next.js API for ingesting PM items into Airtable. Deployed on Vercel.

## Setup

1. Copy environment variables:
   ```bash
   cp .env.example .env.local
   ```

2. Fill in your `.env.local`:
   - `PM_INTAKE_TOKEN` - Bearer token for API authentication
   - `AIRTABLE_API_KEY` - Your Airtable personal access token
   - `AIRTABLE_BASE_ID` - Your Airtable base ID (starts with `app`)

3. Install dependencies:
   ```bash
   npm install
   ```

4. Run locally:
   ```bash
   npm run dev
   ```

## API Usage

### POST /api/pm-intake

Creates PM inbox items in Airtable with automatic client/project resolution and idempotency.

**Headers:**
- `Content-Type: application/json`
- `Authorization: Bearer <PM_INTAKE_TOKEN>`

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/pm-intake \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-token" \
  -d '{
    "client": "Acme Corp",
    "project": "Website Redesign",
    "items": [
      {
        "type": "task",
        "title": "Review wireframes",
        "description": "Review and approve homepage wireframes",
        "owner": "Jane Smith",
        "priority": "High",
        "dueDate": "2025-02-01"
      },
      {
        "type": "decision",
        "title": "Choose color palette",
        "priority": "Medium"
      },
      {
        "type": "risk",
        "title": "Timeline dependency on vendor",
        "description": "Logo delivery from external vendor may delay launch"
      }
    ]
  }'
```

**Response:**
```json
{
  "status": "ok",
  "createdCount": 3,
  "skippedCount": 0
}
```

### POST /api/gas-proxy

Redirect-safe proxy for Google Apps Script Web Apps. Airtable Automations cannot follow HTTP 302 redirects that GAS returns, so this proxy handles that server-side.

**Headers:**
- `Content-Type: application/json`
- `x-proxy-secret: <AIRTABLE_PROXY_SECRET>`

**Request Body:**
```json
{
  "gasUrl": "https://script.google.com/macros/s/.../exec",
  "mode": "client",
  "clientRecordId": "recABC123",
  "clientName": "Acme Corp",
  "clientType": "prospect",
  "bucketRootFolderId": "1a2B3cDeFgHiJkLmNoPqRsTuVwXyZ"
}
```

- `gasUrl` - Required (or set `GAS_WEB_APP_URL` env var as fallback). Must be a script.google.com /exec URL.
- All other fields are passed through to the GAS endpoint.

**Example Request:**
```bash
curl -X POST https://your-app.vercel.app/api/gas-proxy \
  -H "Content-Type: application/json" \
  -H "x-proxy-secret: your-secret" \
  -d '{
    "gasUrl": "https://script.google.com/macros/s/AKfycb.../exec",
    "mode": "client",
    "clientRecordId": "recABC123",
    "clientName": "Test Client",
    "clientType": "prospect",
    "bucketRootFolderId": "1folder..."
  }'
```

**Success Response:**
Returns whatever the GAS endpoint returns:
```json
{
  "ok": true,
  "folderId": "1xYz789...",
  "folderUrl": "https://drive.google.com/drive/folders/1xYz789..."
}
```

**Error Responses:**
- `401` - Missing or invalid `x-proxy-secret` header
- `400` - Invalid gasUrl or missing required fields
- `502` - GAS returned HTML or non-JSON (includes `bodySnippet` for debugging)

### GET /api/gas-proxy

Health check endpoint.

**Response:**
```json
{ "ok": true, "service": "gas-proxy" }
```

## Features

- **Linked Records:** Automatically resolves or creates Client and Project records
- **Idempotency:** Uses SHA-256 hash of client/project/type/title as external key to prevent duplicates
- **Rate Limiting:** Handles Airtable 429 responses with exponential backoff (max 3 retries)
- **Validation:** Request body validated with Zod

## Airtable Schema

### Clients Table
- `Name` (primary field, text)

### Projects Table
- `Name` (primary field, text)
- `Client` (linked to Clients)

### PM Inbox Table
- `Title` (primary field, text)
- `Item Type` (single select: task, decision, risk)
- `Description` (long text)
- `Owner` (text)
- `Priority` (single select: Low, Medium, High, Critical)
- `Due Date` (date)
- `Client` (linked to Clients)
- `Project` (linked to Projects)
- `Source` (text, defaults to "ChatGPT")
- `Source Timestamp` (date/time)
- `External Key` (text, used for idempotency)
- `Promoted?` (checkbox)
- `Raw Payload` (long text)

## Deploy to Vercel

```bash
vercel
```

Set environment variables in Vercel dashboard or via CLI:
```bash
vercel env add PM_INTAKE_TOKEN
vercel env add AIRTABLE_API_KEY
vercel env add AIRTABLE_BASE_ID
vercel env add AIRTABLE_PROXY_SECRET
vercel env add GAS_WEB_APP_URL  # optional fallback
```
