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

const ALLOWED = new Set(["script.google.com", "script.googleusercontent.com"]);

/**
 * Request payload for gas-forward2
 *
 * Required:
 * - gasUrl: The Google Apps Script web app URL to forward to
 * - clientPmProjectRecordId: Client PM OS Projects record ID (or recordId legacy)
 * - projectName: Name for the folder/project
 *
 * Optional:
 * - parentFolderId: Google Drive folder ID to create folder under (highest priority)
 * - clientType: "prospect" | "client" | etc. (used for routing if no parentFolderId)
 *
 * Do NOT pass hiveOsProjectRecordId — Client PM OS endpoints require clientPmProjectRecordId.
 */
interface GasForwardPayload {
  gasUrl: string;
  clientPmProjectRecordId?: string;
  recordId?: string; // legacy — prefer clientPmProjectRecordId
  hiveOsProjectRecordId?: string; // rejected when alone — must not pass to Client PM OS
  projectName: string;
  parentFolderId?: string;
  clientType?: string;
  [key: string]: unknown;
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    route: "gas-forward2",
    description: "Forwards requests to Google Apps Script web apps",
    requiredFields: ["gasUrl", "clientPmProjectRecordId (or recordId)", "projectName"],
    optionalFields: ["parentFolderId", "clientType"],
    note: "Do NOT pass hiveOsProjectRecordId — Client PM OS requires clientPmProjectRecordId",
  });
}

export async function POST(req: Request) {
  try {
    const secret = process.env.AIRTABLE_PROXY_SECRET || "";
    const provided = req.headers.get("x-proxy-secret") || "";

    if (!secret || !provided || secret !== provided) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    let body: GasForwardPayload;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
    }

    if (!body || typeof body !== "object") {
      return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
    }

    const gasUrl = String(body.gasUrl || "");
    if (!gasUrl) {
      return NextResponse.json({ ok: false, error: "Missing gasUrl" }, { status: 400 });
    }

    // Canonical identifier: clientPmProjectRecordId (Client PM OS Projects record ID)
    // Reject hiveOsProjectRecordId when alone — never pass HIVE OS ID to Client PM OS
    const rawClientPm = body.clientPmProjectRecordId ?? body.recordId;
    const rawHiveOs = body.hiveOsProjectRecordId;

    if (rawHiveOs && !rawClientPm) {
      const message =
        "hiveOsProjectRecordId cannot be used for Client PM OS automation. " +
        "Provide clientPmProjectRecordId (Client PM OS Projects record ID).";
      console.log("[gas-forward2] Rejected: " + message);
      return NextResponse.json({ ok: false, error: message }, { status: 400 });
    }

    const projectIdResult = validateClientPmProjectRecordId(rawClientPm);

    if (!projectIdResult.ok) {
      console.log(
        "[gas-forward2] Validation failed:",
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
      console.warn("[gas-forward2] " + message);
      return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }

    const exists = await verifyClientPmProjectExists(clientPmProjectRecordId);
    if (!exists) {
      const message =
        `Record ${clientPmProjectRecordId} not found in Client PM OS Projects (base ${config.clientPmOsBaseId}). ` +
        "Verify clientPmProjectRecordId is from the Client PM OS base — do not pass HIVE OS record IDs.";
      console.log("[gas-forward2] " + message);
      return NextResponse.json(
        { ok: false, error: message },
        { status: 400 }
      );
    }

    const mapping = await resolveProjectIds({ clientPmProjectRecordId });

    logProjectRouteDebug({
      route: "gas-forward2",
      clientPmProjectRecordId,
      hiveOsProjectRecordId: mapping?.hiveOsProjectRecordId ?? null,
      baseId: config.clientPmOsBaseId || undefined,
      tableName: "Projects",
    });

    let url: URL;
    try {
      url = new URL(gasUrl);
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid gasUrl" }, { status: 400 });
    }

    if (!ALLOWED.has(url.hostname)) {
      return NextResponse.json({ ok: false, error: "Invalid host" }, { status: 400 });
    }

    // Extract gasUrl and forward everything else unchanged
    const { gasUrl: _ignored, ...payload } = body;

    // Forward with clientPmProjectRecordId only — never pass hiveOsProjectRecordId to Client PM OS
    const forwardPayload = {
      ...payload,
      clientPmProjectRecordId,
      recordId: clientPmProjectRecordId,
      ...(body.parentFolderId ? { parentFolderId: body.parentFolderId } : {}),
    };

    // Remove hiveOsProjectRecordId from forwarded payload
    delete forwardPayload.hiveOsProjectRecordId;

    console.log("[gas-forward2] Forwarding to GAS:", {
      gasUrl: gasUrl.slice(0, 60) + "...",
      clientPmProjectRecordId,
      projectName: forwardPayload.projectName || "(missing)",
      parentFolderId: forwardPayload.parentFolderId || "(not provided)",
      clientType: forwardPayload.clientType || "(not provided)",
      payloadKeys: Object.keys(forwardPayload),
    });

    const upstream = await fetch(gasUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(forwardPayload),
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

    return NextResponse.json({
      ...parsed,
      upstreamStatus: upstream.status,
      _forwarded: {
        parentFolderId: forwardPayload.parentFolderId || null,
        clientPmProjectRecordId: forwardPayload.clientPmProjectRecordId || null,
        projectName: forwardPayload.projectName || null,
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: "Proxy exception", detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}
