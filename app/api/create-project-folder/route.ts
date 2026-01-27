import { NextResponse } from "next/server";

/**
 * Proxy endpoint for Google Apps Script Web App.
 *
 * WHY THIS EXISTS:
 * - Airtable Automations cannot follow HTTP redirects
 * - Google Apps Script web apps always return a 302 redirect
 * - This server-side proxy follows the redirect and returns the response directly
 *
 * CONFIGURATION:
 * Set the following environment variable in Vercel:
 *   GOOGLE_APPS_SCRIPT_CREATE_PROJECT_FOLDER_URL = https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec
 *
 * DEPLOYMENT STEPS:
 * 1. Deploy your Apps Script as a web app (Execute as: Me, Access: Anyone)
 * 2. Copy the deployment URL
 * 3. Set GOOGLE_APPS_SCRIPT_CREATE_PROJECT_FOLDER_URL in Vercel Environment Variables
 * 4. Redeploy the Vercel project
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

export async function POST(req: Request) {
  const startTime = Date.now();

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

    const { recordId, projectName, parentFolderId } = body;

    // Validate required fields
    if (!recordId || typeof recordId !== "string" || recordId.trim() === "") {
      return NextResponse.json(
        { ok: false, error: "recordId is required and must be a non-empty string" },
        { status: 400 }
      );
    }

    if (!projectName || typeof projectName !== "string" || projectName.trim() === "") {
      return NextResponse.json(
        { ok: false, error: "projectName is required and must be a non-empty string" },
        { status: 400 }
      );
    }

    // Build payload with all required fields
    const payload: {
      recordId: string;
      projectName: string;
      templateFolderId: string;
      parentFolderId?: string;
    } = {
      recordId: recordId.trim(),
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
    console.log("[create-project-folder] Response body:", truncate(responseText, 2000));
    console.log("[create-project-folder] Elapsed time:", elapsed, "ms");
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
