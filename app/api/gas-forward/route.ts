import { NextResponse } from "next/server";

/**
 * GAS Forward - Minimal proxy that forwards POST requests to Google Apps Script
 *
 * This endpoint does NOT use Airtable SDK or any Airtable APIs.
 * It only forwards requests to GAS and returns the response.
 */

const ALLOWED_HOSTS = ["script.google.com", "script.googleusercontent.com"];

export async function POST(req: Request) {
  try {
    // 1. Check secret
    const secret = process.env.AIRTABLE_PROXY_SECRET;
    const provided = req.headers.get("x-proxy-secret");

    if (!secret || !provided || secret !== provided) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    // 2. Parse body
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
    }

    // 3. Get gasUrl
    const gasUrl = (body.gasUrl as string) || process.env.GAS_WEB_APP_URL || "";
    if (!gasUrl) {
      return NextResponse.json(
        { ok: false, error: "Missing gasUrl (and GAS_WEB_APP_URL not set)" },
        { status: 400 }
      );
    }

    // 4. Validate host
    let url: URL;
    try {
      url = new URL(gasUrl);
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid gasUrl" }, { status: 400 });
    }

    if (!ALLOWED_HOSTS.includes(url.hostname)) {
      return NextResponse.json({ ok: false, error: "Invalid gasUrl host" }, { status: 400 });
    }

    // 5. Forward to GAS (exclude gasUrl from payload)
    const { gasUrl: _, ...payload } = body;

    let gasRes: Response;
    try {
      gasRes = await fetch(gasUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "follow",
      });
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: `Fetch failed: ${e instanceof Error ? e.message : "unknown"}` },
        { status: 502 }
      );
    }

    // 6. Read response
    const text = await gasRes.text();
    const status = gasRes.status;

    // 7. Check for HTML
    if (text.toLowerCase().includes("<html") || text.trimStart().toLowerCase().startsWith("<!doctype")) {
      return NextResponse.json(
        { ok: false, error: "GAS returned non-JSON", gasStatus: status, bodySnippet: text.slice(0, 300) },
        { status: 502 }
      );
    }

    // 8. Parse JSON
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { ok: false, error: "GAS returned non-JSON", gasStatus: status, bodySnippet: text.slice(0, 300) },
        { status: 502 }
      );
    }

    // 9. Return GAS response
    return NextResponse.json(json);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Proxy error: ${e instanceof Error ? e.message : "unknown"}` },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({ ok: false, error: "Use POST" }, { status: 405 });
}

export async function PUT() {
  return NextResponse.json({ ok: false, error: "Use POST" }, { status: 405 });
}

export async function DELETE() {
  return NextResponse.json({ ok: false, error: "Use POST" }, { status: 405 });
}
