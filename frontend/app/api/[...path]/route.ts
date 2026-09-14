import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
const routes = new Map([
  ["health", "GET"],
  ["sample", "GET"],
  ["optimize", "POST"],
  ["scan", "POST"],
  ["site-comparisons", "POST"],
  ["site-comparisons/verify", "POST"],
  ["site-comparisons/fixture", "GET"],
]);

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const route = path.join("/");
  if (routes.get(route) !== request.method)
    return NextResponse.json({ detail: "Not found" }, { status: 404 });
  const base = process.env.ACREIQ_BACKEND_URL || "http://127.0.0.1:8000";
  try {
    const limit = route === "scan" ? 10 * 1024 * 1024 + 64 * 1024
      : route === "site-comparisons" ? 256 * 1024
      : route === "site-comparisons/verify" ? 8 * 1024 : 64 * 1024;
    let body: Uint8Array<ArrayBuffer> | undefined;
    if (request.method === "POST" && request.body) {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > limit) {
            await reader.cancel();
            return NextResponse.json({ detail: "Request exceeds the upload limit." }, { status: 413 });
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    }
    const response = await fetch(`${base.replace(/\/$/, "")}/${route}`, {
      method: request.method,
      headers: request.headers.get("content-type")
        ? { "content-type": request.headers.get("content-type")! }
        : undefined,
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(route === "scan" ? 65000 : 15000),
    });
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  } catch {
    return NextResponse.json(
      {
        detail:
          "The AcreIQ engine is unavailable. Start the backend, then try again.",
      },
      { status: 503 },
    );
  }
}

export const GET = proxy;
export const POST = proxy;
