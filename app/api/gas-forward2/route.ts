import { NextResponse } from "next/server";

const ALLOWED = new Set(["script.google.com", "script.googleusercontent.com"]);

export async function GET() {
  return NextResponse.json({ ok: true, route: "gas-forward2" });
}

export async function POST(req: Request) {
  try {
    const secret = process.env.AIRTABLE_PROXY_SECRET || "";
    const provided = req.headers.get("x-proxy-secret") || "";

    if (!secret || !provided || secret !== provided) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    let body: any = null;
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
