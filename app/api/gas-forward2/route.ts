import { NextResponse } from "next/server";

const ALLOWED = ["script.google.com", "script.googleusercontent.com"];

export async function POST(req: Request) {
  const secret = process.env.AIRTABLE_PROXY_SECRET;
  const provided = req.headers.get("x-proxy-secret");
  if (!secret || !provided || secret !== provided) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const gasUrl = (body.gasUrl as string) || "";
  if (!gasUrl) {
    return NextResponse.json({ ok: false, error: "Missing gasUrl" }, { status: 400 });
  }

  let url: URL;
  try {
    url = new URL(gasUrl);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid gasUrl" }, { status: 400 });
  }

  if (!ALLOWED.includes(url.hostname)) {
    return NextResponse.json({ ok: false, error: "Invalid host" }, { status: 400 });
  }

  const { gasUrl: _, ...payload } = body;

  let res: Response;
  try {
    res = await fetch(gasUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow",
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 502 });
  }

  const text = await res.text();

  if (text.toLowerCase().includes("<html") || text.trim().toLowerCase().startsWith("<!doctype")) {
    return NextResponse.json({ ok: false, error: "HTML response", bodySnippet: text.slice(0, 300) }, { status: 502 });
  }

  try {
    return NextResponse.json(JSON.parse(text));
  } catch {
    return NextResponse.json({ ok: false, error: "Non-JSON", bodySnippet: text.slice(0, 300) }, { status: 502 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true });
}
