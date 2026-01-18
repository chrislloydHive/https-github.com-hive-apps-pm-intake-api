/***********************
 * Doc Generator Web App
 * - Copies a Google Doc template into a Drive folder
 * - Replaces placeholders like {{PROJECT}}, {{CONTENT}}, etc.
 * - Optional: inserts a real Google Docs table for {{INLINE_TABLE}}
 ***********************/

var DEFAULTS = {
  TEMPLATE_DOC_ID: "1f8Zn0Bd62c1RuvUN1k6YKfrrVkYhH6ugXbW9geh29vo",
  EXPORT_PDF: false,
};

/***********************
 * Health check (GET)
 ***********************/
function doGet() {
  return json_({ ok: true, message: "Doc generator web app is live. POST JSON to generate a Doc." });
}

/***********************
 * Main endpoint (POST)
 ***********************/
function doPost(e) {
  try {
    var body = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
    var data = JSON.parse(body);

    // -----------------------------
    // Folder ID normalization
    // -----------------------------
    var folderId =
      data.projectFolderId ||
      data.destinationFolderId ||
      data.destinationFolderID ||
      (e && e.parameter && (e.parameter.projectFolderId || e.parameter.destinationFolderId)) ||
      "";

    if (!folderId) return json_({ ok: false, status: 400, error: "No destination folder (projectFolderId/destinationFolderId missing)" });

    // -----------------------------
    // Template ID normalization
    // Accept: templateId, templateDocId, templateDocID
    // -----------------------------
    var templateDocId =
      data.templateId ||
      data.templateDocId ||
      data.templateDocID ||
      DEFAULTS.TEMPLATE_DOC_ID;

    if (!templateDocId) return json_({ ok: false, status: 400, error: "No templateDocId/templateId provided" });

    // -----------------------------
    // Optional settings
    // -----------------------------
    var exportPdf = (typeof data.exportPdf === "boolean") ? data.exportPdf : DEFAULTS.EXPORT_PDF;

    // -----------------------------
    // Pull structured inputs from common locations
    // -----------------------------
    var structuredInputs =
      data.structuredInputs ||
      (data.content && typeof data.content === "object" ? data.content.structuredInputs : null) ||
      null;

    // Top-level fields
    var project = data.project || data.projectName || (structuredInputs && structuredInputs.project) || "";
    var client  = data.client  || data.clientName  || (structuredInputs && structuredInputs.client)  || "";
    var header  = data.header  || (structuredInputs && structuredInputs.header) || "";
    var shortOverview = data.shortOverview || (structuredInputs && structuredInputs.shortOverview) || "";

    // IMPORTANT: Content can be in multiple places depending on caller
    // - data.content (string)
    // - data.sourceNotes (string)
    // - structuredInputs.content (string)
    // - data.placeholders["{{CONTENT}}"]
    var contentText =
      (typeof data.content === "string" ? data.content : "") ||
      (typeof data.sourceNotes === "string" ? data.sourceNotes : "") ||
      (structuredInputs && structuredInputs.content ? String(structuredInputs.content) : "") ||
      "";

    // If caller passed Airtable-style object content, try common keys
    if (!contentText && data.content && typeof data.content === "object") {
      contentText =
        asStr_(data.content.content) ||
        asStr_(data.content.sourceNotes) ||
        asStr_(data.content.body) ||
        "";
    }

    // Inline table (optional): TSV text to insert where {{INLINE_TABLE}} appears
    var inlineTableText =
      asStr_(data.inlineTable) ||
      (structuredInputs && structuredInputs.inlineTable ? String(structuredInputs.inlineTable) : "") ||
      (data.placeholders && (data.placeholders["{{INLINE_TABLE}}"] || data.placeholders["INLINE_TABLE"])) ||
      "";

    // -----------------------------
    // Build placeholders map
    // If caller provided placeholders, start from that
    // -----------------------------
    var placeholders = {};
    if (data.placeholders && typeof data.placeholders === "object") {
      placeholders = cloneObj_(data.placeholders);
    }

    // FIX: Only use brace-style {{TOKEN}} placeholders (removed non-brace variants)
    setIfEmpty_(placeholders, "{{PROJECT}}", project);
    setIfEmpty_(placeholders, "{{CLIENT}}", client);
    setIfEmpty_(placeholders, "{{HEADER}}", header);
    setIfEmpty_(placeholders, "{{SHORT_OVERVIEW}}", shortOverview);

    // Content is required for most templates; if your template truly doesn't need it,
    // you can pass " " (space) so replaceText works
    if (!contentText) contentText = " ";
    setIfEmpty_(placeholders, "{{CONTENT}}", contentText);

    // Generated timestamp (optional)
    var generatedAt =
      data.generatedAt ||
      (structuredInputs && structuredInputs.generatedAt) ||
      data.date ||
      "";

    // FIX: Only brace-style placeholders for dates (removed non-brace variants)
    if (generatedAt) {
      setIfEmpty_(placeholders, "{{GENERATED_AT}}", generatedAt);
      setIfEmpty_(placeholders, "{{DATE}}", generatedAt);
    }

    // -----------------------------
    // Choose a doc name
    // -----------------------------
    var docName =
      data.docName ||
      data.fileName ||
      data.docTitle ||
      (project ? (project + " - " + (data.docType || "Doc")) : "Generated Document");

    // -----------------------------
    // Create doc from template + replace placeholders
    // -----------------------------
    var result = createDocFromTemplate_SimplePlaceholders_({
      templateDocId: templateDocId,
      destinationFolderId: folderId,
      fileName: docName,
      placeholders: placeholders,
      exportPdf: exportPdf,
      inlineTableText: inlineTableText,
    });

    // FIX: Corrected syntax error (was: return json{ )
    return json_({
      ok: true,
      status: 200,
      docId: result.docId,
      docUrl: result.docUrl,
      pdfId: result.pdfId || "",
      pdfUrl: result.pdfUrl || "",
    });

  } catch (err) {
    return json_({ ok: false, status: 500, error: String(err && err.stack ? err.stack : err) });
  }
}

/***********************
 * Copy template + replace placeholders map
 * Also supports inserting an INLINE_TABLE if template contains {{INLINE_TABLE}}
 ***********************/
function createDocFromTemplate_SimplePlaceholders_(opts) {
  var folder = DriveApp.getFolderById(opts.destinationFolderId);
  var templateFile = DriveApp.getFileById(opts.templateDocId);

  var newFile = templateFile.makeCopy(opts.fileName, folder);
  var docId = newFile.getId();
  var doc = DocumentApp.openById(docId);
  var body = doc.getBody();

  // FIX: Get header and footer sections for replacement
  var headerSection = doc.getHeader();
  var footerSection = doc.getFooter();

  var placeholders = opts.placeholders || {};

  // FIX: Remove {{INLINE_TABLE}} from placeholders to prevent text replacement
  // Table insertion is handled separately below
  delete placeholders["{{INLINE_TABLE}}"];
  delete placeholders["INLINE_TABLE"];

  // FIX: Sort placeholder keys by length descending to prevent partial replacements
  // e.g., {{PROJECT}} won't break {{PROJECT_NUMBER}} if we replace longer keys first
  var sortedKeys = Object.keys(placeholders).sort(function(a, b) {
    return b.length - a.length;
  });

  // FIX: Only process brace-style {{TOKEN}} placeholders
  for (var i = 0; i < sortedKeys.length; i++) {
    var key = sortedKeys[i];
    if (!placeholders.hasOwnProperty(key)) continue;
    // Skip non-brace keys (only allow {{...}} format)
    if (key.indexOf("{{") !== 0 || key.indexOf("}}") !== key.length - 2) continue;

    var value = String(placeholders[key] == null ? "" : placeholders[key]);
    // FIX: Replace in body, header, and footer
    replaceAllText_(body, key, value);
    if (headerSection) replaceAllText_(headerSection, key, value);
    if (footerSection) replaceAllText_(footerSection, key, value);
  }

  // Optional: Insert a real table where {{INLINE_TABLE}} is found
  // FIX: Insert table BEFORE any text replacement of the anchor (handled above by deleting from placeholders)
  var inlineTableText = String(opts.inlineTableText || "").trim();
  if (inlineTableText) {
    // FIX: Only use brace-style anchor (removed INLINE_TABLE without braces)
    insertTableAtAnchorFromTSV_(body, "{{INLINE_TABLE}}", inlineTableText);
  }

  doc.saveAndClose();

  var out = { docId: docId, docUrl: newFile.getUrl() };

  if (opts.exportPdf === true) {
    var pdfBlob = DriveApp.getFileById(docId).getBlob().getAs("application/pdf");
    var pdfFile = folder.createFile(pdfBlob).setName(opts.fileName + ".pdf");
    out.pdfId = pdfFile.getId();
    out.pdfUrl = pdfFile.getUrl();
  }

  return out;
}

/***********************
 * Replace text everywhere in a document section (body, header, or footer)
 ***********************/
function replaceAllText_(section, findText, replaceWith) {
  // FIX: Corrected typo (was: fiText)
  if (!findText) return;
  // FIX: Escape $ in replacement value; Google Docs replaceText treats $ as special regex backreference
  var safeReplacement = String(replaceWith || "").replace(/\$/g, "$$$$");
  section.replaceText(escapeForRegex_(findText), safeReplacement);
}

function escapeForRegex_(s) {
  // FIX: Corrected replacement string (was: "\\[Pasted text #2 +310 lines]")
  // Escapes all regex special characters so findText is treated as literal
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/***********************
 * Insert a table at an anchor token, parsing TSV text
 * TSV format:
 * Header1\tHeader2\tHeader3
 * row1col1\trow1col2\trow1col3
 ***********************/
function insertTableAtAnchorFromTSV_(body, anchor, tsvText) {
  var p = findAnchorParagraph_(body, anchor);
  if (!p) return;

  var rows = tsvText.split(/\r?\n/).filter(function (l) { return l.trim() !== ""; });
  if (!rows.length) {
    // FIX: Still remove anchor paragraph even if no table data
    clearParagraph_(p);
    return;
  }

  var tableData = rows.map(function (line) {
    // prefer tabs; fallback to multiple spaces
    if (line.indexOf("\t") >= 0) return line.split("\t").map(trimCell_);
    // if user pasted pipe table
    if (line.indexOf("|") >= 0) return line.split("|").map(trimCell_).filter(function(x){return x!=="";});
    return [line.trim()];
  });

  var idx = body.getChildIndex(p);
  var table = body.insertTable(idx + 1, tableData);

  // Bold header row
  if (table.getNumRows() > 0) {
    var headerRow = table.getRow(0);
    for (var c = 0; c < headerRow.getNumCells(); c++) {
      headerRow.getCell(c).editAsText().setBold(true);
    }
  }

  // FIX: Remove anchor paragraph AFTER inserting table (not before)
  // This ensures the table is placed correctly and anchor is fully removed
  body.removeChild(p);
}

function trimCell_(s) {
  return String(s == null ? "" : s).trim();
}

function findAnchorParagraph_(body, anchor) {
  var r = body.findText(anchor);
  if (!r) return null;
  var el = r.getElement();
  while (el && el.getType && el.getType() !== DocumentApp.ElementType.PARAGRAPH) {
    el = el.getParent();
  }
  return el ? el.asParagraph() : null;
}

function clearParagraph_(p) {
  var t = p.editAsText();
  t.setText("");
}

/***********************
 * Small helpers
 ***********************/
function asStr_(v) {
  return (v === undefined || v === null) ? "" : String(v);
}

function cloneObj_(o) {
  var out = {};
  for (var k in o) if (o.hasOwnProperty(k)) out[k] = o[k];
  return out;
}

function setIfEmpty_(obj, key, value) {
  if (obj[key] === undefined || obj[key] === null || String(obj[key]).trim() === "") {
    obj[key] = value;
  }
}

/***********************
 * JSON helper
 ***********************/
function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
