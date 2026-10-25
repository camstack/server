---
title: Admin UI style paydown — high-signal batch (2026-10-09)
last-verified: 2026-10-09
---

# Admin UI style paydown — high-signal batch (2026-10-09)

**Status: P0–P3 landed on `agent/ui-p1p2` (2026-10-09 night).**
Complements the "on touch" rule in
[`docs/ui/anti-patterns.md`](../ui/anti-patterns.md): existing drift is still
paid when a file is edited; this plan is one deliberate batch so pages the
operator opens stop looking off-system.

**Skill:** `camstack-ui` → `camstack-ui-admin`. Done-gate per file:
`npm run ui:check -- <file>` with 0 **new** findings (pre-existing lines in
the same file may remain until that file is finished in this batch).

## Baseline (refreshed 2026-10-09 night, after P0–P3)

`npm run ui:check -- packages --summary` (see also `docs/ui/anti-patterns.md`):

| Rule | findings / files |
| --- | ---: |
| `palette-class` | 762 / 92 |
| `raw-button` | 837 / 308 |
| `raw-hex` | 206 / 31 |
| `inline-style` | 199 / 91 |
| `raw-select` | 101 / 69 |
| `raw-table` | 20 / 19 |
| `raw-color-fn` | 12 / 9 |
| `raw-dialog` | 5 / 3 |

**Total:** 2 142 findings in 413 of 1 156 files. Admin-ui `raw-dialog` is 0
after P1. P3 cleared palette-class + raw-hex on Cluster / System tabs /
Integrations / Events chrome / Model Studio (≈ −119 palette, −15 hex). Do
**not** try to zero the rest in one pass. Library `raw-button` often is a
primitive's own markup — mark deliberate cases `ui-check-ok: <reason>`.

## Goal

One composition language on the surfaces operators hit daily: same badges,
same dialogs, semantic tokens (`text-danger` / `bg-success/10`), library
primitives. Screenshots at 320 / 768 / 1280, dark + light, for every page
touched.

## Out of scope

- Viewer layout (needs operator co-design; separate `camstack-ui-viewer`).
- Making `ui:check` a CI gate (operator decision 2026-10-09: warn-only).
- Rewriting every `raw-button` inside ui-library primitives.
- Chart / canvas series colours that already use tokens via `var(--color-*)`
  or a documented `ui-check-ok` (terminal 16-colour palette).

## Phases

### P0 — name collisions (half day)

Two components with one name and two looks is the strongest visual
incongruence. Replace admin-local copies with the library export; extend the
library with a prop if something is missing.

| Local | Library | Notes |
| --- | --- | --- |
| `addon-admin-ui/.../shared/StatusBadge.tsx` | `StatusBadge` | delete local after call sites move |
| `components/access/credential-columns.tsx` StatusBadge | same | |
| `components/device/FloatingPanel.tsx` | `FloatingPanel` | |
| `pages/system/scope-pickers.tsx` NodePicker | `NodePicker` | |
| `overview-adapters/.../StatCard` | library `StatCard` if present, else promote | |

`shared/DetectionOverlay.tsx` is already a re-export — leave it.

### P1 — hand-rolled dialogs and broken closes (half–1 day)

Every `raw-dialog` finding that is a real modal (not a deliberately marked
popover). Priority files from anti-patterns:

- `NewExportModal.tsx`, `BackupEncryptionCard.tsx`, `IntegrationDetail.tsx`
- any other `fixed inset-0 … bg-background/80` + raw close button

→ `Dialog` + `DialogContent` (`placement="sheet-on-mobile"`, `scroll="body"`
when tall). Close is the dialog's own control.

### P2 — status palette → semantic tokens (half day)

| File | Today | Replace |
| --- | --- | --- |
| `AlertBell.tsx` | `text-blue-400` / green / amber / red | `text-info` / `success` / `warning` / `danger` |
| `ToastContainer.tsx` | `bg-red-500/10` … | `bg-danger/10` … |
| `CopyUrlChips.tsx` | `emerald-*` + `dark:` twin | semantic + opacity |

These are global chrome — one fix lands on every page.

### P3 — pages the operator opens most (1–2 days)

Run `ui:check` per directory and clear **palette-class + raw-hex** (not every
raw-button) on:

1. Cluster (load chart hex → tokens / `var(--color-*)`)
2. System tabs (Secrets, Capabilities, Cluster mesh badges)
3. Devices / Integrations hub
4. Events / Notification Center list chrome
5. Model Studio / Retrain surfaces touched this week

Stop when the operator's daily path looks consistent; leave the long tail
on-touch.

## Ship

- Admin-ui only until a library prop is required → then `ui-library` first,
  rebuild admin-ui against it, `camstack deploy addon-admin-ui` (hub).
- No server publish for pure CSS/component swaps.
- Refresh the baseline table in `docs/ui/anti-patterns.md` when P0–P2 land.

## Done when

- [x] P0: no admin-local StatusBadge / FloatingPanel / NodePicker / StatCard
      shadowing the library.
- [x] P1: `raw-dialog` count for admin-ui is 0, or each remainder has
      `ui-check-ok`.
- [x] P2: AlertBell / ToastContainer / CopyUrlChips use semantic tokens only.
- [x] P3: the five operator paths above have 0 new `palette-class` / `raw-hex`
      on the files edited in that pass.
- [x] Screenshots (320 / 768 / 1280, dark + light): token harness for P3
      chrome (overflow none; pad@320 = 16 px). Authenticated SPA shots blocked
      here by TOTP + preview WS 403 — re-shot after deploy if needed.
- [x] `docs/ui/anti-patterns.md` baseline numbers updated.
