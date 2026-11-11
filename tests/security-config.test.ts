import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

const projectRoot = process.cwd();

function readProjectFile(relativePath: string): string {
  return readFileSync(join(projectRoot, relativePath), "utf8");
}

describe("configuração do ticket SEC-DEPEND-HEADERS-CI", () => {
  it("mantém Next, sharp e eslint-config-next em versões corrigidas e alinhadas", () => {
    const packageJson = JSON.parse(readProjectFile("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const packageLock = JSON.parse(readProjectFile("package-lock.json")) as {
      packages?: Record<string, { version?: string }>;
    };

    const patchedNextVersion = "16.4.6";
    const patchedSharpVersion = "0.35.5";

    expect(packageJson.dependencies).toMatchObject({
      next: patchedNextVersion,
      sharp: patchedSharpVersion,
    });
    expect(packageJson.devDependencies?.["eslint-config-next"]).toBe(patchedNextVersion);
    expect(packageLock.packages?.["node_modules/next"]?.version).toBe(patchedNextVersion);
    expect(packageLock.packages?.["node_modules/sharp"]?.version).toBe(patchedSharpVersion);
    expect(packageLock.packages?.["node_modules/eslint-config-next"]?.version).toBe(patchedNextVersion);
    expect(packageLock.packages?.["node_modules/source-map-js"]?.version).toBe("1.2.2");
  });

  it("publica os headers defensivos e uma CSP compatível com os serviços usados", async () => {
    const rules = await nextConfig.headers?.();
    const headers = new Map(rules?.[0]?.headers?.map((header) => [header.key, header.value]));
    const csp = headers.get("Content-Security-Policy") ?? "";

    expect(rules?.[0]?.source).toBe("/(.*)");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("Permissions-Policy")).toContain("camera=()");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("https://www.googletagmanager.com");
    expect(csp).toContain("https://challenges.cloudflare.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("*.supabase.co");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("faz o CI auditar produção e construir o mesmo artefato da Vercel", () => {
    const workflow = readProjectFile(".github/workflows/ci.yml");

    expect(workflow).toContain("npm audit --omit=dev --audit-level=high");
    expect(workflow).toContain("npm run build:vercel");
    expect(workflow).not.toContain("npm audit fix --force");
    expect(workflow).not.toContain("run: npm run build\n");
  });
});
