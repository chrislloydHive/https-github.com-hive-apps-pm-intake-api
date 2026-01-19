import { NextResponse } from "next/server";

/**
 * GAS Proxy - Redirect-safe proxy for Google Apps Script Web Apps
 *
 * WHY THIS EXISTS:
 * - Airtable Automations cannot follow HTTP 302 redirects
 * - Google Apps Script /exec endpoints always return 302 redirects
 * - This server-side proxy follows redirects and returns JSON directly
 *
 * SECURITY:
 * - Requires x-proxy-secret header matching AIRTABLE_PROXY_SECRET env var
 * - Only allows requests to script.google.com and script.googleusercontent.com
 */

// Allowed hosts for gasUrl
const ALLOWED_HOSTS = ["script.google.com", "script.googleusercontent.com"];

/**
 * Health check endpoint
 */
export async function GET() {
  return NextResponse.json({ ok: true, service: "gas-proxy" });
}

/**
 * Proxy POST requests to Google Apps Script
 */
export async function POST(req: Request) {
  const requestId = crypto.randomUUID().slice(0, 8);

  try {
    // 1. Validate proxy secret
    const proxySecret = process.env.AIRTABLE_PROXY_SECRET;
    const providedSecret = req.headers.get("x-proxy-secret");

    if (!proxySecret) {
      console.error(`[gas-proxy][${requestId}] AIRTABLE_PROXY_SECRET env var not configured`);
      return NextResponse.json(
        { ok: false, error: "Proxy not configured" },
        { status: 500 }
      );
    }

    if (!providedSecret || providedSecret !== proxySecret) {
      console.warn(`[gas-proxy][${requestId}] Unauthorized: invalid or missing x-proxy-secret`);
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    // 2. Parse request body
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "Invalid JSON body" },
        { status: 400 }
      );
    }

    // 3. Determine GAS URL (from body or env fallback)
    const gasUrl = (body.gasUrl as string) || process.env.GAS_WEB_APP_URL || "";

    if (!gasUrl) {
      return NextResponse.json(
        { ok: false, error: "Missing gasUrl in body and no GAS_WEB_APP_URL env var configured" },
        { status: 400 }
      );
    }

    // 4. Validate gasUrl is a valid Google Apps Script URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(gasUrl);
    } catch {
      return NextResponse.json(
        { ok: false, error: "Invalid gasUrl: not a valid URL" },
        { status: 400 }
      );
    }

    if (!ALLOWED_HOSTS.includes(parsedUrl.hostname)) {
      return NextResponse.json(
        {
          ok: false,
          error: `Invalid gasUrl host: ${parsedUrl.hostname}. Allowed: ${ALLOWED_HOSTS.join(", ")}`,
        },
        { status: 400 }
      );
    }

    if (!parsedUrl.pathname.endsWith("/exec")) {
      return NextResponse.json(
        { ok: false, error: "Invalid gasUrl: must end with /exec" },
        { status: 400 }
      );
    }

    // 5. Build payload (exclude gasUrl from forwarded body)
    const { gasUrl: _removed, ...forwardPayload } = body;

    console.log(
      `[gas-proxy][${requestId}] Forwarding to GAS: ${parsedUrl.pathname.slice(-20)}... payload keys: ${Object.keys(forwardPayload).join(", ")}`
    );

    // 6. Forward request to GAS with redirect following
    let gasResponse: Response;
    try {
      gasResponse = await fetch(gasUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(forwardPayload),
        redirect: "follow",
      });
    } catch (fetchError: unknown) {
      const errMsg = fetchError instanceof Error ? fetchError.message : "Unknown fetch error";
      console.error(`[gas-proxy][${requestId}] Fetch error: ${errMsg}`);
      return NextResponse.json(
        { ok: false, error: `Failed to reach GAS: ${errMsg}` },
        { status: 502 }
      );
    }

    // 7. Read response as text
    const responseText = await gasResponse.text();
    const gasStatus = gasResponse.status;

    // 8. Check for HTML response (GAS error page or login redirect)
    const isHtml =
      responseText.toLowerCase().includes("<html") ||
      responseText.trimStart().toLowerCase().startsWith("<!doctype");

    if (isHtml) {
      console.error(
        `[gas-proxy][${requestId}] GAS returned HTML (status ${gasStatus}): ${responseText.slice(0, 100)}...`
      );
      return NextResponse.json(
        {
          ok: false,
          error: "GAS returned non-JSON (HTML response - may be auth error or script error)",
          status: gasStatus,
          bodySnippet: responseText.slice(0, 300),
        },
        { status: 502 }
      );
    }

    // 9. Attempt to parse JSON
    let jsonData: unknown;
    try {
      jsonData = JSON.parse(responseText);
    } catch {
      console.error(
        `[gas-proxy][${requestId}] GAS returned non-JSON (status ${gasStatus}): ${responseText.slice(0, 100)}...`
      );
      return NextResponse.json(
        {
          ok: false,
          error: "GAS returned non-JSON (parse failed)",
          status: gasStatus,
          bodySnippet: responseText.slice(0, 300),
        },
        { status: 502 }
      );
    }

    // 10. Return the GAS response as-is
    console.log(`[gas-proxy][${requestId}] GAS responded with status ${gasStatus}`);
    return NextResponse.json(jsonData, { status: gasStatus === 200 ? 200 : gasStatus });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[gas-proxy][${requestId}] Unexpected error: ${errMsg}`);
    return NextResponse.json(
      { ok: false, error: `Proxy error: ${errMsg}` },
      { status: 500 }
    );
  }
}

// Reject other methods
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
