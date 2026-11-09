import { PricingCalculator } from "@/components/admin/PricingCalculator";
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

export default async function AdminPricingPage() {
  const session = await getSession();
  if (session?.role !== "admin") notFound();
  return <PricingCalculator initialMonth={currentMonthInSaoPaulo()} />;
}
