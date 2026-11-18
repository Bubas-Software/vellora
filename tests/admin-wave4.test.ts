import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFamilyUpdate } from "../src/lib/family-update";

function readProjectFile(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8").replaceAll("\r\n", "\n");
}

const familyRoute = readProjectFile("src/app/api/admin/families/[id]/route.ts");
const familyForm = readProjectFile("src/components/admin/FamilyEditForm.tsx");
const professionalPage = readProjectFile("src/app/admin/profissionais/page.tsx");
const professionalTable = readProjectFile("src/components/admin/ProfessionalApplicationsTable.tsx");
const manualCaregiverForm = readProjectFile("src/components/admin/NewCaregiverForm.tsx");
const manualCaregiverRoute = readProjectFile("src/app/api/admin/caregivers/route.ts");
const adminRecordRoute = readProjectFile("src/app/api/admin/patients/[id]/records/[recordId]/route.ts");
const patientDetail = readProjectFile("src/app/admin/pacientes/[id]/page.tsx");
const recordEditPage = readProjectFile("src/app/admin/pacientes/[id]/registros/[recordId]/page.tsx");
const recordCard = readProjectFile("src/components/RecordCard.tsx");

describe("Wave 4 administrativa — contratos de fonte", () => {
  describe("edição de famílias", () => {
    it("aceita PATCH com name/phone e encaminha somente esses campos", () => {
      expect(parseFamilyUpdate({ name: "  Família Silva  ", phone: "62 99999-0000" })).toEqual({
        ok: true,
        value: { name: "Família Silva", phone: "62 99999-0000" },
      });
      expect(familyRoute).toContain("export async function PATCH");
      expect(familyRoute).toContain("const parsed = parseFamilyUpdate(body);");
      expect(familyRoute).toContain("await updateFamilyUser(id, parsed.value);");
      expect(familyForm).toContain('method: "PATCH"');
      expect(familyForm).toContain('name: data.get("name")');
      expect(familyForm).toContain('phone: data.get("phone")');
    });

    it.each(["email", "password", "role", "status", "deleted_at"])(
      "bloqueia o campo somente leitura %s sem aceitar o payload",
      (field) => {
        const result = parseFamilyUpdate({ name: "Família Silva", [field]: "alteração indevida" });

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain(field);
      },
    );
  });

  describe("aprovação de candidaturas", () => {
    it("filtra candidaturas já aprovadas antes de renderizar a página", () => {
      expect(professionalPage).toContain(
        'const pendingApplications = applications.filter((application) => application.status !== "aprovado");',
      );
      expect(professionalPage).toContain("<ProfessionalApplicationsTable applications={pendingApplications} />");
    });

    it("remove otimisticamente a candidatura aprovada e atualiza os dados do servidor", () => {
      expect(professionalTable).toContain("const [hiddenIds, setHiddenIds] = useState<Set<string>>");
      expect(professionalTable).toContain('if (status === "aprovado")');
      expect(professionalTable).toContain("setHiddenIds((current) => new Set(current).add(id));");
      expect(professionalTable).toContain(
        "applications.filter((application) => !hiddenIds.has(application.id))",
      );
      expect(professionalTable).toContain("router.refresh();");
    });
  });

  describe("cadastro manual de profissionais", () => {
    it("exibe o erro retornado pela API e sempre encerra o estado de carregamento", () => {
      expect(manualCaregiverForm).toContain("setLoading(true);");
      expect(manualCaregiverForm).toContain("if (!res.ok)");
      expect(manualCaregiverForm).toContain("setError(json.error || \"Não foi possível cadastrar.\");");
      expect(manualCaregiverForm).toContain(
        "setError(\"Erro de conexão. O profissional não foi cadastrado. Tente novamente.\");",
      );
      expect(manualCaregiverForm).toContain("finally {");
      expect(manualCaregiverForm).toContain("setLoading(false);");
      expect(manualCaregiverForm).toContain("router.refresh();");
    });

    it("usa a mesma área profissional da candidatura pública e persiste a escolha", () => {
      expect(manualCaregiverForm).toContain("Cadastrar profissional");
      expect(manualCaregiverForm).toContain('name="profession"');
      expect(manualCaregiverForm).toContain("PROFESSION_OPTIONS.map");
      expect(manualCaregiverForm).toContain('profession: data.get("profession")');
      expect(manualCaregiverRoute).toContain("const VALID_PROFESSIONS = new Set");
      expect(manualCaregiverRoute).toContain("createManualCaregiver");
      expect(manualCaregiverRoute).toContain("Informe uma área profissional válida.");
    });
  });

  describe("registros diários no detalhe do paciente", () => {
    it("oferece PATCH e DELETE administrativos protegidos por admin e vinculados ao paciente", () => {
      expect(adminRecordRoute).toContain("export async function PATCH");
      expect(adminRecordRoute).toContain("export async function DELETE");
      expect(adminRecordRoute).toContain('const guard = await requireRole("admin");');
      expect(adminRecordRoute).toContain("const existing = await getRecord(recordId);");
      expect(adminRecordRoute).toContain("existing.patient_id !== patientId");
      expect(adminRecordRoute).toContain("await updateRecord(");
      expect(adminRecordRoute).toContain("await deleteRecord(recordId)");
    });

    it("liga o card do registro aos controles de editar e excluir", () => {
      expect(patientDetail).toContain("editHref={`/admin/pacientes/${patient.id}/registros/${r.id}`}");
      expect(patientDetail).toContain(
        "deleteEndpoint={isAdmin ? `/api/admin/patients/${patient.id}/records/${r.id}` : undefined}"
      );
      expect(recordEditPage).toContain("<DailyRecordForm");
      expect(recordEditPage).toContain("/api/admin/patients/${patient.id}/records/${record.id}");
      expect(recordCard).toContain("Editar registro");
      expect(recordCard).toContain('label="Excluir registro"');
      expect(recordCard).toContain("<DeleteButton");
    });

    it("mantém somente os registros diários no detalhe do paciente", () => {
      expect(patientDetail).not.toContain("RecordAuditTimeline");
      expect(patientDetail).not.toContain("Histórico de alterações");
      expect(patientDetail).toContain("Últimos registros diários");
    });
  });
});
