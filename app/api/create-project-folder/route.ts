import { NextResponse } from "next/server";

/**
 * Proxy endpoint for Google Apps Script Web App.
 *
 * WHY THIS EXISTS:
 * - Airtable Automations cannot follow HTTP redirects
 * - Google Apps Script web apps always return a 302 redirect
 * - This server-side proxy follows the redirect and returns the response directly
 */

const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbz4j2dLWepBYAEXznzuA5Vfxh95ZX7J8CJg_iZnncNpwt4QtP29194z7GImobBPMJrj/exec";

export async function POST(req: Request) {
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

    // Build payload - include parentFolderId only if provided
    const payload: { recordId: string; projectName: string; parentFolderId?: string } = {
      recordId,
      projectName,
    };

    // Optional: parentFolderId for client-specific folder routing
    // When provided, the project folder will be created under this parent
    // When missing, the Apps Script uses the default Work root folder
    if (parentFolderId && typeof parentFolderId === "string" && parentFolderId.trim() !== "") {
      payload.parentFolderId = parentFolderId.trim();
    }

    // Forward request to Google Apps Script, following redirects
    const response = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow",
    });

    // Get the response body as text first to handle any content type
    const responseText = await response.text();
    const contentType = response.headers.get("content-type") || "application/json";

    // Try to parse as JSON if applicable
    if (contentType.includes("application/json")) {
      try {
        const jsonData = JSON.parse(responseText);
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
