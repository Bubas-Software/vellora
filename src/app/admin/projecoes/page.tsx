import { ProjectionDashboard } from "@/components/admin/ProjectionDashboard";
import { getActivePatientCount, getFinanceDashboardSnapshot } from "@/lib/data";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";

function currentMonthInSaoPaulo(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value || "";
  return part("year") + "-" + part("month");
}

export default async function AdminProjectionsPage() {
  const session = await getSession();
  if (session?.role !== "admin") notFound();
  const initialMonth = currentMonthInSaoPaulo();
  const [activePatients, finance] = await Promise.all([
    getActivePatientCount(),
    getFinanceDashboardSnapshot(initialMonth),
  ]);
  const monthlyChargesCents = finance.charges.reduce((total, charge) => total + charge.amount_cents, 0);
  const averageRevenuePerPatientCents = activePatients
    ? Math.round(monthlyChargesCents / activePatients)
    : 0;
  const directTeamCostCents = finance.expenses
    .filter((expense) => expense.category === "equipe")
    .reduce((total, expense) => total + expense.amount_cents, 0);

  return (
    <ProjectionDashboard
      initialMonth={initialMonth}
      initialActivePatients={activePatients}
      initialAverageRevenuePerPatientCents={averageRevenuePerPatientCents}
      initialDirectTeamCostCents={directTeamCostCents}
    />
  );
}
