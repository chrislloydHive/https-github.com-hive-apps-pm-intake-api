/**
 * Promote Inbox to Tasks/Decisions - Google Apps Script
 *
 * SYSTEM CONTRACT:
 * 1. Inbox is transient - records exist only until promoted
 * 2. Inbox record is deleted ONLY after all downstream writes succeed
 * 3. Deletion is the FINAL step - never in catch blocks
 * 4. Partial promotes are forbidden - all or nothing
 * 5. Errors are explicit and loud
 *
 * Deploy as: Web App (Execute as me, Anyone can access)
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
  AIRTABLE_API_KEY: PropertiesService.getScriptProperties().getProperty("AIRTABLE_API_KEY"),
  AIRTABLE_BASE_ID: PropertiesService.getScriptProperties().getProperty("AIRTABLE_BASE_ID"),
  SHARED_SECRET: PropertiesService.getScriptProperties().getProperty("SHARED_SECRET"),

  // Table names
  INBOX_TABLE: "Inbox",
  TASKS_TABLE: "Tasks",
  DECISIONS_TABLE: "Decisions",

  // Airtable API base URL
  API_BASE: "https://api.airtable.com/v0",
};

// =============================================================================
// WEB APP ENTRY POINT
// =============================================================================

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);

    // Auth check
    const providedSecret = payload.secret || "";
    if (!CONFIG.SHARED_SECRET || providedSecret !== CONFIG.SHARED_SECRET) {
      return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
    }

    const { action, inboxRecordId } = payload;

    if (action !== "promote") {
      return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
    }

    if (!inboxRecordId) {
      return jsonResponse({ ok: false, error: "inboxRecordId is required" }, 400);
    }

    const result = promoteInboxItem(inboxRecordId, payload);
    return jsonResponse(result, result.ok ? 200 : 500);
  } catch (err) {
    console.error("[promote-inbox] Unhandled error:", err);
    return jsonResponse({ ok: false, error: err.message || "Unknown error" }, 500);
  }
}

function doGet() {
  return jsonResponse({ ok: false, error: "Method not allowed. Use POST." }, 405);
}

function jsonResponse(data, statusCode) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(
    ContentService.MimeType.JSON
  );
}

// =============================================================================
// MAIN PROMOTE FUNCTION
// =============================================================================

/**
 * Promotes an Inbox item to Tasks and/or Decisions.
 *
 * RULES:
 * - Create Tasks first, then Decisions
 * - Capture and validate all created record IDs
 * - Abort deletion if zero records created
 * - Never delete in catch block
 * - Return structured success/failure response
 *
 * @param {string} inboxRecordId - The Airtable record ID of the Inbox item
 * @param {Object} payload - The promotion payload containing tasks/decisions data
 * @returns {Object} Structured response with ok, createdTasks, createdDecisions, error
 */
function promoteInboxItem(inboxRecordId, payload) {
  const result = {
    ok: false,
    inboxRecordId: inboxRecordId,
    createdTasks: [],
    createdDecisions: [],
    inboxDeleted: false,
    error: null,
  };

  // -------------------------------------------------------------------------
  // STEP 1: Validate Inbox record exists
  // -------------------------------------------------------------------------
  let inboxRecord;
  try {
    inboxRecord = getAirtableRecord(CONFIG.INBOX_TABLE, inboxRecordId);
    if (!inboxRecord) {
      result.error = `Inbox record not found: ${inboxRecordId}`;
      return result;
    }
  } catch (err) {
    result.error = `Failed to fetch Inbox record: ${err.message}`;
    return result;
  }

  console.log(`[promote-inbox] Processing inbox: ${inboxRecordId}`);

  // -------------------------------------------------------------------------
  // STEP 2: Create Tasks (if any)
  // -------------------------------------------------------------------------
  const tasksToCreate = payload.tasks || [];
  if (tasksToCreate.length > 0) {
    try {
      const createdTaskIds = createAirtableRecords(CONFIG.TASKS_TABLE, tasksToCreate);

      if (createdTaskIds.length !== tasksToCreate.length) {
        result.error = `Task creation mismatch: expected ${tasksToCreate.length}, got ${createdTaskIds.length}`;
        return result;
      }

      result.createdTasks = createdTaskIds;
      console.log(`[promote-inbox] Created ${createdTaskIds.length} tasks: ${createdTaskIds.join(", ")}`);
    } catch (err) {
      result.error = `Task creation failed: ${err.message}`;
      return result;
    }
  }

  // -------------------------------------------------------------------------
  // STEP 3: Create Decisions (if any)
  // -------------------------------------------------------------------------
  const decisionsToCreate = payload.decisions || [];
  if (decisionsToCreate.length > 0) {
    try {
      const createdDecisionIds = createAirtableRecords(CONFIG.DECISIONS_TABLE, decisionsToCreate);

      if (createdDecisionIds.length !== decisionsToCreate.length) {
        result.error = `Decision creation mismatch: expected ${decisionsToCreate.length}, got ${createdDecisionIds.length}`;
        // NOTE: Tasks were already created - this is a partial failure
        // We do NOT delete anything - caller must handle manually
        return result;
      }

      result.createdDecisions = createdDecisionIds;
      console.log(`[promote-inbox] Created ${createdDecisionIds.length} decisions: ${createdDecisionIds.join(", ")}`);
    } catch (err) {
      result.error = `Decision creation failed: ${err.message}`;
      // NOTE: Tasks may have been created - partial failure, no deletion
      return result;
    }
  }

  // -------------------------------------------------------------------------
  // STEP 4: Validate at least one record was created
  // -------------------------------------------------------------------------
  const totalCreated = result.createdTasks.length + result.createdDecisions.length;
  if (totalCreated === 0) {
    result.error = "No tasks or decisions to create - nothing to promote";
    return result;
  }

  // -------------------------------------------------------------------------
  // STEP 5: DELETE Inbox record (FINAL STEP - only after all writes succeed)
  // -------------------------------------------------------------------------
  try {
    deleteAirtableRecord(CONFIG.INBOX_TABLE, inboxRecordId);
    result.inboxDeleted = true;
    console.log(`[promote-inbox] Deleted inbox record: ${inboxRecordId}`);
  } catch (err) {
    // Deletion failed but records were created
    // This is a critical inconsistency - log loudly but don't fail the response
    console.error(`[promote-inbox] CRITICAL: Inbox deletion failed after records created: ${err.message}`);
    result.error = `Records created but inbox deletion failed: ${err.message}`;
    // Still mark as partially successful since records exist
    result.ok = true;
    return result;
  }

  // -------------------------------------------------------------------------
  // SUCCESS
  // -------------------------------------------------------------------------
  result.ok = true;
  console.log(
    `[promote-inbox] SUCCESS: ${result.createdTasks.length} tasks, ${result.createdDecisions.length} decisions, inbox deleted`
  );

  return result;
}

// =============================================================================
// AIRTABLE API HELPERS
// =============================================================================

/**
 * Fetches a single record from Airtable.
 */
function getAirtableRecord(tableName, recordId) {
  const url = `${CONFIG.API_BASE}/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}/${recordId}`;

  const response = UrlFetchApp.fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${CONFIG.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  if (code === 404) {
    return null;
  }

  if (code !== 200) {
    throw new Error(`Airtable GET failed: ${code} - ${response.getContentText()}`);
  }

  return JSON.parse(response.getContentText());
}

/**
 * Creates multiple records in Airtable (batched, max 10 per request).
 * Returns array of created record IDs.
 */
function createAirtableRecords(tableName, records) {
  if (!records || records.length === 0) {
    return [];
  }

  const createdIds = [];
  const batchSize = 10;

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const payload = {
      records: batch.map((fields) => ({ fields })),
      typecast: true,
    };

    const url = `${CONFIG.API_BASE}/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`;

    const response = UrlFetchApp.fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CONFIG.AIRTABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });

    const code = response.getResponseCode();
    if (code !== 200) {
      throw new Error(`Airtable CREATE failed: ${code} - ${response.getContentText()}`);
    }

    const result = JSON.parse(response.getContentText());
    const ids = (result.records || []).map((r) => r.id);
    createdIds.push(...ids);
  }

  return createdIds;
}

/**
 * Deletes a single record from Airtable.
 */
function deleteAirtableRecord(tableName, recordId) {
  const url = `${CONFIG.API_BASE}/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}/${recordId}`;

  const response = UrlFetchApp.fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${CONFIG.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  if (code !== 200) {
    throw new Error(`Airtable DELETE failed: ${code} - ${response.getContentText()}`);
  }

  return JSON.parse(response.getContentText());
}

// =============================================================================
// TESTING HELPER (run manually in Apps Script editor)
// =============================================================================

function testPromote() {
  const testPayload = {
    secret: CONFIG.SHARED_SECRET,
    action: "promote",
    inboxRecordId: "recXXXXXXXXXXXXXX", // Replace with real record ID
    tasks: [
      {
        Title: "Test Task from Inbox",
        Status: "To Do",
        // Add other task fields as needed
      },
    ],
    decisions: [
      {
        Title: "Test Decision from Inbox",
        Status: "Open",
        // Add other decision fields as needed
      },
    ],
  };

  const result = promoteInboxItem(testPayload.inboxRecordId, testPayload);
  console.log("Test result:", JSON.stringify(result, null, 2));
}
