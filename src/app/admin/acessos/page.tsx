import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { listUsersByRole } from "@/lib/data";
import { CoordinatorAccessManager } from "@/components/admin/CoordinatorAccessManager";

export default async function AdminAccessPage() {
  const session = await getSession();
  if (session?.role !== "admin") notFound();

  const accounts = await listUsersByRole("coordenador_operacional", true);
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <header>
        <p className="eyebrow">Administração de acessos</p>
        <h2 className="mt-2 text-2xl font-semibold text-[var(--foreground)]">Coordenação operacional</h2>
        <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
          Crie e administre contas com permissões operacionais limitadas.
        </p>
      </header>
      <CoordinatorAccessManager
        accounts={accounts.map((account) => ({
          id: account.id,
          name: account.name,
          email: account.email,
          active: account.deleted_at === null,
        }))}
      />
    </div>
  );
}
