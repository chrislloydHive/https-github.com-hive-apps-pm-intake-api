/**
 * Client Folder Creator - Google Apps Script Web App
 *
 * Creates client/project folders in Google Drive.
 *
 * PRIORITY ORDER for parent folder selection:
 * 1. parentFolderId (HIGHEST - if provided, ALWAYS use it)
 * 2. clientType === "prospect" → NEW_BUSINESS_ROOT_FOLDER_ID
 * 3. WORK_ROOT_FOLDER_ID (default)
 *
 * If a folder with the same name already exists under the chosen parent,
 * it will be reused instead of creating a duplicate.
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
 *
 * Expected payload:
 * {
 *   recordId: string (required),
 *   projectName: string (required),
 *   parentFolderId: string (optional - HIGHEST PRIORITY),
 *   clientType: string (optional - "prospect" triggers NEW_BUSINESS root)
 * }
 */
function doPost(e) {
  try {
    // ==========================================================================
    // PARSE INPUT
    // ==========================================================================
    var raw = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
    var input = JSON.parse(raw);

    // Log raw input for debugging
    Logger.log("Raw input: " + raw);

    // ==========================================================================
    // EXTRACT FIELDS - Support multiple naming conventions
    // ==========================================================================
    var recordId = input.recordId || input.clientRecordId || input.recId || "";
    var projectName = input.projectName || input.clientName || input.name || "";
    var clientType = String(input.clientType || input.type || "").toLowerCase().trim();

    // CRITICAL: parentFolderId takes HIGHEST PRIORITY
    // Check all possible field names
    var parentFolderId = input.parentFolderId || input.bucketRootFolderId || input.rootFolderId || "";

    Logger.log("Extracted fields: recordId=" + recordId + ", projectName=" + projectName +
               ", clientType=" + clientType + ", parentFolderId=" + parentFolderId);

    // ==========================================================================
    // VALIDATION
    // ==========================================================================
    if (!recordId) {
      return jsonResponse({ ok: false, error: "Missing recordId" });
    }

    if (!projectName) {
      return jsonResponse({ ok: false, error: "Missing projectName" });
    }

    // ==========================================================================
    // DETERMINE PARENT FOLDER - parentFolderId has ABSOLUTE PRIORITY
    // ==========================================================================
    var chosenParentId;
    var routingRule;

    // RULE 1: If parentFolderId is provided, ALWAYS use it - no exceptions
    if (parentFolderId && parentFolderId.trim() !== "") {
      chosenParentId = parentFolderId.trim();
      routingRule = "explicit-parentFolderId";
      Logger.log("Using explicit parentFolderId: " + chosenParentId);
    }
    // RULE 2: Prospects go to NEW_BUSINESS (only if no parentFolderId)
    else if (clientType === "prospect") {
      chosenParentId = CONFIG.NEW_BUSINESS_ROOT_FOLDER_ID;
      routingRule = "derived-prospect";
      Logger.log("Using prospect root: " + chosenParentId);
    }
    // RULE 3: Default to WORK root (only if no parentFolderId)
    else {
      chosenParentId = CONFIG.WORK_ROOT_FOLDER_ID;
      routingRule = "derived-default";
      Logger.log("Using default work root: " + chosenParentId);
    }

    // ==========================================================================
    // GET PARENT FOLDER
    // ==========================================================================
    var parentFolder;
    var actualParentId = chosenParentId;

    try {
      parentFolder = DriveApp.getFolderById(chosenParentId);
      Logger.log("Successfully got parent folder: " + parentFolder.getName());
    } catch (folderErr) {
      // Only fall back if NOT using explicit parentFolderId
      // If explicit parentFolderId fails, that's an error - don't silently create elsewhere
      if (routingRule === "explicit-parentFolderId") {
        return jsonResponse({
          ok: false,
          error: "Cannot access specified parentFolderId: " + chosenParentId,
          detail: String(folderErr.message || folderErr)
        });
      }

      // For derived routes, fall back to root
      Logger.log("Warning: Could not access folder " + chosenParentId + ", falling back to root");
      parentFolder = DriveApp.getRootFolder();
      actualParentId = parentFolder.getId();
      routingRule = "fallback-root";
    }

    // ==========================================================================
    // CHECK FOR EXISTING FOLDER (reuse if exists under this parent)
    // ==========================================================================
    var existingFolder = findChildFolderByName_(parentFolder, projectName);
    var reused = false;
    var targetFolder;

    if (existingFolder) {
      targetFolder = existingFolder;
      reused = true;
      Logger.log("Reusing existing folder: " + targetFolder.getName() + " (" + targetFolder.getId() + ")");
    } else {
      targetFolder = parentFolder.createFolder(projectName);
      Logger.log("Created new folder: " + targetFolder.getName() + " (" + targetFolder.getId() + ")");
    }

    // ==========================================================================
    // RESPONSE
    // ==========================================================================
    return jsonResponse({
      ok: true,
      folderId: targetFolder.getId(),
      folderUrl: targetFolder.getUrl(),
      chosenParentId: actualParentId,
      reused: reused,
      // Echo back for confirmation
      recordId: recordId,
      projectName: projectName,
      // Debug fields
      _debug: {
        inputParentFolderId: parentFolderId || "(not provided)",
        inputClientType: clientType || "(not provided)",
        routingRule: routingRule,
        parentFolderName: parentFolder.getName()
      }
    });

  } catch (err) {
    Logger.log("Error: " + String(err.message || err));
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

/**
 * Find a child folder by name within a parent folder
 * Returns the folder if found, null otherwise
 *
 * @param {Folder} parentFolder - The parent folder to search in
 * @param {string} folderName - The name to search for
 * @returns {Folder|null} - The found folder or null
 */
function findChildFolderByName_(parentFolder, folderName) {
  try {
    var folders = parentFolder.getFoldersByName(folderName);
    if (folders.hasNext()) {
      return folders.next();
    }
  } catch (e) {
    Logger.log("Error searching for folder: " + e);
  }
  return null;
}

/**
 * Create JSON response for web app
 */
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
