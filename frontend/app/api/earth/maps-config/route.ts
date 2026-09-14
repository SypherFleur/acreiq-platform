import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export function GET() {
  // Intentionally browser-public Maps key only. Never fall back to model credentials.
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() || null;
  return NextResponse.json({ apiKey }, { headers: { "Cache-Control": "no-store" } });
}
