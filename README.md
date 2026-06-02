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

### POST /api/create-project-folder

Creates Google Drive project folders via Google Apps Script proxy. Handles the 302 redirect that Airtable Automations cannot follow.

**Identifier:** `clientPmProjectRecordId` — the Client PM OS Projects record ID (must start with `rec`). Do NOT pass `hiveOsProjectRecordId` — Client PM OS endpoints require the Client PM OS Projects record ID only.

**Headers:**
- `Content-Type: application/json`
- `x-api-key: <AIRTABLE_PROXY_SECRET>` (or `Authorization: Bearer <AIRTABLE_PROXY_SECRET>`)

**Request Body:**
```json
{
  "clientPmProjectRecordId": "recABC123",
  "projectName": "294CAR-OR Portland Search Campaign",
  "clientName": "Car Toys Oregon",
  "clientFolderId": "1g4vXY191HJ0Btw6zFY9WwxvgGsfli4fC"
}
```

- `clientPmProjectRecordId` — Required. Client PM OS Projects record ID (must start with `rec`). Legacy: `recordId` accepted. Do NOT pass HIVE OS record IDs.
- `projectName` — Required. Name for the project folder (Job # + title).
- `clientName` — Recommended. Exact `Company Name` on Companies (used only if Project→Client link is missing).
- `clientFolderId` — Optional but recommended. The client's **Projects** folder id from Companies `Drive Folder ID`. When omitted, the API resolves it from Airtable (Project → Client link, then exact company name). **Never** searches Drive by client name under a shared root (avoids prefix collisions like "Car Toys Oregon" under "Car Toys").
- `parentFolderId` — Legacy alias for `clientFolderId`.

Parent folder resolution order: `clientFolderId` / `parentFolderId` → Project `Client` link → exact `Company Name` match. There is no fallback to a hardcoded clients root.

**Example Request:**
```bash
curl -X POST https://pm-intake-api.vercel.app/api/create-project-folder \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret" \
  -d '{
    "clientPmProjectRecordId": "recABC123",
    "projectName": "Acme Corp - Website Redesign"
  }'
```

**Success Response:**
```json
{
  "ok": true,
  "folderId": "1xYz789...",
  "folderUrl": "https://drive.google.com/drive/folders/1xYz789...",
  "reused": false,
  "clientPmProjectRecordId": "recABC123",
  "projectName": "Acme Corp - Website Redesign"
}
```

**Error Responses:**
- `401` - Missing or invalid `x-api-key` / Bearer token
- `400` - Missing or invalid `clientPmProjectRecordId`, or record not found in Client PM OS Projects, or `hiveOsProjectRecordId` passed (rejected)
- `500` - Apps Script error or base not configured

**Airtable Automation Script:**
See `scripts/airtable-create-project-folder.js` for a ready-to-use automation script. Map `apiSecret` to a secret input (do not hardcode `AIRTABLE_PROXY_SECRET` in the script).

**Prefix-collision manual test (Car Toys vs Car Toys Oregon):**
```bash
# Oregon project must land under Oregon's Projects folder, not inside Car Toys root
curl -X POST https://pm-intake-api.vercel.app/api/create-project-folder \
  -H "Content-Type: application/json" \
  -H "x-api-key: $AIRTABLE_PROXY_SECRET" \
  -d '{"clientPmProjectRecordId":"recYOUR_PROJECT","projectName":"TEST Oregon","clientName":"Car Toys Oregon"}'
```
Unit tests: `npm test` → `lib/resolveClientProjectsFolder.test.ts`.

---

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
  "clientPmProjectRecordId": "recABC123",
  "clientName": "Acme Corp",
  "clientType": "prospect",
  "bucketRootFolderId": "1a2B3cDeFgHiJkLmNoPqRsTuVwXyZ"
}
```

- `gasUrl` — Required (or set `GAS_WEB_APP_URL` env var as fallback). Must be a script.google.com /exec URL.
- `clientPmProjectRecordId` — When creating project/client folders: Client PM OS Projects record ID (must start with `rec`). Legacy: `recordId`. Do NOT pass `hiveOsProjectRecordId`.
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
