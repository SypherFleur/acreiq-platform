import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const METHODS: Record<string, string> = { health: "GET", sample: "GET", optimize: "POST", vision: "POST" };
async function proxy(request: NextRequest, context: { params: Promise<{ operation: string }> }) {
  const { operation } = await context.params;
  if (!METHODS[operation]) return NextResponse.json({ detail: "Unknown endpoint." }, { status: 404 });
  if (request.method !== METHODS[operation]) return NextResponse.json({ detail: "Method not allowed." }, { status: 405 });
  // Fixed operation allowlist and server-only origin; never proxy an arbitrary client URL.
  const origin = (process.env.ACREIQ_API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
  let body: string | undefined;
  if (request.method === "POST") {
    const limit = operation === "vision" ? 5_700_000 : 32_768;
    const reader = request.body?.getReader();
    if (!reader) return NextResponse.json({ detail: "Request body is required." }, { status: 400 });
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return NextResponse.json({ detail: "Request is too large." }, { status: 413 }); }
      chunks.push(value);
    }
    body = Buffer.concat(chunks).toString("utf-8");
    try { JSON.parse(body); } catch { return NextResponse.json({ detail: "Invalid JSON." }, { status: 400 }); }
  }
  try {
    const response = await fetch(`${origin}/${operation}`, { method: request.method, body,
      headers: { "Content-Type": "application/json" }, cache: "no-store", signal: AbortSignal.timeout(55000) });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch {
    return NextResponse.json({ detail: "AcreIQ API is unavailable. Start FastAPI on port 8000, or check the server-only ACREIQ_API_URL." }, { status: 503 });
  }
}
export const GET = proxy;
export const POST = proxy;
