import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAuthProvider } from "../src/lib/auth-provider";
import { validateSupabaseConfig } from "../src/lib/supabase/config";
import { getSupabaseProxySession } from "../src/lib/supabase/proxy-session";
import { mapSupabaseRole, mapSupabaseSession } from "../src/lib/supabase/roles";
import { vi } from "vitest";

function readProjectFile(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("fundação do provider de autenticação", () => {
  it("mantém legacy como fallback para ausência ou valor desconhecido", () => {
    expect(resolveAuthProvider(undefined)).toBe("legacy");
    expect(resolveAuthProvider("legacy")).toBe("legacy");
    expect(resolveAuthProvider("supabase")).toBe("supabase");
    expect(resolveAuthProvider(" SUPABASE ")).toBe("supabase");
    expect(resolveAuthProvider("outro-provider")).toBe("legacy");
  });

  it("mapeia somente os papéis suportados pelo domínio", () => {
    expect(mapSupabaseRole("admin")).toBe("admin");
    expect(mapSupabaseRole(" FAMILIA ")).toBe("familia");
    expect(mapSupabaseRole("cuidador")).toBe("cuidador");
    expect(mapSupabaseRole("owner")).toBeNull();
    expect(mapSupabaseRole(null)).toBeNull();
  });

  it("usa o subject verificado por getClaims e ignora claims editáveis", async () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { name: "Nome do perfil", role: "familia", active: true },
        error: null,
      }),
    };
    const getUser = vi.fn();
    const rpc = vi.fn().mockResolvedValue({
      data: {
        available_roles: ["familia"],
        active_role: "familia",
        needs_selection: false,
      },
      error: null,
    });
    const client = {
      auth: {
        getClaims: vi.fn().mockResolvedValue({
          data: { claims: { sub: "verified-sub", role: "admin", name: "claim-editável" } },
          error: null,
        }),
        getUser,
      },
      from: vi.fn().mockReturnValue(query),
      rpc,
    } as never;

    await expect(getSupabaseProxySession(client)).resolves.toMatchObject({
      userId: "verified-sub",
      name: "Nome do perfil",
      role: "familia",
    });
    expect(getUser).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("get_my_profile_role_context");
    expect(query.eq).toHaveBeenNthCalledWith(1, "id", "verified-sub");
    expect(query.eq).toHaveBeenNthCalledWith(2, "active", true);
  });

  it("exige perfil ativo e usa nome do perfil, sem claims editáveis", () => {
    expect(
      mapSupabaseSession(
        { id: "auth-user-1", email: "familia@example.com" },
        { name: "Família Vellora", role: "familia", active: true },
      ),
    ).toMatchObject({
      userId: "auth-user-1",
      name: "Família Vellora",
      role: "familia",
    });
    expect(
      mapSupabaseSession(
        { id: "auth-user-2", email: "cuidador@example.com" },
        { name: "Cuidador", role: "cuidador", active: false },
      ),
    ).toBeNull();
    expect(
      mapSupabaseSession(
        { id: "auth-user-3", email: "user@example.com" },
        { name: "Usuário", role: "admin", active: true },
      )?.sessionVersion,
    ).toBe(0);
  });

  it("valida a configuração pública antes de criar um client", () => {
    expect(validateSupabaseConfig("https://example.supabase.co", "sb_publishable_test")).toEqual({
      url: "https://example.supabase.co",
      publishableKey: "sb_publishable_test",
    });
    expect(() => validateSupabaseConfig("", "sb_publishable_test")).toThrow();
    expect(() => validateSupabaseConfig("javascript:alert(1)", "sb_publishable_test")).toThrow();
  });
});

describe("fronteira segura entre Supabase e legacy", () => {
  it("mantém segredo fora do client e usa cookies SSR no server", () => {
    const client = readProjectFile("src/lib/supabase/client.ts");
    const server = readProjectFile("src/lib/supabase/server.ts");
    const proxy = readProjectFile("src/lib/supabase/proxy.ts");
    const proxySession = readProjectFile("src/lib/supabase/proxy-session.ts");

    expect(client).toContain("createBrowserClient");
    expect(client).toContain("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    expect(client).not.toMatch(/SUPABASE_(?:SERVICE_ROLE|SECRET)[_-]?KEY/i);
    expect(server).toContain("createServerClient");
    expect(server).toContain("cookies");
    expect(server).toContain("request.cookies.set(name, value)");
    expect(server).toContain("state.cookies.push(");
    expect(server).toContain("hardenedCookieOptions(options, request.url)");
    expect(proxy).toContain("NextResponse.next({ request })");
    expect(proxy).toContain("getSupabaseProxySession");
    expect(proxySession).toContain("getClaims");
    expect(proxySession).not.toContain("getUser");
    expect(server).not.toMatch(/SUPABASE_(?:SERVICE_ROLE|SECRET)[_-]?KEY/i);
  });

  it("mantém recovery sem token legado somente no provider Supabase", () => {
    const resetForm = readProjectFile("src/components/ResetPasswordForm.tsx");
    const resetPage = readProjectFile("src/app/redefinir-senha/page.tsx");

    expect(resetForm).toContain('provider === "legacy" && !token');
    expect(resetForm).toContain('provider === "legacy" ? { token } : {}');
    expect(resetForm).toContain("initialError");
    expect(resetPage).toContain("provider={provider}");
    expect(resetPage).toContain('params.recovery === "erro"');
  });

  it("mantém feedback visível para respostas inesperadas nos formulários de recovery", () => {
    const forgotForm = readProjectFile("src/components/ForgotPasswordForm.tsx");
    const resetForm = readProjectFile("src/components/ResetPasswordForm.tsx");

    expect(forgotForm).toContain("response.json().catch(() => null)");
    expect(forgotForm).toContain("servidor retornou uma resposta inesperada");
    expect(resetForm).toContain("response.json().catch(() => null)");
    expect(resetForm).toContain("Não foi possível conectar ao serviço");
  });

  it("mantém caminhos explícitos para login, reset, callback e logout Supabase", () => {
    const login = readProjectFile("src/app/api/auth/login/route.ts");
    const forgot = readProjectFile("src/app/api/auth/forgot-password/route.ts");
    const reset = readProjectFile("src/app/api/auth/reset-password/route.ts");
    const callback = readProjectFile("src/app/auth/callback/route.ts");
    const logout = readProjectFile("src/app/api/auth/logout/route.ts");
    const supabaseAuth = readProjectFile("src/lib/supabase/auth.ts");
    const supabaseServer = readProjectFile("src/lib/supabase/server.ts");

    expect(login).toContain("signInWithSupabase");
    expect(login).not.toContain('import { getUserByEmail }');
    expect(forgot).toContain("requestSupabasePasswordReset");
    expect(forgot).not.toContain("applySupabaseCookieState");
    expect(reset).toContain("updateSupabasePassword");
    expect(callback).toContain("exchangeCodeForSession");
    expect(callback).toContain("verifyOtp");
    expect(callback).toContain("token_hash");
    expect(supabaseAuth).toContain("createSupabaseStatelessClient");
    expect(supabaseAuth).toContain("SUPABASE_GLOBAL_SIGN_OUT_TIMEOUT_MS");
    expect(supabaseAuth).toContain("Promise.race");
    expect(supabaseServer).toContain('flowType: "implicit"');
    expect(logout).toContain("signOutWithSupabase");
    expect(supabaseAuth).toMatch(/signOutWithSupabase[\s\S]*?scope: "local"/);
  });

  it("encerra o estado de salvamento e exibe confirmação no reset de senha", () => {
    const resetForm = readProjectFile("src/components/ResetPasswordForm.tsx");

    expect(resetForm).toContain("AbortController");
    expect(resetForm).toContain("RESET_PASSWORD_REQUEST_TIMEOUT_MS");
    expect(resetForm).toContain("Senha redefinida com sucesso.");
    expect(resetForm).toContain("Ir para o login agora");
    expect(resetForm).not.toContain("router.refresh();");
  });

  it("não coloca chave privada nos exemplos de ambiente", () => {
    const examples = `${readProjectFile(".env.example")}\n${readProjectFile("SUPABASE_AUTH.md")}`;
    expect(examples).toContain("VELLORA_AUTH_PROVIDER=legacy");
    expect(examples).toContain("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    expect(examples).not.toMatch(/SUPABASE_(?:SERVICE_ROLE|SECRET)[_-]?KEY/i);
  });
});
