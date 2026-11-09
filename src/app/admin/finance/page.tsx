import { FinanceDashboard } from "@/components/admin/FinanceDashboard";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";

function currentFinanceMonth(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value || "";
  return part("year") + "-" + part("month");
}

export default async function AdminFinancePage() {
  const session = await getSession();
  if (session?.role !== "admin") notFound();
  return <FinanceDashboard initialMonth={currentFinanceMonth()} />;
}
