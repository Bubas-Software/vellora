import { NextResponse } from "next/server";
import {
  normalizeMonitoringErrorType,
  normalizeMonitoringRoute,
  reportMonitoringEvent,
} from "./monitoring";

export async function apiError(
  error: unknown,
  context: string,
  publicMessage: string,
) {
  const errorType = normalizeMonitoringErrorType(
    error instanceof Error ? error.name : undefined,
  );
  const route = normalizeMonitoringRoute(context);
  console.error("[api] request failed", { route, error: errorType });
  await reportMonitoringEvent({
    source: "server",
    code: "API_OPERATION_FAILED",
    route: context,
    status: 503,
    errorType,
  });
  return NextResponse.json({ error: publicMessage }, { status: 503 });
}
