import { redirect } from "next/navigation";
import { getSession, roleHomePath } from "@/lib/auth";
import { ProfileRoleSelector } from "@/components/ProfileRoleSelector";

export default async function SelectProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const [session, params] = await Promise.all([getSession(), searchParams]);
  if (!session) redirect("/login");

  const roles = session.availableRoles || [session.role];
  if (roles.length === 1 && !session.roleSelectionRequired) {
    redirect(roleHomePath(roles[0]));
  }

  const next = typeof params.next === "string" ? params.next : undefined;
  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--page)] px-4 py-10">
      <ProfileRoleSelector roles={roles} next={next} />
    </main>
  );
}
