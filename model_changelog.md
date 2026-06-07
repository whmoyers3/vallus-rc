# VRC Engine Changelog

Record engine changes here with the snapshot filename so results can be traced back.

## Format

```
## YYYY-MM-DD — Short description

**Changed:** which constant, formula, or file

**Reason:** what bias or error motivated the change

**Result:** how many battery projects improved/regressed. Snapshot file name.
```

---

<!-- Add entries below, newest first -->

## 2026-06-06 — Dogwood excluded from aggregate accuracy stats

**Changed:** Battery record for Dogwood (two-unit townhome). `reference_valid = false` in the `calculations` table.

**Reason:** The Salas comparison snapshot for Dogwood shows Unit 2 with identical loads to Unit 1 (1,182 sf, same BTU/hr). VRC's inputs are correct (volume within 114 cf of Salas). The duplication is a `salas_pdf_import.py` parser bug that mirrors Unit 1 into Unit 2. Including Dogwood inflates aggregate cooling error by ~14,600 BTU/hr (109%) making it a statistical outlier.

**Result:** Dogwood excluded from `Recompute All` aggregate accuracy metrics and battery refresh totals until the PDF parser bug is fixed. Root cause is tracked separately — investigate `salas_pdf_import.py` unit summary section parsing.

**Action required:** Set `reference_valid = false` and `notes = 'Unit 2 Salas reference duplicates Unit 1 — parser bug in salas_pdf_import.py'` on the Dogwood battery row via Supabase dashboard or migration.
