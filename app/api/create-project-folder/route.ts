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

// Default root folder for /Work/Clients/
const DEFAULT_CLIENTS_ROOT_FOLDER_ID = "1BzSDyj4xNT36qJKckPOoxifYZH4mcPQo";

function getAppsScriptUrl(): string {
  const envUrl = process.env.GOOGLE_APPS_SCRIPT_CREATE_PROJECT_FOLDER_URL;
  if (!envUrl || envUrl.trim() === "") {
    throw new Error(
      "GOOGLE_APPS_SCRIPT_CREATE_PROJECT_FOLDER_URL is not set. " +
      "Set it in Vercel to: https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec"
    );
  }
  return envUrl.trim();
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "...[truncated]";
}

function redactUrl(url: string): string {
  // Redact the deployment ID portion for logging (show first 20 chars of ID)
  // Handles both /macros/s/<ID>/exec and /a/macros/<domain>/s/<ID>/exec
  const match = url.match(/\/s\/([^/]+)\/exec/);
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
function checkAuth(req: Request): { ok: true; method: string } | { ok: false; error: string; debug: Record<string, unknown> } {
  const expectedSecret = (process.env.AIRTABLE_PROXY_SECRET || "").trim();
  const apiKey = req.headers.get("x-api-key");
  const authHeader = req.headers.get("authorization");

  // TEMPORARY auth-debug logging — remove after diagnosing auth failures
  console.log("[create-project-folder/auth-debug]", {
    expectedLen: expectedSecret.length,
    hasApiKey: !!apiKey,
    apiKeyLen: apiKey?.length ?? 0,
    hasAuth: !!authHeader,
    authStartsBearer: authHeader?.startsWith("Bearer ") ?? false,
    authLen: authHeader?.length ?? 0,
    vercelEnv: process.env.VERCEL_ENV,
    nodeEnv: process.env.NODE_ENV,
    url: req.url,
    method: req.method,
  });

  if (!expectedSecret) {
    console.error("[create-project-folder] AIRTABLE_PROXY_SECRET not configured");
    return { ok: false, error: "Server misconfigured: missing AIRTABLE_PROXY_SECRET", debug: { expectedLen: 0 } };
  }

  // Method 1: x-api-key header
  if (apiKey && apiKey === expectedSecret) {
    return { ok: true, method: "x-api-key" };
  }

  // Method 2: Authorization Bearer token
  if (authHeader && authHeader === `Bearer ${expectedSecret}`) {
    return { ok: true, method: "bearer" };
  }

  // Log auth failure (without revealing the secret)
  console.warn("[create-project-folder] Auth failed: x-api-key=" + (apiKey ? "provided" : "missing") +
    ", authorization=" + (authHeader ? "provided" : "missing"));

  return {
    ok: false,
    error: "Unauthorized",
    debug: {
      expectedLen: expectedSecret.length,
      apiKeyLen: apiKey?.length ?? 0,
      hasAuth: !!authHeader,
      authStartsBearer: authHeader?.startsWith("Bearer ") ?? false,
    },
  };
}

export async function POST(req: Request) {
  const startTime = Date.now();

  // Auth check first
  const auth = checkAuth(req);
  if (!auth.ok) {
    console.log("[create-project-folder] Auth rejected");
    return NextResponse.json(
      { ok: false, error: auth.error, debug: auth.debug },
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

    const { projectName, parentFolderId, clientName, ...rest } = body;

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
      clientName?: string;
      clientsRootFolderId?: string;
    } = {
      clientPmProjectRecordId,
      recordId: clientPmProjectRecordId,
      projectName: projectName.trim(),
      templateFolderId: TEMPLATE_FOLDER_ID,
    };

    // Priority: explicit parentFolderId takes precedence over clientName routing
    if (parentFolderId && typeof parentFolderId === "string" && parentFolderId.trim() !== "") {
      payload.parentFolderId = parentFolderId.trim();
    } else if (clientName && typeof clientName === "string" && clientName.trim().replace(/\s+/g, " ") !== "") {
      // Sanitize: trim and collapse multiple spaces
      const sanitizedClientName = clientName.trim().replace(/\s+/g, " ");
      const clientsRootFolderId = process.env.CLIENTS_ROOT_FOLDER_ID || DEFAULT_CLIENTS_ROOT_FOLDER_ID;
      payload.clientName = sanitizedClientName;
      payload.clientsRootFolderId = clientsRootFolderId;
      console.log("[create-project-folder] clientName routing: clientName=" + sanitizedClientName +
        ", clientsRootFolderId=" + clientsRootFolderId);
    }

    // Get the Apps Script URL
    const appsScriptUrl = getAppsScriptUrl();

    // TEMPORARY downstream-debug logging — remove after diagnosing
    const downstreamParsed = new URL(appsScriptUrl);
    console.log("[create-project-folder/downstream-debug]", {
      host: downstreamParsed.host,
      pathPrefix: downstreamParsed.pathname.slice(0, 40),
      endsWithExec: downstreamParsed.pathname.endsWith("/exec"),
      isScriptGoogle: downstreamParsed.host === "script.google.com",
      source: process.env.GOOGLE_APPS_SCRIPT_CREATE_PROJECT_FOLDER_URL ? "env" : "fallback",
      vercelEnv: process.env.VERCEL_ENV,
    });

    // Validate URL shape — ONLY accept public exec URL format
    // Domain-scoped (/a/macros/<domain>/s/...) returns 401 HTML — reject it
    if (
      downstreamParsed.host !== "script.google.com" ||
      !downstreamParsed.pathname.startsWith("/macros/s/") ||
      !downstreamParsed.pathname.endsWith("/exec")
    ) {
      const msg =
        "GOOGLE_APPS_SCRIPT_CREATE_PROJECT_FOLDER_URL is not in the required format. " +
        `Got: host=${downstreamParsed.host}, path=${downstreamParsed.pathname.slice(0, 40)}. ` +
        "Required: https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec " +
        "(NOT /a/macros/<domain>/...)";
      console.error("[create-project-folder] " + msg);
      return NextResponse.json({ ok: false, error: msg }, { status: 500 });
    }

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

    // TEMPORARY downstream-response-debug — remove after diagnosing
    console.log("[create-project-folder/downstream-response]", {
      status: response.status,
      contentType,
      bodySnippet: truncate(responseText, 120),
      isHtml: contentType.includes("text/html"),
      elapsed,
    });

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

    // Build debug info for error responses
    const downstreamDebug = {
      downstreamHost: downstreamParsed.host,
      downstreamPathPrefix: downstreamParsed.pathname.slice(0, 40),
      downstreamStatus: response.status,
      downstreamContentType: contentType,
    };

    // If downstream returned non-OK, return structured error with debug
    if (!response.ok) {
      console.error("[create-project-folder] Downstream error body:", truncate(responseText, 120));
      return NextResponse.json(
        { ok: false, error: "Downstream error", debug: downstreamDebug },
        { status: 502 }
      );
    }

    // Try to parse as JSON if applicable
    if (contentType.includes("application/json")) {
      try {
        const jsonData = JSON.parse(responseText);
        // Return the FULL JSON response from Apps Script (including _debug)
        return NextResponse.json(jsonData, { status: response.status });
      } catch {
        console.error("[create-project-folder] JSON parse failed, body:", truncate(responseText, 120));
        return NextResponse.json(
          { ok: false, error: "Downstream returned invalid JSON", debug: downstreamDebug },
          { status: 502 }
        );
      }
    }

    // Non-JSON response (likely HTML error page)
    console.error("[create-project-folder] Non-JSON downstream response:", truncate(responseText, 120));
    return NextResponse.json(
      { ok: false, error: "Downstream returned non-JSON response", debug: downstreamDebug },
      { status: 502 }
    );
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
