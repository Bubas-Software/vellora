import { describe, expect, it } from "vitest";
import {
  normalizeMonitoringErrorType,
  normalizeMonitoringRoute,
} from "../src/lib/monitoring";

describe("Vellora monitoring sanitization", () => {
  it("keeps only a route group and drops query strings and record identifiers", () => {
    expect(normalizeMonitoringRoute(
      "/api/admin/patients/123e4567-e89b-12d3-a456-426614174000?name=private",
    )).toBe("/api/admin");
    expect(normalizeMonitoringRoute(
      "/cuidador/paciente/123e4567-e89b-12d3-a456-426614174000",
    )).toBe("/cuidador");
  });

  it("rejects arbitrary route and error-name text", () => {
    expect(normalizeMonitoringRoute("/unknown/private/identifier")).toBe("/app");
    expect(normalizeMonitoringErrorType("Bearer token with spaces")).toBe("Error");
  });
});
