import { notFound } from "next/navigation";
import {
  getCaregiverProfile,
  listContractDocuments,
  listContractDocumentsForCaregiver,
  listPatientsByCaregiver,
} from "@/lib/data";
import { CaregiverProfileDetails } from "@/components/admin/CaregiverProfileDetails";
import { isValidCaregiverId } from "@/components/admin/caregiver-directory";
import { getSession } from "@/lib/auth";

export default async function AdminCaregiverProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isValidCaregiverId(id)) notFound();

  const profile = await getCaregiverProfile(id);
  if (!profile) notFound();

  const [patients, contracts] = await Promise.all([
    profile.user_id ? listPatientsByCaregiver(profile.user_id) : Promise.resolve([]),
    profile.user_id
      ? listContractDocumentsForCaregiver(profile.user_id)
      : listContractDocuments("caregiver_profile", profile.id),
  ]);

  const session = await getSession();
  return <CaregiverProfileDetails profile={profile} patients={patients} contracts={contracts} canDelete={session?.role === "admin"} />;
}
