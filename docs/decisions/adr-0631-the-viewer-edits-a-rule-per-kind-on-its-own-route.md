---
id: D631
title: The viewer edits a rule per KIND on its own route — the kind is chosen first and locked, the sections come from the shared order, and the hub enforces what only an admin may author
status: accepted
date: 2026-09-25
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/nc-actions.ts
  - packages/addon-post-analysis/src/notification-center/timelapse/timelapse-rule-clear.ts
  - packages/addon-post-analysis/src/notification-center/summary/summary-rule-clear.ts
  - camstack/src/components/notifications/save-gate.ts
  - camstack/src/components/notifications/target-ownership.ts
  - camstack/src/components/notifications/rule-editor-sections.ts
covers:
  - camstack/src/components/notifications/rule-kind-nav.ts
  - camstack/src/components/notifications/rule-editor.ts
  - camstack/src/components/notifications/device-selection.ts
  - camstack/src/components/notifications/rule-test-result.ts
  - camstack/src/store/nc-rule-draft-store.ts
  - camstack/src/navigation/rule-routes.ts
  - camstack/src/data/use-me.ts
  - camstack/src/screens/notifications/rule-editor/**
  - camstack/app/(app)/rule/**
  - camstack/app/(app)/timelapse-rule/**
  - camstack/app/(app)/summary-rule/**
  - packages/addon-admin-ui/src/pages/system/device-selection.ts
  - scripts/check-device-selection-in-sync.ts
---

## Context

The phone's rule editor was one long screen, edited in place inside the
Rules / Targets / Snooze segment, and it had drifted from the admin editor
and from the rule itself:

- **Mixed kinds, converted live.** The rules list grouped by an ad-hoc
  "section" strip (all / detection / occupancy / audio), and the editor
  offered every kind's discriminator: authoring `audio` on a detection rule
  CONVERTED it into a sound rule while the operator typed, and the field set
  under his fingers changed with it.
- **Lost on a segment switch.** The editor was component state inside a
  segment; switching to Targets to add the target the rule needed threw the
  whole unsaved rule away.
- **Parity gaps.** The phone's Zod mirror did not carry `targetUsers`,
  `actions`, `confirm`, `groupIdleSec` or `media.linkedCameras`; it kept a
  `targets.min(1)` the hub had dropped, so a users-only rule failed its parse
  and VANISHED from the phone; it lacked four system kinds, so rules with them
  vanished too. A phone save then reverted `linkedCameras` to the hub's
  default. System rules were not authorable on the phone at all ("rimangono
  fuori le system rules"), and the digest editor deliberately authored a
  subset ("rule più semplici").
- **The admin-only fields were guarded by the phone's mirror.** `actions`
  (cap calls on devices — a lock, a siren) and `targetUsers` (delivery to
  OTHER people's phones) were kept off personal rules only because the
  viewer's schema stripped them. `nc.createRule` / `nc.updateRule` accepted
  them from any caller, so a crafted call from a non-admin could wire a siren
  onto his rule. Full parity on the phone would have handed that door to the
  UI.
- **Saves that destroyed what the phone could not see.** All three editors
  (rule, timelapse, digest) filtered stored targets down to the caller's OWN
  list and re-sent the result, so an admin saving a global rule deleted every
  other user's target, and the hub accepted it. The first fix kept unlisted
  targets for everyone — and every later save by a non-admin whose rule held a
  target he had since deleted was refused by the hub. The second fix split by
  role — and an `auth.me` that FAILED read as "not admin", so an admin on a
  bad read saved destructively again.

## Decision

The viewer edits a rule of ONE kind, on routes, from the section order the
admin editor is checked against, and the hub — not the phone — enforces what
only an admin may author.

- **The kind is chosen first and locked.** The rules list is a strip by kind
  (`viewerKindStrip`); creating asks for the kind (`KindPickerScreen`,
  `creatableKinds` — System only for a confirmed admin) or takes it from the
  strip. The editor never offers another kind's discriminator
  (`isKindLockedOut`). Changing a rule's kind means creating a new rule.
- **Sections come from the shared order.** `editorSectionsFor(kind, isAdmin)`
  is `ruleEditorSectionsForKind` from `@camstack/types` (the same call the
  admin's tabs are checked against), minus Actions for a non-admin. The viewer
  owns only the i18n keys and the CLAIM map — which form field each section
  edits — and its spec requires every field to be claimed exactly once.
- **Routes plus a memory-only draft.** `/rule/new` (kind picker, or the
  summary of a new rule of `?kind=`), `/rule/[id]` (summary),
  `/rule/[id]/[section]` (one section), `/timelapse-rule/[id]`,
  `/summary-rule/[id]`. The draft lives in `nc-rule-draft-store.ts`, plain
  Zustand with NO persistence, keyed by rule id and kind; save discards it
  only after every write landed. The summary holds a back guard
  (`usePreventRemove` + `useConfirm`, so the iOS swipe and web are covered).
- **Full parity, both families included.** Every rule field is modelled
  (`nc-rule-mirror-parity.spec.ts` walks the viewer and PUBLISHED schemas);
  system rules are authorable by admins with every authorable kind; the
  timelapse and digest editors author every field. An emptied field is
  removed with `clear`, never by omission — and for the two families that
  `clear` is ADDON-LOCAL (below).
- **The hub enforces admin-only fields.** `assertAdminOnlyFields`
  (`nc-actions.ts`, `NC_ADMIN_ONLY_RULE_FIELDS = actions, targetUsers`) refuses
  a non-admin that CHANGES or CLEARS either field on `nc.createRule` /
  `nc.updateRule`; an ECHO deep-equal to the stored value passes, so a
  non-admin re-sending an admin-wired rule saves. The phone sends and clears
  those fields only for a confirmed admin. The addressee invariant has one
  authority (`assertRuleHasAddressee` / `assertPatchKeepsAddressee`), used by
  the bridge and the cap provider alike.
- **A save never guesses the role or the target list.** `target-ownership.ts`:
  an admin's save keeps stored targets not in his list VERBATIM (another
  user's, or deleted since — a read never destroys, D49); a non-admin's is
  filtered to his own. The role is `AdminVerdict` = `pending | admin |
  not-admin | unknown`; `unknown` is a FAILED read. For visibility it means
  not-admin; for every Save (`save-gate.ts`, in all three editors) it BLOCKS,
  as do `pending` and an unanswered or failed targets read — with a line
  saying which.
- **A kept deleted device is drawn, not hidden.** Every NC device picker in
  both UIs renders a selected id the answered camera list lacks as
  "Device #id — removed" (judged against the whole fleet, looked up by id),
  deselectable, never auto-dropped. The helper is one file copied byte-for-byte
  into both UIs. Removing the id from the stores is D633.
- **Testing from the phone is admin-only, twice.** The dry-run (Conditions)
  and Test now (summary) show only for a confirmed admin, and both server
  methods are `auth: 'admin'` (`notificationRules.testRule`, `nc.testRule`).

## Consequences

- Changing a rule's kind on the phone means creating a new rule; the phone
  never converts one.
- A future section added to `NC_RULE_EDITOR_SECTION_ORDER` appears in the
  viewer with no viewer change, and the claim spec fails until its fields are
  placed in it — a field cannot live nowhere.
- A draft does not survive an app kill; that is chosen (no stale draft of a
  rule edited elsewhere is ever resurrected).
- **Deploy order.** The timelapse / digest `clear` is a new key on
  `nc.upsertTimelapseRule` / `nc.upsertSummaryRule`; an older addon strips it
  (Zod) and an emptied field silently comes back. `addon-post-analysis` must
  deploy BEFORE the viewer OTA that sends it. The admin-only guard also ships
  with the addon; until then the phone's own gating is the only guard it had
  before.
- On a hub whose `auth.me` always fails (older than the procedure), no
  notification editor on the phone can save: the role-unknown line says why.
  Guessing either role destroys something.
- The phone cannot AUTHOR a caption's `''` ("no caption at all") on a
  timelapse or digest: an empty box means the default caption. A stored `''`
  is kept and gets its own hint.
- Supersedes two operator constraints: "rimangono fuori le system rules" (for
  admins only — a non-admin still cannot create one) and the digest's "rule
  più semplici".

## Enforcement

- Hub: `nc-actions.spec.ts` (non-admin set / change / clear refused, echo
  allowed, addressee on both paths); `timelapse-store.spec.ts`,
  `summary-store.spec.ts`, `nc-timelapse-actions.spec.ts`,
  `nc-summary-actions.spec.ts` (set+clear refused, clear on create refused,
  clear enum). Each gate removed once and watched fail.
- Viewer: `rule-editor-sections.spec.ts` (claimed exactly once; Actions
  admin-only; locked discriminators), `rule-kind-nav.spec.ts`,
  `nc-rule-mirror-parity.spec.ts`, `target-ownership.spec.ts`,
  `save-gate.spec.ts`, `use-me.spec.ts`, `use-rule-draft-save.spec.ts`, the
  timelapse / summary editor mount specs, `rule-test-mount.spec.ts`.
- `scripts/check-device-selection-in-sync.ts` (pre-commit and CI): the
  admin and viewer `device-selection.ts` copies and their specs are identical.
  CI has no submodule and says "NOT checked"; pre-commit is where it bites.
- Review only: that a new admin-only rule field is added to
  `NC_ADMIN_ONLY_RULE_FIELDS`.
