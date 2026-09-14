import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
const localHost = (host: string) => ["localhost", "127.0.0.1", "[::1]"].includes(host);

export async function POST(request: NextRequest) {
  const fail = (detail: string, status = 503, code?: string) => NextResponse.json({ detail, ...(code ? { code } : {}) }, { status, headers: { "cache-control": "no-store" } });
  try {
    const origin = request.headers.get("origin");
    if (!origin) return fail("A local browser origin is required.", 403);
    const source = new URL(origin);
    if (!localHost(source.hostname) || source.host !== request.headers.get("host") || !["http:", "https:"].includes(source.protocol)) return fail("Live is restricted to this local browser.", 403);
    const reader = request.body?.getReader();
    let raw = "";
    if (reader) {
      const decoder = new TextDecoder();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          raw += decoder.decode(part.value, { stream: true });
          if (raw.length > 2048) { await reader.cancel(); return fail("Session request is too large.", 413); }
        }
        raw += decoder.decode();
      } finally { reader.releaseLock(); }
    }
    const body = raw ? JSON.parse(raw) : {};
    if (!body || typeof body !== "object" || Object.keys(body).some(key => key !== "resume_token") || (body.resume_token !== undefined && (typeof body.resume_token !== "string" || body.resume_token.length > 256))) return fail("Invalid session request.", 422);
    const backend = new URL(process.env.ACREIQ_BACKEND_URL || "http://127.0.0.1:8000");
    if (!localHost(backend.hostname) || !["http:", "https:"].includes(backend.protocol) || backend.username || backend.password) return fail("Live requires a local backend address.");
    const response = await fetch(new URL("/live/session", backend), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin, ...(body.resume_token ? { resume_token: body.resume_token } : {}) }),
      cache: "no-store", signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    if (!response.ok) return fail(typeof data.message === "string" ? data.message : typeof data.detail === "string" ? data.detail : "Live session is unavailable.", response.status, typeof data.code === "string" ? data.code : undefined);
    if (typeof data.token !== "string" || typeof data.resume_token !== "string" || data.websocket_path !== "/live/ws") return fail("Invalid Live relay response.");
    const socket = new URL("/live/ws", backend);
    socket.protocol = backend.protocol === "https:" ? "wss:" : "ws:";
    return NextResponse.json({ token: data.token, resume_token: data.resume_token, websocket_url: socket.href, model: data.model, max_duration_seconds: data.max_duration_seconds }, { headers: { "cache-control": "no-store" } });
  } catch { return fail("Live relay is unavailable. Photo upload and manual inputs remain available."); }
}
