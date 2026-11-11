import { reportClientMonitoringEvent } from "@/lib/monitoring-client";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function pageGroup(pathname: string): string {
  const first = pathname.split("/").filter(Boolean)[0] || "public";
  const allowed = new Set([
    "admin", "familia", "cuidador", "login", "solicitar-cuidado",
    "trabalhe-conosco", "esqueci-senha", "redefinir-senha",
  ]);
  return allowed.has(first) ? "/" + first : "/app";
}

function requestDetails(input: RequestInfo | URL, init?: RequestInit) {
  try {
    const inputUrl = input instanceof Request ? input.url : input.toString();
    const url = new URL(inputUrl, location.href);
    const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    const sameOriginApi = url.origin === location.origin &&
      url.pathname.startsWith("/api/") &&
      url.pathname !== "/api/monitoring/client";
    const velloraSupabase = url.hostname === "punannbkoiekhvbnqqkh.supabase.co";
    const supabaseDataApi = velloraSupabase &&
      (url.pathname.startsWith("/rest/v1/") || url.pathname.startsWith("/storage/v1/"));
    return { method, url, sameOriginApi, supabaseDataApi };
  } catch {
    return undefined;
  }
}

const monitoredWindow = window as Window & { __bubasMonitoringInstalled?: boolean };
if (!monitoredWindow.__bubasMonitoringInstalled) {
  monitoredWindow.__bubasMonitoringInstalled = true;

  window.addEventListener("error", (event) => {
    if (!(event.error instanceof Error) && event.target !== window) return;
    reportClientMonitoringEvent(
      "CLIENT_ERROR",
      event.error instanceof Error ? event.error.name : "Error",
      pageGroup(location.pathname),
    );
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    if (reason instanceof DOMException && reason.name === "AbortError") return;
    reportClientMonitoringEvent(
      "UNHANDLED_REJECTION",
      reason instanceof Error ? reason.name : "UnhandledRejection",
      pageGroup(location.pathname),
    );
  });

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const details = requestDetails(input, init);
    try {
      const response = await originalFetch(input, init);
      if (details?.sameOriginApi && response.status >= 500) {
        reportClientMonitoringEvent("API_SERVER_ERROR", "HttpError", pageGroup(location.pathname), response.status);
      } else if (
        details?.sameOriginApi &&
        WRITE_METHODS.has(details.method) &&
        response.status >= 400
      ) {
        reportClientMonitoringEvent("API_WRITE_FAILED", "HttpError", pageGroup(location.pathname), response.status);
      } else if (details?.supabaseDataApi && response.status >= 500) {
        reportClientMonitoringEvent("SUPABASE_SERVICE_ERROR", "SupabaseError", "/supabase", response.status);
      } else if (
        details?.supabaseDataApi &&
        WRITE_METHODS.has(details.method) &&
        response.status >= 400
      ) {
        reportClientMonitoringEvent("SUPABASE_WRITE_FAILED", "SupabaseError", "/supabase", response.status);
      }
      return response;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      const errorType = error instanceof Error ? error.name : "NetworkError";
      if (details?.sameOriginApi) {
        reportClientMonitoringEvent("API_NETWORK_ERROR", errorType, pageGroup(location.pathname));
      } else if (details?.supabaseDataApi) {
        reportClientMonitoringEvent("SUPABASE_NETWORK_ERROR", errorType, "/supabase");
      }
      throw error;
    }
  };
}

