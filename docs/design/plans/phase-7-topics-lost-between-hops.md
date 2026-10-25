---
title: Phase 7 plan — arguments lost between one hop and the next
date: 2026-08-25
status: proposed
---

# Phase 7 — arguments lost between one hop and the next

Sub-plan of `../2026-08-25-viewer-track-query-plan.md`.

> **REWRITTEN on 2026-08-26.** The first draft was largely refuted
> by the hop map (`../2026-08-26-topic-hop-map.md`): three tasks out of
> four rested on false premises. The corrections are annotated task by
> task, because being wrong twice in the same way is the real risk here.

## The defect, in three instances — and they do NOT share a hop

| Field | What really lost it | Nature |
| --- | --- | --- |
| `columns` | `SettingsQueryInput` in `interfaces/storage.ts`: the **third** declaration of the same shape, a hand-written TS interface from which the engine destructures. The field was on **both** Zod schemas and the engine did not read it anyway | unverified provider/cap contract |
| `includeCrops` | the generated routers file, which is **type-only and does not run** (`trpc.router.ts:73` imports it with `import type`). No typed client could compile the call | drift of a generated file, at the type boundary |
| `verified` | `.loose()` is **shallow**: nested objects are stripped anyway. And `verified` does not exist at all in `TrackFlagFields` | nested Zod strip |

**There is no common hop.** The denominator is something else: *no hop of this
chain is verified against the cap it claims to serve.*

⚠ **Between the door and the engine there is no Zod parse at all.** The dispatcher forwards
verbatim, the UDS carries the whole thing. Every explanation that blames Zod on that
path is false — there was one written in `data-store-provider.cap.ts`, corrected


## Constraints

The global constraints of the parent plan apply. In addition:

- **`.strict()` breaks clients NEWER than the hub, not only old nodes.** The
  schema that validates is the hub's compiled Zod: a viewer updated via OTA or
  a more recent admin-ui that sends a new field would be rejected until
  the hub is upgraded. A tighter constraint than the first draft stated.
- **The level matters as much as the direction.** The top level is permissive *by
  construction* — it carries `nodeId`/`addonId` for routing — and cannot be
  tightened without breaking routing. The **nested** level is where `.strict()` is
  correct and low-risk, and it preserves the rolling-upgrade tolerance
  `LinkedCamerasCache` relies on.

---

## Task 7.2 — Why `codegen:check` did not break the build

> **Previous premise FALSE.** I said I would stop the codegen from emitting a
> call with zero arguments. It cannot: that branch is reachable only from
> `isVoidInput` (a strict `ZodVoid`). A test built to fail would not
> fail, and the fix would change nothing at runtime because **that file does not
> run**.

The right question: `codegen:check` has been in `ci.yml:128` since 2026-07-24.
The generated file was stale and CI was green. **Why?**

- [x] **Step 1** — reproduce: make the generated file stale, run `codegen:check`
      the way CI runs it. Does it pass or fail? → **It fails**, immediately,
      with exactly the expected `includeCrops` diff. The check has no bug.
- [x] **Step 2** — if it passes, find out why → it never passes when it runs. CI
      (`ci.yml`, id `241431591`) was `disabled_manually` on GitHub from
      2026-08-21 (~20 min after a failed run on an unrelated guard,
      "docs are in sync"), and stayed so for the whole staleness
      window (→, same day). Zero runs, not a
      green run — "CI was green" should be read as "CI was not running". Details in
      (planning repo: sessions/sessions.md) (2026-08-26). <!-- drift-ok: moved to the private planning repo -->
- [x] **Step 3** — test that fails on the real staleness →
      `scripts/__tests__/codegen-drift-check.spec.ts`, a fixture repo that pins
      exactly the `listIdentities` regression. Verified non-vacuous:
      temporarily broke `checkGeneratedDrift` → test red → restored.
- [x] **Step 4** — fix the check → extracted the `git diff` logic into
      `scripts/codegen-drift-check.ts` (previously without coverage of its own, unlike
      the sibling guards). The REAL CAUSE (disabled workflow)
      remains open: `gh workflow enable 241431591` was blocked by the
      sandbox classifier as a live GitHub state change out of scope for a
      commit — it requires a human. **Step 5** — commit done.

**Do not add a second guard before having answered why the first did not
work.** (Not added: the existing check is correct, it was only given
test coverage of its own for the logic that already existed.)

---

## Task 7.3 — The guard that pays off: provider verified against its cap

> **Correction.** The cap⇄cap parity I had planned finds the pair
> `settings-store`⇄`data-store-provider` — which is **already in parity**. It would
> never have caught `columns`, because the missing declaration is the third one and is not
> a cap.

The real cause: `ProviderRegistration.provider` is typed **`object`**
(`packages/types/src/interfaces/addon.ts:173`) on the heterogeneous path of
`onInitialize()`, so a registered provider is **never** compared with
`InferProvider<cap>`.

- [ ] **Step 1** — test: a provider that does not satisfy its cap must be
      rejected at registration, not discovered in production.
- [ ] **Step 2** — red.
- [ ] **Step 3** — tighten the type. Careful: the path is heterogeneous for a
      reason (several caps in one `onInitialize`) — the solution must keep that
      property, probably with a per-registration generic instead of a
      single type.
- [ ] **Step 4** — green. **Step 5** — fix what the compiler finds. One
      commit per provider.

Then, and only then:

- [ ] **Step 6** — extend `data-door-schema-parity.spec.ts` to the
      **nested** shapes (today it compares only first-level keys).

---

## Task 7.4 — `.strict()` where needed, on the two axes

> **Correction.** Classifying by read/write is not enough: see the constraints.
> And `.strict()` would **not** make `verified` get written — that field does not exist in
> `TrackFlagFields`. They are two distinct fixes.

- [ ] **Step 1** — inventory the permissive schemas and classify them on TWO axes:
      direction (read/write) and level (top-level/nested).
      **Bring the table to the operator before converting.**
- [ ] **Step 2** — test for every nested write schema: unknown key ⇒ 400.
- [ ] **Step 3** — red. **Step 4** — `.strict()` on the nested ones. Green.
- [ ] **Step 5** — separately: add `auditedAt` to `TrackFlagFields` plus the
      column (it is Task 2.3, which without this step has nothing to write).
- [ ] **Step 6** — codegen, commit, train, update nodes.
- [ ] **Step 7** — ADR: *"a partial patch is not a permissive patch"*, with the
      three cases and the clarification that none of the three is the same hop.

---

## Task 7.5 — The four defects the map found and no task covered

Each one is independent: one commit each, none blocks the others.

- [ ] **7.5a — `addonId` has no field in the hub→agent envelope**
      (`AgentCapForwardParams`, `cap-route-resolver.ts:162`;
      `agent-cap-dispatch-service.ts` rebuilds field by field, twice).
      Effect: provider selection for grouped runners works
      on the hub and **not** on the agent. The reverse direction
      (`hub-cap-forward.ts:46`) carries `native` and declares it mandatory —
      the asymmetry is an omission, not a design.
- [ ] **7.5b — `ipcChildLink` does not honour `nodePin`** (`trpc-links.ts:816`). Third
      instance of a family already fixed twice elsewhere. It is not wired into
      any chain, **but it has a passing spec** — that is, a test that guarantees
      dead code. Decide: delete it or repair it. Do not leave it as it is.
- [ ] **7.5c — `internal: true` does not prevent the mount.** `resolveCapMount` never
      reads the field. **Partially addressed**: `data-store-provider` was
      moved to `auth: 'admin'` on all 13 methods after
      verifying on the live hub that it returned a credential. **17 caps
      remain mounted with `internal: true`**, and these have no admin method at all:
      `oauth-integration`, `sso-bridge`, `vector-store`, `storage-evictable`,
      `custom-model-registry`, `embedding-encoder`, `admin-ui`, `viewer-ui`,
      `addon-pages-source`, `addon-widgets-source`.
      ⚠ **Do not force admin on all of them with a switch**: `viewer-ui` and
      `admin-ui` are called by clients as NON-admin users. It must be decided cap
      by cap, with the operator. Start with `oauth-integration` and `sso-bridge`.
- [ ] **7.5d — `provider[method.name]?.(payload)`**: the optional call makes
      a missing method return `undefined` and therefore **200**, whereas
      `child-cap-dispatch.ts` throws on the same case. Align with the
      behaviour that fails.
