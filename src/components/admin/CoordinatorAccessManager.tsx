"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export type CoordinatorAccount = {
  id: string;
  name: string;
  email: string;
  active: boolean;
  profileActive: boolean;
};

type ExistingAccount = {
  id: string;
  name: string;
  email: string;
  active: boolean;
  roles: Array<"admin" | "coordenador_operacional" | "familia" | "cuidador">;
};

const roleLabels = {
  admin: "Admin",
  coordenador_operacional: "Coordenação",
  familia: "Família",
  cuidador: "Profissional",
};

const inputClass = "block min-h-11 w-full rounded-xl border border-[var(--border-strong)] bg-white px-3 text-sm";

export function CoordinatorAccessManager({ accounts }: { accounts: CoordinatorAccount[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [existingAccount, setExistingAccount] = useState<ExistingAccount | null>(null);

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    setExistingAccount(null);
    try {
      const checkResponse = await fetch("/api/admin/coordinators", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check_email", email }),
      });
      const check = await checkResponse.json().catch(() => null) as {
        exists?: boolean;
        account?: ExistingAccount;
        error?: string;
      } | null;
      if (!checkResponse.ok) throw new Error(check?.error || "Não foi possível verificar o e-mail.");
      if (check?.exists && check.account) {
        setPassword("");
        setExistingAccount(check.account);
        return;
      }

      const response = await fetch("/api/admin/coordinators", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      const result = await response.json().catch(() => null) as {
        error?: string;
        code?: string;
        account?: ExistingAccount;
      } | null;
      if (response.status === 409 && result?.code === "account_exists" && result.account) {
        setPassword("");
        setExistingAccount(result.account);
        return;
      }
      if (!response.ok) throw new Error(result?.error || "Não foi possível criar a conta.");
      setName("");
      setEmail("");
      setPassword("");
      setExistingAccount(null);
      setMessage("Conta criada. O acesso já está ativo.");
      router.refresh();
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Não foi possível criar a conta.");
    } finally {
      setSaving(false);
    }
  }

  async function checkExistingAccount() {
    setSaving(true);
    setError("");
    setMessage("");
    setExistingAccount(null);
    try {
      const response = await fetch("/api/admin/coordinators", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check_email", email }),
      });
      const result = await response.json().catch(() => null) as {
        exists?: boolean;
        account?: ExistingAccount;
        error?: string;
      } | null;
      if (!response.ok) throw new Error(result?.error || "Não foi possível verificar o e-mail.");
      if (result?.exists && result.account) {
        setExistingAccount(result.account);
      } else {
        setMessage("Nenhuma conta foi encontrada com esse e-mail. Preencha o nome e a senha inicial para criar uma nova conta.");
      }
    } catch (lookupError) {
      setError(lookupError instanceof Error ? lookupError.message : "Não foi possível verificar o e-mail.");
    } finally {
      setSaving(false);
    }
  }

  async function addCoordinatorToExistingAccount() {
    if (!existingAccount) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/admin/coordinators", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "grant_existing", userId: existingAccount.id, confirmed: true }),
      });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error || "Não foi possível adicionar o acesso.");
      setName("");
      setEmail("");
      setPassword("");
      setExistingAccount(null);
      setMessage("Perfil de coordenação adicionado. Os acessos e registros anteriores foram preservados.");
      router.refresh();
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Não foi possível adicionar o acesso.");
    } finally {
      setSaving(false);
    }
  }

  async function setAccountStatus(account: CoordinatorAccount) {
    if (!account.profileActive) {
      setError("A conta está inativa globalmente. Reative a conta antes de alterar o acesso de coordenação.");
      return;
    }
    setBusyId(account.id);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/admin/coordinators/${encodeURIComponent(account.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !account.active }),
      });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error || "Não foi possível atualizar a conta.");
      setMessage(account.active ? "Acesso desativado." : "Acesso reativado.");
      router.refresh();
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Não foi possível atualizar a conta.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-[var(--foreground)]">Criar acesso operacional</h2>
        <p className="mt-1 text-sm leading-6 text-[var(--muted)]">
          O perfil poderá gerenciar cadastros e atendimento, sem acesso a dados e ferramentas financeiras.
        </p>
        <form onSubmit={(event) => void createAccount(event)} className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium text-[var(--foreground)]">
            Nome completo
            <input className={`${inputClass} mt-1.5`} value={name} onChange={(event) => setName(event.target.value)} required minLength={2} maxLength={100} disabled={saving} />
          </label>
          <label className="text-sm font-medium text-[var(--foreground)]">
            E-mail de acesso
            <input className={`${inputClass} mt-1.5`} type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254} disabled={saving} />
          </label>
          <div className="sm:col-span-2">
            <button
              type="button"
              onClick={() => void checkExistingAccount()}
              disabled={saving || !email.trim()}
              className="min-h-10 rounded-xl border border-[var(--border-strong)] px-4 text-sm font-semibold text-[var(--foreground)] disabled:opacity-60"
            >
              {saving ? "Verificando…" : "Verificar se o e-mail já tem conta"}
            </button>
          </div>
          <label className="text-sm font-medium text-[var(--foreground)] sm:col-span-2">
            Senha inicial
            <input className={`${inputClass} mt-2 sm:max-w-md`} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={12} maxLength={128} disabled={saving} />
            <span className="mt-1 block text-xs font-normal text-[var(--muted)]">Use uma senha provisória com pelo menos 12 caracteres.</span>
          </label>
          <div className="sm:col-span-2">
            <button type="submit" disabled={saving} className="min-h-11 rounded-xl bg-[var(--brand)] px-4 text-sm font-semibold text-white hover:bg-[var(--brand-dark)] disabled:opacity-60">
              {saving ? "Criando…" : "Criar acesso"}
            </button>
          </div>
        </form>
        {message && <p role="status" className="mt-3 text-sm text-[var(--status-good)]">{message}</p>}
        {error && <p role="alert" className="mt-3 text-sm text-[var(--status-critical)]">{error}</p>}
      </section>

      {existingAccount && (
        <section className="rounded-2xl border border-[var(--accent)] bg-[var(--brand-light)] p-5 sm:p-6" role="alert">
          <h2 className="text-lg font-semibold text-[var(--brand-deep)]">Conta já cadastrada</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--foreground)]">
            <strong>{existingAccount.name}</strong> ({existingAccount.email}) já tem acesso de {existingAccount.roles
              .map((role) => roleLabels[role]).join(", ") || "usuário"}.
          </p>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
            Adicionar Coordenação cria um acesso adicional na mesma conta. O acesso atual, a senha e os registros existentes serão mantidos. Ao entrar, a pessoa poderá escolher qual perfil usar.
          </p>
          {!existingAccount.active ? (
            <p className="mt-3 text-sm font-semibold text-[var(--status-critical)]">
              Esta conta está inativa. Reative a conta primeiro; este fluxo não altera o status global.
            </p>
          ) : existingAccount.roles.includes("admin") ? (
            <p className="mt-3 text-sm font-semibold text-[var(--status-critical)]">
              O perfil Admin não pode ser combinado com outros acessos.
            </p>
          ) : (
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => void addCoordinatorToExistingAccount()}
                disabled={saving || existingAccount.roles.includes("coordenador_operacional")}
                className="min-h-11 rounded-xl bg-[var(--brand)] px-4 text-sm font-semibold text-white hover:bg-[var(--brand-dark)] disabled:opacity-60"
              >
                {saving ? "Salvando…" : existingAccount.roles.includes("coordenador_operacional")
                  ? "Coordenação já vinculada"
                  : "Confirmar e adicionar Coordenação"}
              </button>
              <button
                type="button"
                onClick={() => setExistingAccount(null)}
                disabled={saving}
                className="min-h-11 rounded-xl border border-[var(--border-strong)] px-4 text-sm font-semibold text-[var(--foreground)] disabled:opacity-60"
              >
                Cancelar
              </button>
            </div>
          )}
        </section>
      )}

      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-[var(--foreground)]">Contas da coordenação</h2>
        {accounts.length ? (
          <ul className="mt-4 divide-y divide-[var(--border)]">
            {accounts.map((account) => (
              <li key={account.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-semibold text-[var(--foreground)]">{account.name}</p>
                  <p className="mt-0.5 text-sm text-[var(--muted)]">{account.email}</p>
                  <p className={`mt-1 text-xs font-semibold ${account.active ? "text-[var(--status-good)]" : "text-[var(--muted)]"}`}>
                    {!account.profileActive ? "Conta globalmente inativa" : account.active ? "Acesso ativo" : "Acesso de coordenação desativado"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void setAccountStatus(account)}
                  disabled={busyId === account.id || !account.profileActive}
                  className="min-h-10 self-start rounded-xl border border-[var(--border-strong)] px-3 text-sm font-semibold text-[var(--foreground)] disabled:opacity-60 sm:self-center"
                >
                  {busyId === account.id ? "Salvando…" : account.active ? "Desativar acesso" : "Reativar acesso"}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-[var(--muted)]">Nenhuma conta de coordenação criada.</p>
        )}
      </section>
    </div>
  );
}
