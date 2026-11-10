"use client";

import { useState, FormEvent } from "react";
import Link from "next/link";

function safeRedirect(value: unknown, fallback: string): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : fallback;
}

export function LoginForm({ next }: { next?: string }) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Não foi possível entrar.");
        setLoading(false);
        return;
      }
      const choiceQuery = new URLSearchParams();
      if (typeof next === "string") choiceQuery.set("next", safeRedirect(next, "/"));
      const redirect = json.needsRoleSelection
        ? `/selecionar-perfil${choiceQuery.size ? `?${choiceQuery.toString()}` : ""}`
        : safeRedirect(next, safeRedirect(json.redirect, "/"));
      window.location.assign(redirect);
    } catch {
      setError("Erro de conexão. Tente novamente.");
      setLoading(false);
    }
  }

  return (
    <div className="w-full">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="login-email" className="mb-1.5 block text-sm font-semibold text-[var(--foreground)]">E-mail</label>
          <input
            id="login-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="form-control"
            placeholder="voce@email.com"
          />
        </div>
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <label htmlFor="login-password" className="block text-sm font-semibold text-[var(--foreground)]">Senha</label>
            <Link href="/esqueci-senha" className="text-xs font-bold text-[var(--brand)] hover:text-[var(--brand-dark)]">
              Esqueci minha senha
            </Link>
          </div>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="form-control"
            placeholder="••••••••"
          />
        </div>
        {error && <p className="text-sm text-[var(--status-critical)]" role="alert">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-full bg-[var(--brand-dark)] px-4 py-3 text-sm font-bold text-white hover:bg-[var(--brand-deep)] disabled:opacity-50"
        >
          {loading ? "Entrando..." : "Entrar"}
        </button>
      </form>
    </div>
  );
}
