/**
 * Drive parent resolution — prefix-collision regression tests.
 *
 * Manual test (Car Toys Oregon):
 *   curl -X POST .../api/create-project-folder \
 *     -H "x-api-key: $AIRTABLE_PROXY_SECRET" \
 *     -d '{"clientPmProjectRecordId":"rec…","projectName":"Test","clientName":"Car Toys Oregon"}'
 *   Expect parentFolderId 1g4vXY191HJ0Btw6zFY9WwxvgGsfli4fC in GAS payload (not under Car Toys root).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveClientProjectsFolder } from "./resolveClientProjectsFolder";

vi.mock("./config", () => ({
  config: {
    airtableApiKey: "test-airtable-key",
    clientPmOsBaseId: "appQLwoVH8JyGSTIo",
  },
  tables: { projects: "Projects" },
}));

const BASE = "appQLwoVH8JyGSTIo";
const CAR_TOYS_PROJECTS = "1NLCt-piSxfAFeeINuFyzb3Pxp-kKXTw_";
const CAR_TOYS_OREGON_PROJECTS = "1g4vXY191HJ0Btw6zFY9WwxvgGsfli4fC";
const CAR_TOYS_ROOT_WRONG = "1BzSDyj4xNT36qJKckPOoxifYZH4mcPQo";

function airtableUrl(path: string): string {
  return `https://api.airtable.com/v0/${BASE}/${path}`;
}

describe("resolveClientProjectsFolder", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns clientFolderId without calling Airtable", async () => {
    const result = await resolveClientProjectsFolder({
      clientFolderId: CAR_TOYS_OREGON_PROJECTS,
      clientPmProjectRecordId: "recProject1",
      clientName: "Car Toys Oregon",
    });

    expect(result).toEqual({
      ok: true,
      folderId: CAR_TOYS_OREGON_PROJECTS,
      source: "clientFolderId",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves via Project → Client link → Drive Folder ID (Car Toys Oregon)", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === airtableUrl("Projects/recProjectOR")) {
        return jsonResponse({
          id: "recProjectOR",
          fields: { Client: ["recCompanyOR"] },
        });
      }
      if (url === airtableUrl("Companies/recCompanyOR")) {
        return jsonResponse({
          id: "recCompanyOR",
          fields: {
            "Company Name": "Car Toys Oregon",
            "Drive Folder ID": CAR_TOYS_OREGON_PROJECTS,
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await resolveClientProjectsFolder({
      clientPmProjectRecordId: "recProjectOR",
      clientName: "Car Toys Oregon",
    });

    expect(result).toMatchObject({
      ok: true,
      folderId: CAR_TOYS_OREGON_PROJECTS,
      source: "project-client-link",
      companyRecordId: "recCompanyOR",
    });
    if (result.ok) {
      expect(result.folderId).not.toBe(CAR_TOYS_ROOT_WRONG);
    }
  });

  it("exact Company Name match uses Oregon Projects folder, not Car Toys root", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === airtableUrl("Projects/recNoClient")) {
        return jsonResponse({
          id: "recNoClient",
          fields: { Client: [] },
        });
      }
      if (url.startsWith(airtableUrl("Companies?"))) {
        const parsed = new URL(url);
        const formula = parsed.searchParams.get("filterByFormula") ?? "";
        expect(formula).toContain("Car Toys Oregon");
        expect(formula).not.toMatch(/Car Toys'/); // must not match shorter "Car Toys" only

        return jsonResponse({
          records: [
            {
              id: "recCompanyOR",
              fields: {
                "Company Name": "Car Toys Oregon",
                "Drive Folder ID": CAR_TOYS_OREGON_PROJECTS,
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await resolveClientProjectsFolder({
      clientPmProjectRecordId: "recNoClient",
      clientName: "Car Toys Oregon",
    });

    expect(result).toMatchObject({
      ok: true,
      folderId: CAR_TOYS_OREGON_PROJECTS,
      source: "exact-company-name",
    });
  });

  it("exact Company Name Car Toys resolves to Car Toys Projects folder", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === airtableUrl("Projects/recProjectCT")) {
        return jsonResponse({
          id: "recProjectCT",
          fields: {},
        });
      }
      if (url.startsWith(airtableUrl("Companies?"))) {
        return jsonResponse({
          records: [
            {
              id: "recCompanyCT",
              fields: {
                "Company Name": "Car Toys",
                "Drive Folder ID": CAR_TOYS_PROJECTS,
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await resolveClientProjectsFolder({
      clientPmProjectRecordId: "recProjectCT",
      clientName: "Car Toys",
    });

    expect(result).toMatchObject({
      ok: true,
      folderId: CAR_TOYS_PROJECTS,
      source: "exact-company-name",
    });
    if (result.ok) {
      expect(result.folderId).not.toBe(CAR_TOYS_OREGON_PROJECTS);
    }
  });

  it("fails when linked company has no Drive Folder ID (no Car Toys root fallback)", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === airtableUrl("Projects/recP")) {
        return jsonResponse({
          id: "recP",
          fields: { Client: ["recCo"] },
        });
      }
      if (url === airtableUrl("Companies/recCo")) {
        return jsonResponse({
          id: "recCo",
          fields: { "Company Name": "New Client LLC" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await resolveClientProjectsFolder({
      clientPmProjectRecordId: "recP",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Drive Folder ID");
      expect(result.error).not.toContain("1BzSDyj4");
    }
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}
