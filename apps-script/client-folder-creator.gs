/**
 * Client Folder Creator - Google Apps Script Web App
 *
 * Creates client/project folders in Google Drive with deterministic routing:
 * 1. If bucketRootFolderId provided → use it (explicit)
 * 2. If clientType === "prospect" → NEW_BUSINESS_ROOT_FOLDER_ID (derived)
 * 3. Otherwise → WORK_ROOT_FOLDER_ID (default)
 *
 * Deploy as: Web App → Execute as: Me → Access: Anyone
 */

// =============================================================================
// CONFIGURATION - Set these folder IDs for your Google Drive
// =============================================================================
var CONFIG = {
  // Default root folder for active client work
  WORK_ROOT_FOLDER_ID: "YOUR_WORK_FOLDER_ID_HERE",

  // Root folder for prospects/new business
  NEW_BUSINESS_ROOT_FOLDER_ID: "YOUR_NEW_BUSINESS_FOLDER_ID_HERE"
};

// =============================================================================
// WEB APP ENDPOINTS
// =============================================================================

/**
 * Health check
 */
function doGet() {
  return jsonResponse({ ok: true, service: "client-folder-creator" });
}

/**
 * Main handler - creates folder in correct location
 */
function doPost(e) {
  try {
    // Parse input
    var raw = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
    var input = JSON.parse(raw);

    // ==========================================================================
    // NORMALIZE INPUT - Support multiple field naming conventions
    // ==========================================================================
    var data = {
      // Record ID (required)
      recordId: input.recordId || input.clientRecordId || input.recId || "",

      // Project/Client name (required)
      projectName: input.projectName || input.clientName || input.name || "",

      // Client type for routing (optional)
      clientType: String(input.clientType || input.type || "").toLowerCase().trim(),

      // Explicit parent folder override (optional - highest priority)
      bucketRootFolderId: input.bucketRootFolderId || input.parentFolderId || input.rootFolderId || ""
    };

    // ==========================================================================
    // VALIDATION
    // ==========================================================================
    if (!data.recordId) {
      return jsonResponse({ ok: false, error: "Missing recordId" });
    }

    if (!data.projectName) {
      return jsonResponse({ ok: false, error: "Missing projectName" });
    }

    // ==========================================================================
    // DETERMINISTIC FOLDER ROUTING - The core fix
    // ==========================================================================
    var routingRule = "default";
    var rootFolderId;

    // Rule 1: Explicit bucketRootFolderId always wins
    if (data.bucketRootFolderId) {
      rootFolderId = data.bucketRootFolderId;
      routingRule = "explicit";
    }
    // Rule 2: Prospects go to NEW_BUSINESS
    else if (data.clientType === "prospect") {
      rootFolderId = CONFIG.NEW_BUSINESS_ROOT_FOLDER_ID;
      routingRule = "derived-prospect";
    }
    // Rule 3: Everything else goes to WORK
    else {
      rootFolderId = CONFIG.WORK_ROOT_FOLDER_ID;
      routingRule = "derived-default";
    }

    // ==========================================================================
    // CREATE FOLDER
    // ==========================================================================
    var parentFolder = DriveApp.getFolderById(rootFolderId);
    var newFolder = parentFolder.createFolder(data.projectName);

    // ==========================================================================
    // RESPONSE - Include debug info (remove in production)
    // ==========================================================================
    return jsonResponse({
      ok: true,
      // Standard fields
      folderId: newFolder.getId(),
      folderUrl: newFolder.getUrl(),
      // Echo back for confirmation
      recordId: data.recordId,
      projectName: data.projectName,
      // Debug fields (remove after verification)
      _debug: {
        resolvedRootFolderId: rootFolderId,
        clientType: data.clientType || "(not provided)",
        bucketRootFolderId: data.bucketRootFolderId || "(not provided)",
        routingRule: routingRule
      }
    });

  } catch (err) {
    return jsonResponse({
      ok: false,
      error: String(err.message || err),
      stack: String(err.stack || "")
    });
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
