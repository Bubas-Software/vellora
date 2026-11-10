import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import { canAccessAdminArea } from "@/lib/permissions";
import { DashboardShell } from "@/components/DashboardShell";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (session?.roleSelectionRequired) redirect("/selecionar-perfil");
  if (!session || !canAccessAdminArea(session.role)) redirect("/login");

  const isAdmin = session.role === "admin";

  return (
    <DashboardShell
      title="Painel administrativo"
      userName={session?.name || ""}
      roleLabel={isAdmin ? "Administrador" : "Coordenação operacional"}
      navItems={[
        { href: "/admin", label: "Visão geral", icon: "📊" },
        { href: "/admin/leads", label: "Contatos recebidos", icon: "📨" },
        { href: "/admin/profissionais", label: "Candidaturas", icon: "📋" },
        { href: "/admin/pacientes", label: "Pacientes", icon: "🧑‍🤝‍🧑" },
        { href: "/admin/familias", label: "Famílias", icon: "👪" },
        { href: "/admin/cuidadores", label: "Cuidadores", icon: "🩺" },
        { href: "/admin/escalas", label: "Escalas", icon: "📅" },
        ...(isAdmin ? [
          { href: "/admin/finance", label: "Financeiro", icon: "💰" },
          { href: "/admin/precificacao", label: "Precificação", icon: "🧮" },
          { href: "/admin/projecoes", label: "Projeções", icon: "📈" },
          { href: "/admin/acessos", label: "Acessos administrativos", icon: "🔐" },
        ] : []),
      ]}
    >
      {children}
    </DashboardShell>
  );
}
