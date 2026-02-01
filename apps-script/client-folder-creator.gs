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
// SUBFOLDER TEMPLATES
// =============================================================================

/**
 * Subfolders to create for CLIENT folders (top-level company folders)
 */
var CLIENT_SUBFOLDERS = [
  "1. Strategy & Planning",
  "2. Creative & Assets",
  "3. Campaign Reports",
  "4. Contracts & Finance",
  "5. Meeting Notes"
];

/**
 * Subfolders to create for PROJECT folders (nested under a client)
 */
var PROJECT_SUBFOLDERS = [
  "Assets",
  "Deliverables",
  "Reports",
  "Notes"
];

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
 *   clientPmProjectRecordId: string (required - Client PM OS Projects record ID),
 *   recordId: string (legacy - same as clientPmProjectRecordId),
 *   projectName: string (required),
 *   parentFolderId: string (optional - HIGHEST PRIORITY),
 *   clientType: string (optional - "prospect" triggers NEW_BUSINESS root)
 * }
 *
 * IMPORTANT: Only accept clientPmProjectRecordId. Do NOT accept hiveOsProjectRecordId —
 * Client PM OS automations must pass Client PM OS Projects record ID only.
 */
function doPost(e) {
  try {
    // ==========================================================================
    // PARSE INPUT
    // ==========================================================================
    var raw = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
    var input = JSON.parse(raw);

    Logger.log("Raw input: " + raw);

    // ==========================================================================
    // EXTRACT FIELDS - Canonical: clientPmProjectRecordId (Client PM OS Projects)
    // Support legacy: recordId, clientRecordId, recId. Reject hiveOsProjectRecordId.
    // ==========================================================================
    var clientPmProjectRecordId = input.clientPmProjectRecordId || input.recordId ||
        input.clientRecordId || input.recId || "";
    var projectName = input.projectName || input.clientName || input.name || "";
    var clientType = String(input.clientType || input.type || "").toLowerCase().trim();

    var parentFolderId = input.parentFolderId || input.bucketRootFolderId || input.rootFolderId || "";

    Logger.log("Extracted fields: clientPmProjectRecordId=" + clientPmProjectRecordId +
               ", projectName=" + projectName + ", clientType=" + clientType +
               ", parentFolderId=" + parentFolderId);

    // Reject hiveOsProjectRecordId when used alone — Client PM OS requires clientPmProjectRecordId
    if (!clientPmProjectRecordId && input.hiveOsProjectRecordId) {
      return jsonResponse({
        ok: false,
        error: "hiveOsProjectRecordId cannot be used for Client PM OS automation. Provide clientPmProjectRecordId."
      });
    }

    // ==========================================================================
    // VALIDATION - clientPmProjectRecordId must be present and start with rec
    // ==========================================================================
    if (!clientPmProjectRecordId || clientPmProjectRecordId.trim() === "") {
      return jsonResponse({ ok: false, error: "Missing clientPmProjectRecordId (or recordId)" });
    }
    if (!clientPmProjectRecordId.trim().startsWith("rec")) {
      return jsonResponse({ ok: false, error: "clientPmProjectRecordId must be an Airtable record ID (must start with rec)" });
    }
    clientPmProjectRecordId = clientPmProjectRecordId.trim();

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
    // SEED SUBFOLDERS
    // ==========================================================================
    // Detect request type:
    // - If parentFolderId is provided → project folder (nested under client)
    // - Otherwise → client/prospect folder (top-level)
    var isProjectFolder = parentFolderId && parentFolderId.trim() !== "";
    var subfolderTemplate = isProjectFolder ? PROJECT_SUBFOLDERS : CLIENT_SUBFOLDERS;
    var folderType = isProjectFolder ? "project" : "client";

    Logger.log("Seeding " + folderType + " subfolders: " + subfolderTemplate.join(", "));
    var subfolderResult = ensureSubfolders_(targetFolder, subfolderTemplate);

    // ==========================================================================
    // RESPONSE
    // ==========================================================================
    return jsonResponse({
      ok: true,
      folderId: targetFolder.getId(),
      folderUrl: targetFolder.getUrl(),
      chosenParentId: actualParentId,
      reused: reused,
      // Echo back Client PM OS project ID (never hiveOsProjectRecordId)
      clientPmProjectRecordId: clientPmProjectRecordId,
      recordId: clientPmProjectRecordId,
      projectName: projectName,
      // Debug fields
      _debug: {
        inputParentFolderId: parentFolderId || "(not provided)",
        inputClientType: clientType || "(not provided)",
        routingRule: routingRule,
        parentFolderName: parentFolder.getName(),
        folderType: folderType,
        subfolderTemplate: subfolderTemplate,
        subfoldersCreated: subfolderResult.created,
        subfoldersSkipped: subfolderResult.skipped
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
 * Ensure subfolders exist within a folder
 * Creates them if missing, skips if they already exist
 *
 * @param {Folder} folder - The parent folder to create subfolders in
 * @param {string[]} subfolderNames - Array of subfolder names to ensure
 * @returns {Object} - { created: string[], skipped: string[] }
 */
function ensureSubfolders_(folder, subfolderNames) {
  var result = {
    created: [],
    skipped: []
  };

  for (var i = 0; i < subfolderNames.length; i++) {
    var subfolderName = subfolderNames[i];
    var existing = findChildFolderByName_(folder, subfolderName);

    if (existing) {
      result.skipped.push(subfolderName);
      Logger.log("Subfolder already exists: " + subfolderName);
    } else {
      folder.createFolder(subfolderName);
      result.created.push(subfolderName);
      Logger.log("Created subfolder: " + subfolderName);
    }
  }

  return result;
}

/**
 * Create JSON response for web app
 */
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
