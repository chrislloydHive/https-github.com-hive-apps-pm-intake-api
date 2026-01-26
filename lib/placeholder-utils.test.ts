/**
 * Tests for placeholder-utils.ts
 *
 * Run with: npm test
 */

import { describe, it, expect } from "vitest";
import {
  coerceToString,
  normalizeKey,
  normalizeMerge,
  buildPlaceholders,
  buildReplaceRequests,
} from "./placeholder-utils";

// =============================================================================
// coerceToString
// =============================================================================

describe("coerceToString", () => {
  it("returns null for null/undefined", () => {
    expect(coerceToString(null)).toBe(null);
    expect(coerceToString(undefined)).toBe(null);
  });

  it("trims and returns strings", () => {
    expect(coerceToString("hello")).toBe("hello");
    expect(coerceToString("  hello  ")).toBe("hello");
    expect(coerceToString("")).toBe(null);
    expect(coerceToString("   ")).toBe(null);
  });

  it("converts numbers to strings", () => {
    expect(coerceToString(42)).toBe("42");
    expect(coerceToString(3.14)).toBe("3.14");
  });

  it("extracts first element from arrays", () => {
    expect(coerceToString(["hello", "world"])).toBe("hello");
    expect(coerceToString([42])).toBe("42");
    expect(coerceToString([])).toBe(null);
  });

  it("extracts .name from objects", () => {
    expect(coerceToString({ name: "Project Name" })).toBe("Project Name");
  });

  it("extracts .value from objects", () => {
    expect(coerceToString({ value: "Some Value" })).toBe("Some Value");
  });

  it("handles nested arrays with objects", () => {
    expect(coerceToString([{ name: "First" }])).toBe("First");
    expect(coerceToString([{ value: "First Value" }])).toBe("First Value");
  });
});

// =============================================================================
// normalizeKey
// =============================================================================

describe("normalizeKey", () => {
  it("removes braces and uppercases", () => {
    expect(normalizeKey("{{CONTENT}}")).toBe("CONTENT");
    expect(normalizeKey("{{PROJECT}}")).toBe("PROJECT");
    expect(normalizeKey("{{INLINE_TABLE}}")).toBe("INLINE_TABLE");
  });

  it("uppercases lowercase keys", () => {
    expect(normalizeKey("content")).toBe("CONTENT");
    expect(normalizeKey("project")).toBe("PROJECT");
    expect(normalizeKey("inline_table")).toBe("INLINE_TABLE");
  });

  it("handles keys without braces", () => {
    expect(normalizeKey("CONTENT")).toBe("CONTENT");
    expect(normalizeKey("PROJECT")).toBe("PROJECT");
  });

  it("trims whitespace", () => {
    expect(normalizeKey("  CONTENT  ")).toBe("CONTENT");
    expect(normalizeKey("  {{PROJECT}}  ")).toBe("PROJECT");
  });
});

// =============================================================================
// normalizeMerge
// =============================================================================

describe("normalizeMerge", () => {
  it("extracts from placeholders object with brace keys", () => {
    const body = {
      placeholders: {
        "{{PROJECT}}": "120CAR They Win – You Win Promo",
        "{{CONTENT}}": "Hello\nWorld",
        "{{INLINE_TABLE}}": "Row1\tCol2",
      },
    };

    const result = normalizeMerge(body);

    expect(result.PROJECT).toBe("120CAR They Win – You Win Promo");
    expect(result.CONTENT).toBe("Hello\nWorld");
    expect(result.INLINE_TABLE).toBe("Row1\tCol2");
  });

  it("extracts from mergeFields object", () => {
    const body = {
      mergeFields: {
        PROJECT: "My Project",
        CLIENT: "My Client",
        CONTENT: "Some content",
      },
    };

    const result = normalizeMerge(body);

    expect(result.PROJECT).toBe("My Project");
    expect(result.CLIENT).toBe("My Client");
    expect(result.CONTENT).toBe("Some content");
  });

  it("extracts from fields object (alternative key)", () => {
    const body = {
      fields: {
        PROJECT: "From Fields",
        HEADER: "Header Text",
      },
    };

    const result = normalizeMerge(body);

    expect(result.PROJECT).toBe("From Fields");
    expect(result.HEADER).toBe("Header Text");
  });

  it("placeholders take priority over mergeFields", () => {
    const body = {
      placeholders: {
        "{{PROJECT}}": "From Placeholders",
      },
      mergeFields: {
        PROJECT: "From MergeFields",
        CLIENT: "Client Only in MergeFields",
      },
    };

    const result = normalizeMerge(body);

    expect(result.PROJECT).toBe("From Placeholders");
    expect(result.CLIENT).toBe("Client Only in MergeFields");
  });

  it("normalizes lowercase keys to uppercase", () => {
    const body = {
      mergeFields: {
        project: "lowercase project",
        content: "lowercase content",
      },
    };

    const result = normalizeMerge(body);

    expect(result.PROJECT).toBe("lowercase project");
    expect(result.CONTENT).toBe("lowercase content");
  });

  it("handles mixed payload with both placeholders and mergeFields", () => {
    const body = {
      placeholders: {
        "{{CONTENT}}": "Content from placeholders",
        "{{INLINE_TABLE}}": "Table data",
      },
      mergeFields: {
        PROJECT: "Project from mergeFields",
        CLIENT: "Client from mergeFields",
        SHORT_OVERVIEW: "Overview text",
      },
    };

    const result = normalizeMerge(body);

    expect(result.CONTENT).toBe("Content from placeholders");
    expect(result.INLINE_TABLE).toBe("Table data");
    expect(result.PROJECT).toBe("Project from mergeFields");
    expect(result.CLIENT).toBe("Client from mergeFields");
    expect(result.SHORT_OVERVIEW).toBe("Overview text");
  });

  it("returns empty object for empty body", () => {
    expect(normalizeMerge({})).toEqual({});
  });

  it("handles multiline CONTENT correctly", () => {
    const body = {
      placeholders: {
        "{{CONTENT}}": "Line 1\nLine 2\nLine 3\n\nParagraph 2",
      },
    };

    const result = normalizeMerge(body);

    expect(result.CONTENT).toBe("Line 1\nLine 2\nLine 3\n\nParagraph 2");
    expect(result.CONTENT.split("\n").length).toBe(5);
  });
});

// =============================================================================
// buildPlaceholders
// =============================================================================

describe("buildPlaceholders", () => {
  it("wraps keys in braces", () => {
    const merge = {
      PROJECT: "My Project",
      CONTENT: "My Content",
    };

    const result = buildPlaceholders(merge);

    expect(result["{{PROJECT}}"]).toBe("My Project");
    expect(result["{{CONTENT}}"]).toBe("My Content");
  });

  it("uppercases lowercase keys", () => {
    const merge = {
      project: "My Project",
      content: "My Content",
    };

    const result = buildPlaceholders(merge);

    expect(result["{{PROJECT}}"]).toBe("My Project");
    expect(result["{{CONTENT}}"]).toBe("My Content");
  });

  it("handles all common placeholder keys", () => {
    const merge = {
      PROJECT: "Project",
      CLIENT: "Client",
      HEADER: "Header",
      SHORT_OVERVIEW: "Overview",
      CONTENT: "Content",
      INLINE_TABLE: "Table",
      GENERATED_AT: "2024-01-01",
      PROJECT_NUMBER: "12345",
      START_DATE: "2024-01-15",
      DUE_DATE: "2024-02-15",
    };

    const result = buildPlaceholders(merge);

    expect(Object.keys(result)).toHaveLength(10);
    expect(result["{{PROJECT}}"]).toBe("Project");
    expect(result["{{CLIENT}}"]).toBe("Client");
    expect(result["{{HEADER}}"]).toBe("Header");
    expect(result["{{SHORT_OVERVIEW}}"]).toBe("Overview");
    expect(result["{{CONTENT}}"]).toBe("Content");
    expect(result["{{INLINE_TABLE}}"]).toBe("Table");
    expect(result["{{GENERATED_AT}}"]).toBe("2024-01-01");
    expect(result["{{PROJECT_NUMBER}}"]).toBe("12345");
    expect(result["{{START_DATE}}"]).toBe("2024-01-15");
    expect(result["{{DUE_DATE}}"]).toBe("2024-02-15");
  });
});

// =============================================================================
// buildReplaceRequests
// =============================================================================

describe("buildReplaceRequests", () => {
  it("builds replaceAllText requests", () => {
    const placeholders = {
      "{{PROJECT}}": "My Project",
      "{{CONTENT}}": "My Content",
    };

    const result = buildReplaceRequests(placeholders);

    expect(result).toHaveLength(2);

    expect(result[0]).toEqual({
      replaceAllText: {
        containsText: { text: "{{PROJECT}}", matchCase: true },
        replaceText: "My Project",
      },
    });

    expect(result[1]).toEqual({
      replaceAllText: {
        containsText: { text: "{{CONTENT}}", matchCase: true },
        replaceText: "My Content",
      },
    });
  });

  it("handles empty values as empty strings", () => {
    const placeholders = {
      "{{CONTENT}}": "",
    };

    const result = buildReplaceRequests(placeholders);

    expect(result[0].replaceAllText.replaceText).toBe("");
  });

  it("handles null values as empty strings", () => {
    const placeholders: Record<string, string> = {
      "{{CONTENT}}": null as any,
    };

    const result = buildReplaceRequests(placeholders);

    expect(result[0].replaceAllText.replaceText).toBe("");
  });

  it("preserves newlines in content", () => {
    const placeholders = {
      "{{CONTENT}}": "Line 1\nLine 2\nLine 3",
    };

    const result = buildReplaceRequests(placeholders);

    expect(result[0].replaceAllText.replaceText).toBe("Line 1\nLine 2\nLine 3");
  });

  it("sets matchCase to true for all requests", () => {
    const placeholders = {
      "{{PROJECT}}": "Project",
      "{{CONTENT}}": "Content",
      "{{INLINE_TABLE}}": "Table",
    };

    const result = buildReplaceRequests(placeholders);

    result.forEach((req) => {
      expect(req.replaceAllText.containsText.matchCase).toBe(true);
    });
  });

  it("returns empty array for empty placeholders", () => {
    const result = buildReplaceRequests({});
    expect(result).toEqual([]);
  });
});

// =============================================================================
// Integration: Full pipeline test
// =============================================================================

describe("Integration: normalizeMerge -> buildPlaceholders -> buildReplaceRequests", () => {
  it("processes Airtable payload with placeholders object", () => {
    // Simulates the actual Airtable automation payload format
    const airtablePayload = {
      placeholders: {
        "{{PROJECT}}": "120CAR They Win – You Win Promo",
        "{{CLIENT}}": "Acme Corp",
        "{{HEADER}}": "Q1 Campaign Brief",
        "{{SHORT_OVERVIEW}}": "Promotional campaign for Q1 2024",
        "{{CONTENT}}": "## Overview\n\nThis campaign focuses on...\n\n## Goals\n\n- Increase brand awareness\n- Drive sales",
        "{{INLINE_TABLE}}": "Phase\tStart\tEnd\nPlanning\tJan 1\tJan 15\nExecution\tJan 16\tFeb 28",
      },
    };

    // Step 1: Normalize
    const merge = normalizeMerge(airtablePayload);
    expect(merge.PROJECT).toBe("120CAR They Win – You Win Promo");
    expect(merge.CONTENT).toContain("## Overview");
    expect(merge.INLINE_TABLE).toContain("Phase\tStart\tEnd");

    // Step 2: Build placeholders
    const placeholders = buildPlaceholders(merge);
    expect(placeholders["{{PROJECT}}"]).toBe("120CAR They Win – You Win Promo");
    expect(placeholders["{{CONTENT}}"]).toContain("## Overview");

    // Step 3: Build requests
    const requests = buildReplaceRequests(placeholders);
    expect(requests.length).toBe(6);

    // Verify CONTENT request is correct
    const contentRequest = requests.find(
      (r) => r.replaceAllText.containsText.text === "{{CONTENT}}"
    );
    expect(contentRequest).toBeDefined();
    expect(contentRequest?.replaceAllText.replaceText).toContain("## Overview");
    expect(contentRequest?.replaceAllText.containsText.matchCase).toBe(true);

    // Verify INLINE_TABLE request is correct
    const tableRequest = requests.find(
      (r) => r.replaceAllText.containsText.text === "{{INLINE_TABLE}}"
    );
    expect(tableRequest).toBeDefined();
    expect(tableRequest?.replaceAllText.replaceText).toContain("Phase\tStart\tEnd");
  });

  it("processes Airtable payload with mergeFields object", () => {
    const airtablePayload = {
      mergeFields: {
        PROJECT: "Job#456 - Summer Sale Campaign",
        CLIENT: "Big Retailer",
        CONTENT: "Campaign details here...",
        INLINE_TABLE: "Item\tQty\nWidget\t100",
      },
    };

    const merge = normalizeMerge(airtablePayload);
    const placeholders = buildPlaceholders(merge);
    const requests = buildReplaceRequests(placeholders);

    expect(requests.length).toBe(4);
    expect(requests.some((r) => r.replaceAllText.containsText.text === "{{PROJECT}}")).toBe(true);
    expect(requests.some((r) => r.replaceAllText.containsText.text === "{{CONTENT}}")).toBe(true);
    expect(requests.some((r) => r.replaceAllText.containsText.text === "{{INLINE_TABLE}}")).toBe(true);
  });

  it("handles job# prefix in PROJECT name correctly", () => {
    const airtablePayload = {
      placeholders: {
        "{{PROJECT}}": "Job#123 - Holiday Promotion 2024",
      },
    };

    const merge = normalizeMerge(airtablePayload);
    const placeholders = buildPlaceholders(merge);

    // The job# prefix should be preserved
    expect(placeholders["{{PROJECT}}"]).toBe("Job#123 - Holiday Promotion 2024");
    expect(placeholders["{{PROJECT}}"]).toMatch(/^Job#\d+/);
  });
});
