var DEFAULTS = {
  TEMPLATE_DOC_ID: "1f8Zn0Bd62c1RuvUN1k6YKfrrVkYhH6ugXbW9geh29vo",
  EXPORT_PDF: false
};

// Debug/helper labels that should be stripped from content
var DEBUG_LABELS_TO_STRIP = [
  "Inline table provided as source:",
  "Inline table provided as source",
  "Source notes:",
  "Source notes",
  "Content:"
];

// Tokens that use anchor insertion (NOT replaceText)
var ANCHOR_TOKENS = ["{{CONTENT}}", "{{INLINE_TABLE}}"];

function doGet() {
  return json_({ ok: true, message: "Doc generator web app is live." });
}

function doPost(e) {
  try {
    var body = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
    var data = JSON.parse(body);

    var folderId =
      data.projectFolderId ||
      data.destinationFolderId ||
      data.destinationFolderID ||
      (e && e.parameter && (e.parameter.projectFolderId || e.parameter.destinationFolderId)) ||
      "";

    if (!folderId) {
      return json_({ ok: false, status: 400, error: "No destination folder" });
    }

    var templateDocId =
      data.templateId ||
      data.templateDocId ||
      data.templateDocID ||
      DEFAULTS.TEMPLATE_DOC_ID;

    if (!templateDocId) {
      return json_({ ok: false, status: 400, error: "No templateDocId provided" });
    }

    var exportPdf = (typeof data.exportPdf === "boolean") ? data.exportPdf : DEFAULTS.EXPORT_PDF;

    var structuredInputs =
      data.structuredInputs ||
      (data.content && typeof data.content === "object" ? data.content.structuredInputs : null) ||
      null;

    var project = data.project || data.projectName || (structuredInputs && structuredInputs.project) || "";
    var client = data.client || data.clientName || (structuredInputs && structuredInputs.client) || "";
    var header = data.header || (structuredInputs && structuredInputs.header) || "";
    var shortOverview = data.shortOverview || (structuredInputs && structuredInputs.shortOverview) || "";

    // FIX: Check multiple sources for content, including placeholders object
    var contentText =
      (typeof data.content === "string" ? data.content : "") ||
      (typeof data.sourceNotes === "string" ? data.sourceNotes : "") ||
      (structuredInputs && structuredInputs.content ? String(structuredInputs.content) : "") ||
      (data.placeholders && (data.placeholders["{{CONTENT}}"] || data.placeholders["CONTENT"])) ||
      "";

    if (!contentText && data.content && typeof data.content === "object") {
      contentText =
        asStr_(data.content.content) ||
        asStr_(data.content.sourceNotes) ||
        asStr_(data.content.body) ||
        "";
    }

    // Debug: log content source
    var contentSource = "none";
    if (typeof data.content === "string" && data.content) contentSource = "data.content";
    else if (typeof data.sourceNotes === "string" && data.sourceNotes) contentSource = "data.sourceNotes";
    else if (structuredInputs && structuredInputs.content) contentSource = "structuredInputs.content";
    else if (data.placeholders && data.placeholders["{{CONTENT}}"]) contentSource = "placeholders.CONTENT";

    var inlineTableText =
      asStr_(data.inlineTable) ||
      (structuredInputs && structuredInputs.inlineTable ? String(structuredInputs.inlineTable) : "") ||
      (data.placeholders && (data.placeholders["{{INLINE_TABLE}}"] || data.placeholders["INLINE_TABLE"])) ||
      "";

    // Strip debug/helper labels from content text
    contentText = stripDebugLabels_(contentText);

    // If inlineTableText is present, remove it from contentText to prevent duplicate rendering
    if (inlineTableText && contentText) {
      contentText = removeInlineTableFromContent_(contentText, inlineTableText);
    }

    // Normalize whitespace - collapse multiple newlines, trim edges
    contentText = normalizeWhitespace_(contentText);

    // Build placeholders map for replaceText (excludes CONTENT and INLINE_TABLE)
    var placeholders = {};
    if (data.placeholders && typeof data.placeholders === "object") {
      placeholders = cloneObj_(data.placeholders);
    }

    setIfEmpty_(placeholders, "{{PROJECT}}", project);
    setIfEmpty_(placeholders, "{{CLIENT}}", client);
    setIfEmpty_(placeholders, "{{HEADER}}", header);
    setIfEmpty_(placeholders, "{{SHORT_OVERVIEW}}", shortOverview);

    var generatedAt =
      data.generatedAt ||
      (structuredInputs && structuredInputs.generatedAt) ||
      data.date ||
      "";

    if (generatedAt) {
      setIfEmpty_(placeholders, "{{GENERATED_AT}}", generatedAt);
      setIfEmpty_(placeholders, "{{DATE}}", generatedAt);
    }

    var docName =
      data.docName ||
      data.fileName ||
      data.docTitle ||
      (project ? (project + " - " + (data.docType || "Doc")) : "Generated Document");

    var result = createDocFromTemplate_({
      templateDocId: templateDocId,
      destinationFolderId: folderId,
      fileName: docName,
      placeholders: placeholders,
      contentText: contentText,
      contentSource: contentSource,
      inlineTableText: inlineTableText,
      exportPdf: exportPdf
    });

    return json_({
      ok: true,
      status: 200,
      docId: result.docId,
      docUrl: result.docUrl,
      pdfId: result.pdfId || "",
      pdfUrl: result.pdfUrl || "",
      debug: result.debug
    });

  } catch (err) {
    return json_({ ok: false, status: 500, error: String(err && err.stack ? err.stack : err) });
  }
}

// =============================================================================
// Main document creation function
// =============================================================================
function createDocFromTemplate_(opts) {
  var folder = DriveApp.getFolderById(opts.destinationFolderId);
  var templateFile = DriveApp.getFileById(opts.templateDocId);

  var newFile = templateFile.makeCopy(opts.fileName, folder);
  var docId = newFile.getId();
  var doc = DocumentApp.openById(docId);
  var body = doc.getBody();

  var headerSection = doc.getHeader();
  var footerSection = doc.getFooter();

  // Debug output structure
  var debug = {
    foundContentAnchor: false,
    contentParagraphCountInserted: 0,
    contentSource: opts.contentSource || "unknown",
    contentLength: opts.contentText ? opts.contentText.length : 0,
    foundInlineTableAnchor: false,
    inlineTableRowsInserted: 0,
    foundHeader: headerSection !== null,
    headerStillHasProjectToken: false,
    remainingTokensFound: []
  };

  var placeholders = opts.placeholders || {};

  // Remove anchor tokens from placeholders - they are handled separately
  for (var i = 0; i < ANCHOR_TOKENS.length; i++) {
    delete placeholders[ANCHOR_TOKENS[i]];
    delete placeholders[ANCHOR_TOKENS[i].replace(/[{}]/g, "")]; // Also remove non-brace version
  }

  // Sort placeholder keys by length descending to prevent partial replacements
  var sortedKeys = Object.keys(placeholders).sort(function(a, b) {
    return b.length - a.length;
  });

  // Replace placeholders using replaceText (NOT for CONTENT or INLINE_TABLE)
  for (var j = 0; j < sortedKeys.length; j++) {
    var key = sortedKeys[j];
    if (!placeholders.hasOwnProperty(key)) continue;
    if (key.indexOf("{{") !== 0 || key.indexOf("}}") !== key.length - 2) continue;

    var value = String(placeholders[key] == null ? "" : placeholders[key]);

    // Replace in body
    if (body.findText(escapeForRegex_(key))) {
      replaceAllText_(body, key, value);
    }
    // Replace in header
    if (headerSection && headerSection.findText(escapeForRegex_(key))) {
      replaceAllText_(headerSection, key, value);
    }
    // Replace in footer
    if (footerSection && footerSection.findText(escapeForRegex_(key))) {
      replaceAllText_(footerSection, key, value);
    }
  }

  // TASK 1: Insert {{CONTENT}} using anchor insertion (real paragraphs)
  var contentText = String(opts.contentText || "").trim();
  if (contentText) {
    var contentResult = insertContentAtAnchor_(body, "{{CONTENT}}", contentText);
    debug.foundContentAnchor = contentResult.found;
    debug.contentParagraphCountInserted = contentResult.paragraphsInserted;
  }

  // TASK 2: Insert {{INLINE_TABLE}} as a real table
  var inlineTableText = String(opts.inlineTableText || "").trim();
  if (inlineTableText) {
    var tableResult = insertTableAtAnchor_(body, "{{INLINE_TABLE}}", inlineTableText);
    debug.foundInlineTableAnchor = tableResult.found;
    debug.inlineTableRowsInserted = tableResult.rowsInserted;
  }

  // TASK 4: Check if header still contains {{PROJECT}} (may be in drawing/text box)
  if (headerSection) {
    var headerText = "";
    try {
      headerText = headerSection.getText();
    } catch (e) {
      // Ignore - some headers may not support getText
    }
    debug.headerStillHasProjectToken = headerText.indexOf("{{PROJECT}}") !== -1;
  }

  // Clean up any leftover {{CONTENT}} tokens that might remain
  removeLeftoverToken_(body, "{{CONTENT}}");

  // Clean up any empty paragraphs that may have been left behind
  cleanupEmptyParagraphs_(body);

  // TASK 5: Find any remaining tokens for debug output
  debug.remainingTokensFound = findRemainingTokens_(body, headerSection, footerSection);

  doc.saveAndClose();

  var out = {
    docId: docId,
    docUrl: newFile.getUrl(),
    debug: debug
  };

  if (opts.exportPdf === true) {
    var pdfBlob = DriveApp.getFileById(docId).getBlob().getAs("application/pdf");
    var pdfFile = folder.createFile(pdfBlob).setName(opts.fileName + ".pdf");
    out.pdfId = pdfFile.getId();
    out.pdfUrl = pdfFile.getUrl();
  }

  return out;
}

// =============================================================================
// TASK 1: Anchor insertion for {{CONTENT}}
// Inserts content as real paragraphs with formatting support
// =============================================================================
function insertContentAtAnchor_(body, anchor, contentText) {
  var result = { found: false, paragraphsInserted: 0 };

  // Find the paragraph containing the anchor
  var searchResult = body.findText(escapeForRegex_(anchor));
  if (!searchResult) return result;

  result.found = true;

  var element = searchResult.getElement();
  var paragraph = null;

  // Walk up to find the paragraph
  while (element && element.getType() !== DocumentApp.ElementType.PARAGRAPH) {
    element = element.getParent();
  }
  if (!element) return result;

  paragraph = element.asParagraph();
  var paragraphIndex = body.getChildIndex(paragraph);
  var paragraphText = paragraph.getText();

  // Check if the paragraph contains ONLY the anchor token
  var trimmedText = paragraphText.trim();
  var anchorOnly = (trimmedText === anchor);

  if (anchorOnly) {
    // Remove the entire anchor paragraph - we'll insert content after previous element
    // But first, get the index
    body.removeChild(paragraph);
    // Adjust index since we removed the paragraph
    var insertIndex = paragraphIndex;

    // Insert content paragraphs
    result.paragraphsInserted = insertContentParagraphs_(body, insertIndex, contentText);
  } else {
    // Paragraph has other text - just remove the token text
    var newText = paragraphText.replace(anchor, "");
    paragraph.setText(newText);

    // Insert content paragraphs after this paragraph
    result.paragraphsInserted = insertContentParagraphs_(body, paragraphIndex + 1, contentText);
  }

  return result;
}

// =============================================================================
// Insert content as real paragraphs with bullet and heading support
// =============================================================================
function insertContentParagraphs_(body, startIndex, contentText) {
  var lines = contentText.split(/\r?\n/);
  var insertedCount = 0;
  var currentIndex = startIndex;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // Skip completely empty lines but preserve intentional blank paragraphs
    // (consecutive blank lines become a single blank paragraph)
    if (line.trim() === "") {
      // Only insert blank paragraph if previous line wasn't also blank
      if (i > 0 && lines[i - 1].trim() !== "") {
        body.insertParagraph(currentIndex, "");
        currentIndex++;
        insertedCount++;
      }
      continue;
    }

    var lineInfo = parseLineFormatting_(line);
    var paragraph = body.insertParagraph(currentIndex, lineInfo.text);

    // Apply heading style if detected
    if (lineInfo.heading) {
      paragraph.setHeading(lineInfo.heading);
    }

    // Apply bullet/list formatting if detected
    if (lineInfo.isBullet) {
      paragraph.setListId(null); // Reset any existing list
      try {
        // Try to set as bullet list item
        paragraph.setGlyphType(DocumentApp.GlyphType.BULLET);
      } catch (e) {
        // If setGlyphType fails, keep the bullet character in text
        // (already preserved in lineInfo.text for fallback)
      }
    }

    currentIndex++;
    insertedCount++;
  }

  return insertedCount;
}

// =============================================================================
// Parse line for formatting (headings, bullets)
// =============================================================================
function parseLineFormatting_(line) {
  var result = {
    text: line,
    heading: null,
    isBullet: false
  };

  var trimmed = line.trim();

  // Check for markdown-style headings: # Heading, ## Heading, ### Heading
  var headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    var hashCount = headingMatch[1].length;
    result.text = headingMatch[2];

    // Map # count to Google Docs heading levels
    if (hashCount === 1) {
      result.heading = DocumentApp.ParagraphHeading.HEADING1;
    } else if (hashCount === 2) {
      result.heading = DocumentApp.ParagraphHeading.HEADING2;
    } else if (hashCount === 3) {
      result.heading = DocumentApp.ParagraphHeading.HEADING3;
    } else if (hashCount === 4) {
      result.heading = DocumentApp.ParagraphHeading.HEADING4;
    } else if (hashCount === 5) {
      result.heading = DocumentApp.ParagraphHeading.HEADING5;
    } else {
      result.heading = DocumentApp.ParagraphHeading.HEADING6;
    }
    return result;
  }

  // Check for ALL CAPS short lines (make them HEADING2)
  if (trimmed.length > 0 && trimmed.length <= 50 && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) {
    // Exclude lines that are just punctuation or numbers
    if (/[A-Z]{2,}/.test(trimmed)) {
      result.heading = DocumentApp.ParagraphHeading.HEADING2;
      return result;
    }
  }

  // Check for bullet points: "- ", "* ", "• "
  var bulletMatch = trimmed.match(/^[-*\u2022]\s+(.*)$/);
  if (bulletMatch) {
    result.text = bulletMatch[1];
    result.isBullet = true;
    return result;
  }

  // Check for numbered lists: "1. ", "2) "
  var numberedMatch = trimmed.match(/^\d+[.)]\s+(.*)$/);
  if (numberedMatch) {
    result.text = numberedMatch[1];
    result.isBullet = true; // Treat as bullet for simplicity
    return result;
  }

  return result;
}

// =============================================================================
// TASK 2: Insert table at anchor (existing logic, with debug output)
// =============================================================================
function insertTableAtAnchor_(body, anchor, tsvText) {
  var result = { found: false, rowsInserted: 0 };

  var p = findAnchorParagraph_(body, anchor);
  if (!p) return result;

  result.found = true;

  var rows = tsvText.split(/\r?\n/).filter(function(l) { return l.trim() !== ""; });
  if (!rows.length) {
    body.removeChild(p);
    return result;
  }

  var tableData = rows.map(function(line) {
    if (line.indexOf("\t") >= 0) return line.split("\t").map(trimCell_);
    if (line.indexOf("|") >= 0) return line.split("|").map(trimCell_).filter(function(x) { return x !== ""; });
    return [line.trim()];
  });

  var idx = body.getChildIndex(p);
  var table = body.insertTable(idx + 1, tableData);
  result.rowsInserted = tableData.length;

  // Bold header row
  if (table.getNumRows() > 0) {
    var headerRow = table.getRow(0);
    for (var c = 0; c < headerRow.getNumCells(); c++) {
      headerRow.getCell(c).editAsText().setBold(true);
    }
  }

  // Remove the anchor paragraph
  body.removeChild(p);

  return result;
}

// =============================================================================
// Remove any leftover token from body (cleanup pass)
// =============================================================================
function removeLeftoverToken_(body, token) {
  var searchResult = body.findText(escapeForRegex_(token));
  while (searchResult) {
    var element = searchResult.getElement();
    var start = searchResult.getStartOffset();
    var end = searchResult.getEndOffsetInclusive();

    if (element.getType() === DocumentApp.ElementType.TEXT) {
      var text = element.asText();
      text.deleteText(start, end);
    }

    searchResult = body.findText(escapeForRegex_(token), searchResult);
  }
}

// =============================================================================
// TASK 5: Find remaining tokens in document for debug
// =============================================================================
function findRemainingTokens_(body, headerSection, footerSection) {
  var tokens = [];
  var tokenPattern = "\\{\\{[A-Z_]+\\}\\}";

  // Search body
  var searchResult = body.findText(tokenPattern);
  while (searchResult) {
    var element = searchResult.getElement();
    var text = element.asText().getText();
    var start = searchResult.getStartOffset();
    var end = searchResult.getEndOffsetInclusive();
    var token = text.substring(start, end + 1);
    if (tokens.indexOf(token) === -1) {
      tokens.push(token);
    }
    searchResult = body.findText(tokenPattern, searchResult);
  }

  // Search header
  if (headerSection) {
    searchResult = headerSection.findText(tokenPattern);
    while (searchResult) {
      var hElement = searchResult.getElement();
      var hText = hElement.asText().getText();
      var hStart = searchResult.getStartOffset();
      var hEnd = searchResult.getEndOffsetInclusive();
      var hToken = hText.substring(hStart, hEnd + 1);
      if (tokens.indexOf(hToken) === -1) {
        tokens.push(hToken);
      }
      searchResult = headerSection.findText(tokenPattern, searchResult);
    }
  }

  // Search footer
  if (footerSection) {
    searchResult = footerSection.findText(tokenPattern);
    while (searchResult) {
      var fElement = searchResult.getElement();
      var fText = fElement.asText().getText();
      var fStart = searchResult.getStartOffset();
      var fEnd = searchResult.getEndOffsetInclusive();
      var fToken = fText.substring(fStart, fEnd + 1);
      if (tokens.indexOf(fToken) === -1) {
        tokens.push(fToken);
      }
      searchResult = footerSection.findText(tokenPattern, searchResult);
    }
  }

  return tokens;
}

// =============================================================================
// Helper functions
// =============================================================================

function replaceAllText_(section, findText, replaceWith) {
  if (!findText) return;
  // Escape $ in replacement value (regex backreference character)
  var safeReplacement = String(replaceWith || "").replace(/\$/g, "$$$$");
  section.replaceText(escapeForRegex_(findText), safeReplacement);
}

function escapeForRegex_(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findAnchorParagraph_(body, anchor) {
  var r = body.findText(escapeForRegex_(anchor));
  if (!r) return null;
  var el = r.getElement();
  while (el && el.getType && el.getType() !== DocumentApp.ElementType.PARAGRAPH) {
    el = el.getParent();
  }
  return el ? el.asParagraph() : null;
}

function trimCell_(s) {
  return String(s == null ? "" : s).trim();
}

function asStr_(v) {
  return (v === undefined || v === null) ? "" : String(v);
}

function cloneObj_(o) {
  var out = {};
  for (var k in o) {
    if (o.hasOwnProperty(k)) out[k] = o[k];
  }
  return out;
}

function setIfEmpty_(obj, key, value) {
  if (obj[key] === undefined || obj[key] === null || String(obj[key]).trim() === "") {
    obj[key] = value;
  }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// =============================================================================
// Content preprocessing helpers
// =============================================================================

// Strips known debug/helper labels from the start of content
function stripDebugLabels_(text) {
  if (!text) return text;
  var result = String(text);
  for (var i = 0; i < DEBUG_LABELS_TO_STRIP.length; i++) {
    var label = DEBUG_LABELS_TO_STRIP[i];
    var lowerResult = result.toLowerCase();
    var lowerLabel = label.toLowerCase();
    if (lowerResult.indexOf(lowerLabel) === 0) {
      result = result.substring(label.length).replace(/^[\s\n]+/, "");
    }
    var labelWithNewline = new RegExp("^\\s*" + escapeForRegex_(label) + "\\s*[\\r\\n]+", "i");
    result = result.replace(labelWithNewline, "");
  }
  return result;
}

// Removes inline table text from content to prevent duplicate rendering
function removeInlineTableFromContent_(content, tableText) {
  if (!content || !tableText) return content;
  var result = String(content);
  var idx = result.indexOf(tableText);
  if (idx !== -1) {
    result = result.substring(0, idx) + result.substring(idx + tableText.length);
  }
  var trimmedTable = tableText.trim();
  if (trimmedTable && result.indexOf(trimmedTable) !== -1) {
    result = result.replace(trimmedTable, "");
  }
  return result;
}

// Normalizes whitespace: trims edges, collapses multiple blank lines
function normalizeWhitespace_(text) {
  if (!text) return text;
  var result = String(text).trim();
  result = result.replace(/(\r?\n){3,}/g, "\n\n");
  return result;
}

// Removes excessive consecutive empty paragraphs from body
function cleanupEmptyParagraphs_(body) {
  var numChildren = body.getNumChildren();
  var toRemove = [];
  var consecutiveEmpty = 0;

  for (var i = 0; i < numChildren; i++) {
    var child = body.getChild(i);
    if (child.getType() === DocumentApp.ElementType.PARAGRAPH) {
      var text = child.asParagraph().getText().trim();
      if (text === "") {
        consecutiveEmpty++;
        if (consecutiveEmpty > 1) {
          toRemove.push(child);
        }
      } else {
        consecutiveEmpty = 0;
      }
    } else {
      consecutiveEmpty = 0;
    }
  }

  for (var j = toRemove.length - 1; j >= 0; j--) {
    try {
      body.removeChild(toRemove[j]);
    } catch (e) {
      // Ignore removal errors
    }
  }
}
