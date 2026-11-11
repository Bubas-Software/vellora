const CLIENT_EVENT_CODES = new Set([
  "CLIENT_ERROR",
  "UNHANDLED_REJECTION",
  "API_WRITE_FAILED",
  "API_SERVER_ERROR",
  "API_NETWORK_ERROR",
  "SUPABASE_SERVICE_ERROR",
  "SUPABASE_WRITE_FAILED",
  "SUPABASE_NETWORK_ERROR",
]);

const SAFE_ROUTES = new Set([
  "/app", "/admin", "/familia", "/cuidador", "/login",
  "/solicitar-cuidado", "/trabalhe-conosco", "/esqueci-senha", "/redefinir-senha",
  "/api", "/api/auth", "/api/admin", "/api/monitoring",
  "/api/contracts", "/api/records", "/api/schedules", "/supabase",
]);

export function reportClientMonitoringEvent(
  code: string,
  errorType: string | undefined,
  route: string,
  status?: number,
): void {
  if (!CLIENT_EVENT_CODES.has(code)) return;
  const safeErrorType = errorType && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(errorType)
    ? errorType
    : "Error";
  const safeRoute = SAFE_ROUTES.has(route) ? route : "/app";
  const safeStatus = Number.isInteger(status) && status! >= 400 && status! <= 599
    ? status
    : undefined;

  void fetch("/api/monitoring/client", {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      errorType: safeErrorType,
      route: safeRoute,
      status: safeStatus,
    }),
  }).catch(() => undefined);
}
