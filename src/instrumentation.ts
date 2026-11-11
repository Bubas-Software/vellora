import type { Instrumentation } from "next";
import { reportMonitoringEvent } from "./lib/monitoring";

export const onRequestError: Instrumentation.onRequestError = async (error, _request, context) => {
  await reportMonitoringEvent({
    source: "server",
    code: "NEXT_REQUEST_ERROR",
    route: context.routePath,
    routeType: context.routeType,
    errorType: error instanceof Error ? error.name : "Error",
  });
};
