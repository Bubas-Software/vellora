"use client";

import { useState } from "react";
import type { Role } from "@/lib/auth";

const roleCopy: Record<Role, { title: string; description: string }> = {
  admin: { title: "Admin", description: "Acesso completo à gestão da plataforma." },
  coordenador_operacional: { title: "Coordenação", description: "Acesso operacional a cadastros, escalas e atendimento." },
  familia: { title: "Família", description: "Acompanhe as informações e os cuidados da sua família." },
  cuidador: { title: "Profissional", description: "Acesse sua escala e seus registros de atendimento." },
};

export function ProfileRoleSelector({ roles, next }: { roles: Role[]; next?: string }) {
  const [loadingRole, setLoadingRole] = useState<Role | null>(null);
  const [error, setError] = useState("");

  async function chooseRole(role: Role) {
    setLoadingRole(role);
    setError("");
    try {
      const response = await fetch("/api/auth/select-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, next }),
      });
      const result = await response.json().catch(() => null) as { redirect?: string; error?: string } | null;
      if (!response.ok) throw new Error(result?.error || "Não foi possível selecionar esse perfil.");
      const redirect = typeof result?.redirect === "string" && result.redirect.startsWith("/") && !result.redirect.startsWith("//")
        ? result.redirect
        : "/";
      window.location.assign(redirect);
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : "Não foi possível selecionar esse perfil.");
      setLoadingRole(null);
    }
  }

  return (
    <div className="w-full max-w-2xl rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[0_20px_60px_rgba(8,54,49,0.08)] sm:p-8">
      <p className="text-xs font-bold uppercase tracking-[0.14em] text-[var(--accent-dark)]">Perfis vinculados à sua conta</p>
      <h1 className="font-display mt-3 text-3xl text-[var(--brand-deep)]">Como deseja entrar?</h1>
      <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
        A escolha vale para esta sessão. Seus outros acessos e registros continuam vinculados à mesma conta.
      </p>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {roles.map((role) => (
          <button
            key={role}
            type="button"
            onClick={() => void chooseRole(role)}
            disabled={loadingRole !== null}
            className="rounded-2xl border border-[var(--border)] bg-white p-5 text-left transition hover:border-[var(--brand)] hover:bg-[var(--brand-light)] disabled:cursor-wait disabled:opacity-60"
          >
            <span className="block text-lg font-semibold text-[var(--foreground)]">{roleCopy[role].title}</span>
            <span className="mt-1 block text-sm leading-5 text-[var(--muted)]">{roleCopy[role].description}</span>
            {loadingRole === role && <span className="mt-3 block text-xs font-semibold text-[var(--brand)]">Abrindo perfil…</span>}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="mt-4 text-sm text-[var(--status-critical)]">{error}</p>}
    </div>
  );
}
