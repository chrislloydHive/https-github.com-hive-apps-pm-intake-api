import { NextResponse } from "next/server";

/**
 * Health check endpoint for gas-proxy
 */
export async function GET() {
  return NextResponse.json({ ok: true });
}
