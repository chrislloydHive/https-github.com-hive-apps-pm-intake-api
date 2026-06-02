// Airtable Automation Script — Google Drive Folder Creation
//
// Paste this into an Airtable "Run script" action in an Automation.
//
// Input variables (configure in the Airtable script settings panel):
//   recordId     – input.config().recordId (Client PM OS Projects record ID)
//   clientName   – input.config().clientName (linked Client "Company Name")
//   apiSecret    – input.config().apiSecret (AIRTABLE_PROXY_SECRET — use a secret input, do not hardcode)
//   clientFolderId – optional input.config().clientFolderId (lookup: Client → Drive Folder ID)
//
// Required Airtable fields on the Projects table:
//   "Project Name (Job #)"  – single-line text (used as folder name)
//   "Client"                – linked record to Companies
//   "Drive Folder ID"       – single-line text (written back on success)
//   "Drive Folder URL"      – URL field (written back on success)
//   "Folder Status"         – single-line text (written back: "created", "error")
//   "Folder Error"          – long text (written back on error, cleared on success)
//
// Parent folder resolution (pm-intake-api):
//   1. clientFolderId from automation (Companies."Drive Folder ID" lookup) if set
//   2. Else API loads Project → Client → Companies."Drive Folder ID"
//   3. Else exact match on clientName === Company Name (no prefix search under Car Toys root)

const config = input.config();
const clientPmProjectRecordId = config.recordId;
const clientName = config.clientName || '';
const API_SECRET = config.apiSecret; // Required — map to a secret automation input
const clientFolderIdFromInput = config.clientFolderId || null;

const API_URL = 'https://pm-intake-api.vercel.app/api/create-project-folder';

if (!API_SECRET || typeof API_SECRET !== 'string' || !API_SECRET.trim()) {
    output.text('❌ Missing apiSecret input. Add a secret input mapped to AIRTABLE_PROXY_SECRET.');
    throw new Error('Missing apiSecret');
}

if (!clientPmProjectRecordId || typeof clientPmProjectRecordId !== 'string' ||
    !clientPmProjectRecordId.trim().startsWith('rec')) {
    output.text('❌ Invalid recordId: must be an Airtable record ID (start with rec)');
    throw new Error('Invalid recordId');
}

const table = base.getTable('Projects');
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

// Optional: pass Companies."Drive Folder ID" via automation lookup (recommended)
let clientFolderId = clientFolderIdFromInput;
if (!clientFolderId) {
    const clientLink = record.getCellValue('Client');
    if (clientLink && clientLink.length > 0) {
        const companiesTable = base.getTable('Companies');
        const companyRecord = await companiesTable.selectRecordAsync(clientLink[0].id, {
            fields: ['Drive Folder ID'],
        });
        if (companyRecord) {
            clientFolderId = companyRecord.getCellValueAsString('Drive Folder ID') || null;
        }
    }
}

output.text(`📁 Creating folder for: ${projectName}`);

let result;
let responseStatus;
try {
    const body = {
        clientPmProjectRecordId,
        projectName,
        ...(clientName ? { clientName } : {}),
        ...(clientFolderId ? { clientFolderId } : {}),
    };

    const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_SECRET.trim(),
        },
        body: JSON.stringify(body),
    });

    responseStatus = response.status;
    const responseText = await response.text();
    output.text(`Response status: ${responseStatus}`);

    try {
        result = JSON.parse(responseText);
    } catch (parseErr) {
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

console.log(`[airtable-create-project-folder] clientPmProjectRecordId=${clientPmProjectRecordId}`);

await table.updateRecordAsync(clientPmProjectRecordId, updates);

output.text(result.ok ? `✅ Folder created: ${result.folderUrl}` : `❌ ${result.error}`);
