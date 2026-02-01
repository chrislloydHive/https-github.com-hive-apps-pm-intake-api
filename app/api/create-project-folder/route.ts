import { NextResponse } from "next/server";
import {
  validateClientPmProjectRecordId,
  logProjectRouteDebug,
} from "@/lib/projectId";
import {
  verifyClientPmProjectExists,
  resolveProjectIds,
} from "@/lib/projectMapping";
import { config } from "@/lib/config";

/**
 * Proxy endpoint for Google Apps Script Web App.
 *
 * WHY THIS EXISTS:
 * - Airtable Automations cannot follow HTTP redirects
 * - Google Apps Script web apps always return a 302 redirect
 * - This server-side proxy follows the redirect and returns the response directly
 *
 * AUTHENTICATION:
 * Requires one of these headers:
 *   - x-api-key: <AIRTABLE_PROXY_SECRET>
 *   - Authorization: Bearer <AIRTABLE_PROXY_SECRET>
 *
 * CONFIGURATION:
 * Set the following environment variables in Vercel:
 *   AIRTABLE_PROXY_SECRET = your-secure-random-secret
 *   GOOGLE_APPS_SCRIPT_CREATE_PROJECT_FOLDER_URL = https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec
 *
 * DEPLOYMENT STEPS:
 * 1. Deploy your Apps Script as a web app (Execute as: Me, Access: Anyone)
 * 2. Copy the deployment URL
 * 3. Set GOOGLE_APPS_SCRIPT_CREATE_PROJECT_FOLDER_URL in Vercel Environment Variables
 * 4. Set AIRTABLE_PROXY_SECRET in Vercel Environment Variables
 * 5. Redeploy the Vercel project
 */

// Template folder ID for project folder structure
const TEMPLATE_FOLDER_ID = "1l2Ksbkoomy7OmuHgrAFM0_r-d9UJgQq4";

// Fallback URL (legacy deployment) - only used if env var is missing
const FALLBACK_APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbz4j2dLWepBYAEXznzuA5Vfxh95ZX7J8CJg_iZnncNpwt4QtP29194z7GImobBPMJrj/exec";

function getAppsScriptUrl(): string {
  const envUrl = process.env.GOOGLE_APPS_SCRIPT_CREATE_PROJECT_FOLDER_URL;
  if (envUrl && envUrl.trim() !== "") {
    return envUrl.trim();
  }
  console.warn(
    "[create-project-folder] WARNING: GOOGLE_APPS_SCRIPT_CREATE_PROJECT_FOLDER_URL not set, using fallback URL"
  );
  return FALLBACK_APPS_SCRIPT_URL;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "...[truncated]";
}

function redactUrl(url: string): string {
  // Redact the deployment ID portion for logging (show first 20 chars of ID)
  const match = url.match(/\/macros\/s\/([^/]+)\/exec/);
  if (match && match[1]) {
    const id = match[1];
    const redacted = id.slice(0, 20) + "..." + id.slice(-4);
    return url.replace(id, redacted);
  }
  return url;
}

/**
 * Validate auth header - supports x-api-key or Bearer token
 * Does NOT log the secret value
 */
function checkAuth(req: Request): { ok: true; method: string } | { ok: false; error: string } {
  const expectedSecret = (process.env.AIRTABLE_PROXY_SECRET || "").trim();

  if (!expectedSecret) {
    console.error("[create-project-folder] AIRTABLE_PROXY_SECRET not configured");
    return { ok: false, error: "Server misconfigured: missing AIRTABLE_PROXY_SECRET" };
  }

  // Method 1: x-api-key header
  const apiKey = req.headers.get("x-api-key");
  if (apiKey && apiKey === expectedSecret) {
    return { ok: true, method: "x-api-key" };
  }

  // Method 2: Authorization Bearer token
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader === `Bearer ${expectedSecret}`) {
    return { ok: true, method: "bearer" };
  }

  // Log auth failure (without revealing the secret)
  console.warn("[create-project-folder] Auth failed: x-api-key=" + (apiKey ? "provided" : "missing") +
    ", authorization=" + (authHeader ? "provided" : "missing"));

  return { ok: false, error: "Unauthorized: provide x-api-key or Authorization Bearer header" };
}

export async function POST(req: Request) {
  const startTime = Date.now();

  // Auth check first
  const auth = checkAuth(req);
  if (!auth.ok) {
    console.log("[create-project-folder] Auth rejected");
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: 401 }
    );
  }
  console.log("[create-project-folder] Auth OK via", auth.method);

  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "Invalid JSON body" },
        { status: 400 }
      );
    }

    const { projectName, parentFolderId, ...rest } = body;

    // Canonical identifier: clientPmProjectRecordId (Client PM OS Projects record ID)
    // Accept recordId as legacy fallback. Reject hiveOsProjectRecordId — never pass HIVE OS ID to Client PM OS.
    const rawClientPm = rest.clientPmProjectRecordId ?? rest.recordId;
    const rawHiveOs = rest.hiveOsProjectRecordId;

    if (rawHiveOs && !rawClientPm) {
      const message =
        "hiveOsProjectRecordId cannot be used for Client PM OS automation. " +
        "Provide clientPmProjectRecordId (Client PM OS Projects record ID).";
      console.log("[create-project-folder] Rejected: " + message);
      return NextResponse.json({ ok: false, error: message }, { status: 400 });
    }

    const projectIdResult = validateClientPmProjectRecordId(rawClientPm);

    if (!projectIdResult.ok) {
      console.log(
        "[create-project-folder] Validation failed:",
        projectIdResult.error,
        "rawClientPm=",
        rawClientPm ? "(provided)" : "(missing)"
      );
      return NextResponse.json(
        { ok: false, error: projectIdResult.error },
        { status: 400 }
      );
    }

    const clientPmProjectRecordId = projectIdResult.value;

    // Verify record exists in Client PM OS Projects
    if (!config.clientPmOsBaseId) {
      const message =
        "Client PM OS base not configured (CLIENT_PM_OS_BASE_ID or AIRTABLE_BASE_ID). Cannot verify project record.";
      console.warn("[create-project-folder] " + message);
      return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }

    const exists = await verifyClientPmProjectExists(clientPmProjectRecordId);
    if (!exists) {
      const message =
        `Record ${clientPmProjectRecordId} not found in Client PM OS Projects (base ${config.clientPmOsBaseId}). ` +
        "Verify clientPmProjectRecordId is from the Client PM OS base — do not pass HIVE OS record IDs.";
      console.log("[create-project-folder] " + message);
      return NextResponse.json(
        { ok: false, error: message },
        { status: 400 }
      );
    }

    // Resolve both IDs for logging (optional — mapping may not exist)
    const mapping = await resolveProjectIds({ clientPmProjectRecordId });

    logProjectRouteDebug({
      route: "create-project-folder",
      clientPmProjectRecordId,
      hiveOsProjectRecordId: mapping?.hiveOsProjectRecordId ?? null,
      baseId: config.clientPmOsBaseId || undefined,
      tableName: "Projects",
    });

    if (!projectName || typeof projectName !== "string" || projectName.trim() === "") {
      return NextResponse.json(
        { ok: false, error: "projectName is required and must be a non-empty string" },
        { status: 400 }
      );
    }

    // Build payload for GAS — always pass clientPmProjectRecordId (never hiveOsProjectRecordId)
    const payload: {
      clientPmProjectRecordId: string;
      recordId: string; // legacy — GAS uses this internally
      projectName: string;
      templateFolderId: string;
      parentFolderId?: string;
    } = {
      clientPmProjectRecordId,
      recordId: clientPmProjectRecordId,
      projectName: projectName.trim(),
      templateFolderId: TEMPLATE_FOLDER_ID,
    };

    // Optional: parentFolderId for client-specific folder routing
    // When provided, the project folder will be created under this parent
    // When missing, the Apps Script uses the default Work root folder
    if (parentFolderId && typeof parentFolderId === "string" && parentFolderId.trim() !== "") {
      payload.parentFolderId = parentFolderId.trim();
    }

    // Get the Apps Script URL
    const appsScriptUrl = getAppsScriptUrl();

    // Log request details
    console.log("[create-project-folder] ========================================");
    console.log("[create-project-folder] Apps Script URL:", redactUrl(appsScriptUrl));
    console.log("[create-project-folder] Payload:", JSON.stringify(payload));
    console.log("[create-project-folder] ========================================");

    // Forward request to Google Apps Script, following redirects
    const response = await fetch(appsScriptUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow",
    });

    // Get the response body as text first to handle any content type
    const responseText = await response.text();
    const contentType = response.headers.get("content-type") || "application/json";
    const elapsed = Date.now() - startTime;

    // Log response details
    console.log("[create-project-folder] Response status:", response.status);
    console.log("[create-project-folder] Response content-type:", contentType);
    console.log("[create-project-folder] Elapsed time:", elapsed, "ms");

    // Log full body on success, short snippet on error
    if (response.ok) {
      console.log("[create-project-folder] Response body:", truncate(responseText, 2000));
    } else {
      // Log short error snippet (first 500 chars) for debugging
      console.error("[create-project-folder] Error response:", truncate(responseText, 500));
    }
    console.log("[create-project-folder] ========================================");

    // Try to parse as JSON if applicable
    if (contentType.includes("application/json")) {
      try {
        const jsonData = JSON.parse(responseText);
        // Return the FULL JSON response from Apps Script (including _debug)
        return NextResponse.json(jsonData, { status: response.status });
      } catch {
        // If parsing fails, return as text
        return new NextResponse(responseText, {
          status: response.status,
          headers: { "Content-Type": contentType },
        });
      }
    }

    // Return non-JSON responses as-is
    return new NextResponse(responseText, {
      status: response.status,
      headers: { "Content-Type": contentType },
    });
  } catch (error: any) {
    console.error("[create-project-folder] Proxy error:", error);
    return NextResponse.json(
      { ok: false, error: error?.message ?? "Unknown proxy error" },
      { status: 500 }
    );
  }
}

// Reject non-POST requests
export async function GET() {
  return NextResponse.json(
    { ok: false, error: "Method not allowed. Use POST." },
    { status: 405 }
  );
}

export async function PUT() {
  return NextResponse.json(
    { ok: false, error: "Method not allowed. Use POST." },
    { status: 405 }
  );
}

export async function DELETE() {
  return NextResponse.json(
    { ok: false, error: "Method not allowed. Use POST." },
    { status: 405 }
  );
}
