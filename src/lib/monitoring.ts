export type MonitoringSource = "server" | "browser" | "stripe";
export type MonitoringSeverity = "error" | "warning";

export type MonitoringEvent = {
  source: MonitoringSource;
  code: string;
  route?: string;
  routeType?: string;
  status?: number;
  errorType?: string;
  severity?: MonitoringSeverity;
};

const SAFE_PAGE_GROUPS = new Set([
  "admin", "familia", "cuidador", "login", "solicitar-cuidado",
  "trabalhe-conosco", "esqueci-senha", "redefinir-senha",
]);

export function normalizeMonitoringRoute(input: string | undefined): string {
  if (!input) return "/app";
  let path = input.split(/[?#]/, 1)[0] || "";
  path = path.replace(/^\/?src\/app(?=\/)/, "").replace(/^\/?app(?=\/)/, "");
  path = path.replace(/\/(route|page|layout)(\.tsx?)?$/, "");
  const segments = path.split("/").filter(Boolean);
  if (segments[0] === "api") {
    if (segments[1] === "auth") return "/api/auth";
    if (segments[1] === "admin") return "/api/admin";
    if (segments[1] === "monitoring") return "/api/monitoring";
    if (["contracts", "records", "schedules"].includes(segments[1] || "")) {
      return "/api/" + segments[1];
    }
    return "/api";
  }
  const first = segments[0];
  return first && SAFE_PAGE_GROUPS.has(first) ? "/" + first : "/app";
}

export function normalizeMonitoringErrorType(value: string | undefined): string {
  return value && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(value) ? value : "Error";
}

function normalizeCode(value: string): string {
  return /^[A-Z][A-Z0-9_]{1,47}$/.test(value) ? value : "UNKNOWN_ERROR";
}

export async function reportMonitoringEvent(event: MonitoringEvent): Promise<void> {
  const webhookUrl = process.env.BUBAS_MONITORING_WEBHOOK_URL?.trim();
  const token = process.env.BUBAS_MONITORING_WEBHOOK_TOKEN?.trim();
  if (!webhookUrl || !token) return;

  let destination: URL;
  try {
    destination = new URL(webhookUrl);
  } catch {
    return;
  }
  if (
    destination.protocol !== "https:" ||
    destination.hostname !== "n8n.bubassoftware.com.br" ||
    !destination.pathname.startsWith("/webhook/")
  ) return;

  const source: MonitoringSource = ["server", "browser", "stripe"].includes(event.source)
    ? event.source
    : "server";
  const environment = process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown";
  const payload = {
    schemaVersion: 1,
    app: "vellora",
    source,
    code: normalizeCode(event.code),
    severity: event.severity === "warning" ? "warning" : "error",
    route: normalizeMonitoringRoute(event.route),
    routeType: event.routeType && /^[A-Za-z][A-Za-z -]{0,31}$/.test(event.routeType)
      ? event.routeType
      : undefined,
    status: Number.isInteger(event.status) && event.status! >= 400 && event.status! <= 599
      ? event.status
      : undefined,
    errorType: normalizeMonitoringErrorType(event.errorType),
    environment: /^[A-Za-z0-9._-]{1,32}$/.test(environment) ? environment : "unknown",
    occurredAt: new Date().toISOString(),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(destination, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bubas-monitor-token": token,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) console.warn("[monitoring] O n8n recusou o evento.");
  } catch {
    console.warn("[monitoring] Não foi possível encaminhar o incidente ao n8n.");
  } finally {
    clearTimeout(timeout);
  }
}
