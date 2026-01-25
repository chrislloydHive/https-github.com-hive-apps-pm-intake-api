import { NextResponse } from "next/server";

const ALLOWED = new Set(["script.google.com", "script.googleusercontent.com"]);

/**
 * Request payload for gas-forward2
 *
 * Required:
 * - gasUrl: The Google Apps Script web app URL to forward to
 * - recordId: Airtable record ID
 * - projectName: Name for the folder/project
 *
 * Optional:
 * - parentFolderId: Google Drive folder ID to create folder under (highest priority)
 * - clientType: "prospect" | "client" | etc. (used for routing if no parentFolderId)
 *
 * The GAS web app uses this routing logic:
 * 1. If parentFolderId provided → use it (explicit)
 * 2. If clientType === "prospect" → NEW_BUSINESS_ROOT_FOLDER_ID
 * 3. Otherwise → WORK_ROOT_FOLDER_ID (default)
 */
interface GasForwardPayload {
  gasUrl: string;
  recordId: string;
  projectName: string;
  parentFolderId?: string;  // Google Drive folder ID for parent folder
  clientType?: string;
  [key: string]: unknown;   // Allow additional fields
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    route: "gas-forward2",
    description: "Forwards requests to Google Apps Script web apps",
    requiredFields: ["gasUrl", "recordId", "projectName"],
    optionalFields: ["parentFolderId", "clientType"],
  });
}

export async function POST(req: Request) {
  try {
    const secret = process.env.AIRTABLE_PROXY_SECRET || "";
    const provided = req.headers.get("x-proxy-secret") || "";

    if (!secret || !provided || secret !== provided) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    let body: GasForwardPayload | null = null;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
    }

    const gasUrl = String(body?.gasUrl || "");
    if (!gasUrl) {
      return NextResponse.json({ ok: false, error: "Missing gasUrl" }, { status: 400 });
    }

    let url: URL;
    try {
      url = new URL(gasUrl);
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid gasUrl" }, { status: 400 });
    }

    if (!ALLOWED.has(url.hostname)) {
      return NextResponse.json({ ok: false, error: "Invalid host" }, { status: 400 });
    }

    const { gasUrl: _ignored, ...payload } = body;

    // Log what we're forwarding (for debugging)
    console.log("[gas-forward2] Forwarding to GAS:", {
      gasUrl: gasUrl.slice(0, 60) + "...",
      recordId: payload.recordId || "(missing)",
      projectName: payload.projectName || "(missing)",
      parentFolderId: payload.parentFolderId || "(not provided)",
      clientType: payload.clientType || "(not provided)",
    });

    const upstream = await fetch(gasUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow",
    });

    const text = await upstream.text();
    const lower = text.trim().toLowerCase();

    // If GAS returned HTML (auth, error page, etc.)
    if (lower.startsWith("<!doctype") || lower.includes("<html")) {
      return NextResponse.json(
        {
          ok: false,
          error: "GAS returned HTML",
          upstreamStatus: upstream.status,
          bodySnippet: text.slice(0, 400),
        },
        { status: 502 }
      );
    }

    // Parse JSON
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      return NextResponse.json(
        {
          ok: false,
          error: "GAS returned non-JSON",
          upstreamStatus: upstream.status,
          bodySnippet: text.slice(0, 400),
        },
        { status: 502 }
      );
    }

    // Always return JSON, always include upstreamStatus for debugging
    return NextResponse.json({ ...parsed, upstreamStatus: upstream.status });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: "Proxy exception", detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}
