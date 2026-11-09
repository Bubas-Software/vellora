import { notFound, redirect } from "next/navigation";
import {
  getCaregiverProfileByUserId,
  getUserById,
  listContractDocuments,
  listPatientsByCaregiver,
} from "@/lib/data";
import { CaregiverAccountDetails } from "@/components/admin/CaregiverAccountDetails";
import { isValidCaregiverId } from "@/components/admin/caregiver-directory";
import { getSession } from "@/lib/auth";

export default async function AdminCaregiverAccountPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isValidCaregiverId(id)) notFound();

  const caregiver = await getUserById(id);
  if (!caregiver || caregiver.role !== "cuidador" || caregiver.deleted_at) notFound();

  const linkedProfile = await getCaregiverProfileByUserId(id);
  if (linkedProfile) redirect(`/admin/cuidadores/perfil/${linkedProfile.id}`);

  const [patients, contracts] = await Promise.all([
    listPatientsByCaregiver(caregiver.id),
    listContractDocuments("caregiver_user", caregiver.id),
  ]);

  return (
    <CaregiverAccountDetails
      canDelete={(await getSession())?.role === "admin"}
      caregiver={{
        id: caregiver.id,
        name: caregiver.name,
        email: caregiver.email,
        phone: caregiver.phone,
      }}
      patients={patients}
      contracts={contracts}
    />
  );
}
