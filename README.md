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
```
