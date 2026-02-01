// Airtable Automation Script — Google Drive Folder Creation
//
// Paste this into an Airtable "Run script" action in an Automation.
//
// Input variables (configure in the Airtable script settings panel):
//   clientPmProjectRecordId – input.config().recordId (Client PM OS Projects record ID)
//
// Required Airtable fields on the Projects table:
//   "Project Name (Job #)"  – single-line text (used as folder name)
//   "Client"                – linked record (optional, for parentFolderId lookup)
//   "Drive Folder ID"       – single-line text (written back on success)
//   "Drive Folder URL"      – URL field (written back on success)
//   "Folder Status"         – single-line text (written back: "created", "error")
//   "Folder Error"          – long text (written back on error, cleared on success)
//
// Environment:
//   API_URL    – https://pm-intake-api.vercel.app/api/create-project-folder
//   API_SECRET – The AIRTABLE_PROXY_SECRET value (same as in Vercel env)

// ─── Config ──────────────────────────────────────────────────────────
const config = input.config();
const clientPmProjectRecordId = config.recordId; // Client PM OS Projects record ID (current record)

// ⚠️ REPLACE these with your actual values
const API_URL = 'https://pm-intake-api.vercel.app/api/create-project-folder';
const API_SECRET = 'YOUR_AIRTABLE_PROXY_SECRET';  // ← replace with actual secret

// ─── Validate clientPmProjectRecordId ─────────────────────────────────
if (!clientPmProjectRecordId || typeof clientPmProjectRecordId !== 'string' ||
    !clientPmProjectRecordId.trim().startsWith('rec')) {
    output.text(`❌ Invalid clientPmProjectRecordId: must be an Airtable record ID (start with rec)`);
    throw new Error('Invalid clientPmProjectRecordId');
}

// ─── Read record fields ──────────────────────────────────────────────
const table = base.getTable('Projects');  // ← adjust table name if different
const record = await table.selectRecordAsync(clientPmProjectRecordId, {
    fields: ['Project Name (Job #)', 'Client'],
});

if (!record) {
    output.text(`❌ Record ${clientPmProjectRecordId} not found.`);
    throw new Error(`Record ${clientPmProjectRecordId} not found`);
}

const projectName = record.getCellValueAsString('Project Name (Job #)') || '';

if (!projectName) {
    output.text(`❌ Project Name (Job #) is empty for record ${clientPmProjectRecordId}`);
    await table.updateRecordAsync(clientPmProjectRecordId, {
        'Folder Status': 'error',
        'Folder Error': 'Project Name (Job #) is required',
    });
    throw new Error('Project Name (Job #) is required');
}

// Optionally get parent folder from linked Client record
// (implement this if your Clients table has a Drive folder ID)
let parentFolderId = null;
// const clientLink = record.getCellValue('Client');
// if (clientLink && clientLink.length > 0) {
//     const clientTable = base.getTable('Clients');
//     const clientRecord = await clientTable.selectRecordAsync(clientLink[0].id, {
//         fields: ['Drive Folder ID']
//     });
//     if (clientRecord) {
//         parentFolderId = clientRecord.getCellValueAsString('Drive Folder ID') || null;
//     }
// }

output.text(`📁 Creating folder for: ${projectName}`);

// ─── Call API ──────────────────────────────────────────────────────
let result;
let responseStatus;
try {
    const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_SECRET,  // Auth header
        },
        body: JSON.stringify({
            clientPmProjectRecordId,
            projectName,
            ...(parentFolderId ? { parentFolderId } : {}),
        }),
    });

    responseStatus = response.status;
    const responseText = await response.text();

    // Log response status for debugging
    output.text(`Response status: ${responseStatus}`);

    // Try to parse JSON
    try {
        result = JSON.parse(responseText);
    } catch (parseErr) {
        // Log error snippet (first 300 chars) for debugging
        const snippet = responseText.substring(0, 300);
        output.text(`❌ Failed to parse response: ${snippet}`);
        result = {
            ok: false,
            error: `Non-JSON response (status ${responseStatus}): ${snippet}`,
        };
    }
} catch (err) {
    output.text(`❌ Fetch error: ${err.message}`);
    result = {
        ok: false,
        error: `Fetch failed: ${err.message}`,
    };
}

output.text(`Response: ${JSON.stringify(result)}`);

// ─── Write results back to Airtable ─────────────────────────────────
const updates = {
    'Folder Status': result.ok ? 'created' : 'error',
    'Folder Error': result.ok ? '' : (result.error || `Unknown error (status ${responseStatus})`),
};

if (result.ok && result.folderId) {
    updates['Drive Folder ID'] = result.folderId;
}

if (result.ok && result.folderUrl) {
    updates['Drive Folder URL'] = result.folderUrl;
}

// Debug logging: clientPmProjectRecordId, route, table
console.log(`[airtable-create-project-folder] clientPmProjectRecordId=${clientPmProjectRecordId}, route=airtable-create-project-folder, tableName=Projects`);

await table.updateRecordAsync(clientPmProjectRecordId, updates);

output.text(result.ok ? `✅ Folder created: ${result.folderUrl}` : `❌ ${result.error}`);
