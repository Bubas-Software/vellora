ALTER TABLE `caregiver_schedule_entries`
ADD COLUMN `payroll_amount_override_cents` integer
CONSTRAINT `caregiver_schedule_entries_payroll_amount_override_range`
CHECK (`payroll_amount_override_cents` IS NULL OR `payroll_amount_override_cents` BETWEEN 1 AND 100000000);
