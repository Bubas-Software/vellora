import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isSafePreview } from "@/lib/preview";
import {
  normalizeMonitoringErrorType,
  normalizeMonitoringRoute,
  reportMonitoringEvent,
} from "@/lib/monitoring";

const ALLOWED_CODES = new Set([
  "CLIENT_ERROR",
  "UNHANDLED_REJECTION",
  "API_WRITE_FAILED",
  "API_SERVER_ERROR",
  "API_NETWORK_ERROR",
  "SUPABASE_SERVICE_ERROR",
  "SUPABASE_WRITE_FAILED",
  "SUPABASE_NETWORK_ERROR",
]);
type RateBucket = { count: number; resetAt: number };
const buckets = new Map<string, RateBucket>();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;

function allowedByRateLimit(request: NextRequest): boolean {
  const address = request.headers.get("x-real-ip") || "unknown";
  const key = createHash("sha256").update(address).digest("hex").slice(0, 24);
  const now = Date.now();
  const current = buckets.get(key);
  const bucket = current && current.resetAt > now
    ? current
    : { count: 0, resetAt: now + WINDOW_MS };
  bucket.count += 1;
  buckets.set(key, bucket);
  if (buckets.size > 2_000) {
    for (const [bucketKey, value] of buckets) {
      if (value.resetAt <= now) buckets.delete(bucketKey);
      if (buckets.size <= 2_000) break;
    }
  }
  return bucket.count <= MAX_PER_WINDOW;
}

export async function POST(request: NextRequest) {
  if (isSafePreview()) return new NextResponse(null, { status: 204 });
  const origin = request.headers.get("origin");
  if (!origin || origin !== request.nextUrl.origin) {
    return NextResponse.json({ accepted: false }, { status: 403 });
  }

  if (Number(request.headers.get("content-length") || 0) > 2_048) {
    return NextResponse.json({ accepted: false }, { status: 413 });
  }
  let body: unknown;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > 2_048) {
      return NextResponse.json({ accepted: false }, { status: 413 });
    }
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ accepted: false }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ accepted: false }, { status: 400 });
  }

  const event = body as Record<string, unknown>;
  if (typeof event.code !== "string" || !ALLOWED_CODES.has(event.code)) {
    return NextResponse.json({ accepted: false }, { status: 400 });
  }
  if (!allowedByRateLimit(request)) {
    return NextResponse.json({ accepted: false }, { status: 429 });
  }

  const status = typeof event.status === "number" && Number.isInteger(event.status)
    ? event.status
    : undefined;
  if (status !== undefined && (status < 400 || status > 599)) {
    return NextResponse.json({ accepted: false }, { status: 400 });
  }
  await reportMonitoringEvent({
    source: "browser",
    code: event.code,
    route: typeof event.route === "string" ? normalizeMonitoringRoute(event.route) : "/app",
    errorType: normalizeMonitoringErrorType(typeof event.errorType === "string" ? event.errorType : undefined),
    ...(status !== undefined ? { status } : {}),
    severity: event.code === "API_WRITE_FAILED" ||
      event.code === "SUPABASE_WRITE_FAILED" && (status ?? 0) < 500
      ? "warning"
      : "error",
  });
  return new NextResponse(null, { status: 202 });
}
