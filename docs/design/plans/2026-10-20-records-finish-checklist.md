---
title: Records finish checklist — cutover, phase 3, then Path A publish
status: active (2026-10-20)
base-commit: 17fcf0c16
handover: docs/design/plans/2026-10-20-records-migration-handover.md
---

# Checklist — close records A+B and publish

**Handover (state + waiting on parallel WIP + a single release):**
[`2026-10-20-records-migration-handover.md`](./2026-10-20-records-migration-handover.md).

Run by a single agent on this clone. One box at a time; stop if `verify`
fails. Do not raise pins in `scripts/ci-baseline.json`. Do not drop auth
tables. Do not dispatch the Checks workflow.

**Channels (do not mix them):**

| Moment | Channel |
| --- | --- |
| Iterate / cut over on `.50`, then prod, from the local tree | Path B: `deploy --closure` + `camstack deploy` addon |
| Durable state on the registry once stable | Path A: push → Publish Packages → `applyServerUpdate` |

**Mandatory order:** `.50` before prod for every cutover. Enumerate agents
with `nodes.topology`, never from a remembered list.

---

## Block 0 — Preflight (before anything else)

- [x] `git status` clean except local artefacts (`.cursor/mcp.json`,
  `records-adopt.snapshot.json` left out on purpose)
- [x] HEAD is the 2026-10-20 records cutover base (see `base-commit` above) or
  a descendant of it
- [x] `npm run verify:push` GREEN (typecheck + tests; scripts when `scripts/`
  is in the diff — the gate must no longer skip them through SIGPIPE)
- [x] `ops_status` / hubs reachable (prod + `.50`) — `.50` health 200; admin API
  token dead after 595
- [x] Hub snapshot < 24 h, or a fresh `database-snapshot`, before every `--apply`
  (settings snapshot ~9.3MB on `.50` before the adopts)
- [x] `.50` admin session via `camstack login` (JWT `isAdmin`, D884); the dead
  `csa_` token parked — **unblocked**

**Exit:** local gate green + hubs reachable + snapshot/token ready.

---

## Block 1 — Ship the current commit (minimal Path A)

The records/zero-pin code exists only locally (`main` ahead). Without this,
prod keeps running on the previous closure/addons.

- [x] `git push origin main` (after verify:push GREEN) — including the CJS fix
- [x] Wait for the push CI to be green on that sha
- [x] `gh workflow run "Publish Packages" … -f force_packages=@camstack/server`
  → `@camstack/server@1.2.595` (CJS; 594 was ESM and crash-looped)
- [x] `git pull` after the CI bump commit
- [x] Wait for the tarball URL on npm (lag is fine; do not re-publish)
- [x] `applyServerUpdate` **1.2.595**: prod hub + Mac + agent-b; `.50` hub
  (disk/healthy). `agent-a` was offline at the time of the apply
- [x] Poll `getServerPackageStatus` → `1.2.595` + `idle` (hub/Mac/amd)
- [x] `camstack deploy` the records-related addons on prod (notifiers, pipeline,
  orchestrator, post-analysis, auth, ai, mqtt/matter/google/import-alexa,
  admin-ui)
- [x] Prod: no `adoption-pending` in recent logs; `.50`: mesh still pending

**Exit:** sha published and applied; records-related addons on the new version.

---

## Block 2 — Live inventory: what is still left to adopt

After Block 1, compare the code with the hub.

- [x] `storageAdmin.listKinds` / `isAdoptedLegacyTable` on **prod** — **81/81
  adopted**, 0 pending
- [x] Same census on **.50** — **0 pending** (after adopting mesh + auth + NC SSO)
- [x] Prod: table in (planning repo: sessions/sessions.md) (2026-10-20 Block 1 entry) <!-- drift-ok: moved to the private planning repo -->
- [x] `.50`: mesh-node-certificates adopted (31 legacy → 32 kind rows)

**Exit:** a closed list of adopts still to do (phase 4 / 6 / Track B leftovers).
If the list is empty → skip to Block 4 (phase 3).

---

## Block 3 — Finish the remaining A+B cutovers (code already shipped)

For **every** owner still pending, the same mechanism as phase 2
(`records-phase-2-migration.md` / `records-api-plan.md` §4.1):

1. dry-run `records-adopt.ts --mapper …` (without `--apply`)
2. stop the owner (`addons.restart` / stop; script with `--owner-stopped`)
3. `--copy` → verify the hash
4. `--copy --apply --owner-stopped`
5. start the owner
6. 10 min smoke: health, one write path, `listKinds` with nothing pending

### 3a Hub-main / system builtins (phase 4)

- [x] **Prod:** the usual owners adopted (`isAdoptedLegacyTable` 81/81; tombstones /
  node-history / integrations / core-blocks / calendars / backup_* / alerts /
  keychain with consistent row counts)
- [x] `.50` — same owners adopted; scoped early-drop of the empty `core-blocks:settings`
- [x] No legacy early-drop on prod in this session

### 3b Auth (phase 6) — high risk

- [x] **Prod:** `local-auth` / `auth` / `core-auth` / `system-config` mesh
  (41 certs) adopted; admin token live; HA broker `accessToken` redacted on read
- [x] `.50` — `system-config-phase6` + webauthn + share-view-tokens + oidc adopted;
  auth addons restarted
- [x] **Never** an orphan auto-drop on the auth tables (left untouched)

### 3c Track B brokers / entries

- [x] **Prod:** HA / Homematic / Google brokers `entry: true` + rows; Matter /
  MQTT / import-Alexa declared (0 rows = empty legacy)
- [x] Smoke read `storageAdmin.readRecords` HA `ha_001` OK
- [x] `scan-raw-secrets`: 4 findings in `addon-settings` (HMAC-style
  `*Secret` key-named pairs — not broker passwords); see sessions

**Exit (prod):** no pending adopt for phases 2/4/6/B. **Exit (cluster):** `.50` too.

---

## Block 4 — Phase 3 DurableLedger → `ctx.records`

**Do not start** until Block 3 is closed (A+B config/hub/auth/entries stable).

Scope (`records-api-plan.md` §4.2 phase 3): ~17 NC + analytics tables
(liveness, device-alerts, system-state, occupancy, prunes, snoozes, outbox,
artifacts, phantom-cells, package-background, stationary-*, scene-latch, …).

- [x] **Prod:** phase 3 kinds declared + adopted (e.g. liveness 575, phantom-cells
  5260, device-alerts 85); `pipeline-analytics` provider active on the hub
- [x] `.50` cutover / verify — phase 3 kinds adopted; NC SSO empty-complete
- [x] Early-drop of the legacy DurableLedger (PA+NC allowlist, `phys<=rec`): **done**
  2026-10-20 offline on prod (+ `.50` before it); tracks/media/object-events STAY
- [x] `deviceId` header on the DurableLedger write-behind: PA `1.2.605`/`1.2.606`
  (hub+agents); no `deviceId is required` WARN after the reload

**Exit (prod):** ledgers on records. **Exit (cluster):** `.50` too.

---

## Block 5 — "A+B complete" gate (prerequisite for LTS / phase 5)

- [x] Phase 2: done (already documented)
- [x] Phase 3: done on **prod** (Block 4)
- [x] Phase 4: done on **prod** (Block 3a)
- [x] Phase 6: done on **prod** (Block 3b)
- [x] Track B entries: done on **prod** (Block 3c)
- [x] Sessions: "records A+B complete on **prod** 2026-10-20" (`.50` open)
- [x] Note it in the LTS overlay — `.50` aligned; Wave 2 P5 unblocked
- [x] The "records A+B complete" line **cluster-wide** — 2026-10-20 (hub+`.50`)

**Exit (cluster):** one sessions line "records A+B complete YYYY-MM-DD" (hub+`.50`).

---

## Block 6 — After A+B (LTS P4 + P5 + records phase 5)

Fixed order from the LTS overlay plan — do **not** start until Block 5 is
ticked. Details: the LTS master plan +
`docs/design/plans/2026-10-19-lts-after-records-migration.md`.

### Wave 3 cutover (offline split + phase 5 adopt)

- [x] **`.50`:** offline `split-databases` → `events.db` + slim settings + merge
  into the existing P4 `history.db`; phase5 adopted (empty ledgers); three DBs;
  PA healthy; backup `sqlite-settings.pre-split-2026-10-20-114048`
- [x] **Prod:** same split/adopt window; backup `…-pre-split-2026-10-20-140233`;
  split-report settings 1.8G→598MB, events 1.3G, history 14MB; rehome 6 kinds;
  ledgers (audio ~28k classified after scrub, motion 322k, media 1.09M, tracks
  139k, …)
- [x] Cutover fixes in tree/applied: history series get-or-create; records rehome
  settings→events; history opt-outs/departures not declared into history; offline
  phase5 adopt (INTEGER id cursor); `storageAdmin` list/read peers
- [x] **Prod verify:** `@camstack/server@1.2.599` idle; post-analysis `1.2.603`;
  `databaseSnapshot.listDatabases` = three DBs; deviceHistory ready; phase5
  `isAdoptedLegacyTable` for motion/audio/faces/ops-log/track-aliases/birth/
  track-purity; runners 25/25; PA active tracking
- [x] Early-drop of the legacy event/ledger tables (PA+NC allowlist) — **done**
  2026-10-20 (offline; never tracks/media/object-events)
- [x] Identities/vehicles/samples → records + early-drop of the gallery — **done**
  (B+C; identity-samples 828 alreadyConverted / vectors in the vec index)
- [x] **H** `stats-5m-v2` ×2 → device-history already live (`recordBuckets`); orphan
  DROP offline 2026-10-20 (.50 empty, prod 1 137 402 + 225 716). `metrics:node-*`
  already absent. Allowlist `STORAGE_ADMIN_MOVED_COLLECTIONS` in tree (Path B
  blocked by the dishwasher WIP — the offline DROP was used instead).
- [x] Dual count (prod after H): physical `listTables` ≈152; PA nonzero =
  tracks/media/object-events; device-history ready (series ~1588)
- [ ] ~~Bosch / dishwasher / P6 History UI / LTS↔consumption~~ — **out of scope**
  (another agent / another track)

**Exit (cluster):** hub + `.50` on the three-file layout; phase 5 kinds adopted;
sessions entry 2026-10-20 "LTS P5 + phase5 cutover".

---

## Block 7 — Full "affected" publish once everything is stable

**Closed 2026-10-20.** Prod (hub + agent-a + agent-b + Mac) on
`@camstack/server@1.2.601` idle; runners all green; `listTables` = 154;
phase5 motion/faces adopted; gallery kinds adopted + early-dropped
(2026-10-20 offline; see sessions).

**Smoke A (2026-10-20):** topology 4/4 online; versions 1.2.601 idle;
runners hub 54/54. `.50` may sit on a local `-dev` stamp while other work
iterates — not a prod gate.

Trigger only if Blocks 1–6 are green (stable cutover; early-drop still out of scope).

- [x] Working tree clean; `origin/main` = HEAD (at the time of the publish)
- [x] `npm run verify:push` GREEN (pre-ship of the listTables fix)
- [x] Publish Packages `scope=affected` `include_dependents=false` (+ force
  system/server)
- [x] Apply on the online nodes (hub + prod agents + Mac); `.50` may diverge on `-dev`
- [x] listTables peer + vec0 skip verified live
- [x] Smoke API: topology, versions, runners, adopt sample, listTables
- [ ] Smoke UI: NC rule fire / recording write (operator, optional)
- [x] Sessions: server version updated

**Exit:** nothing "published but not applied"; cluster online on registry
`1.2.601` (not `-dev.`).

---

## Anti-drift rules (always)

- A single committer on this clone; a worktree per parallel agent.
- Never `git add -A`.
- Never `--allow-increase` on the baselines.
- Path B and Path A: separate labels; after Path A, `git pull` before a local
  `camstack deploy`.
- Degraded agents: do not block the hub cutover; bring them back afterwards.
- Phase 6: stop and ask the operator only if login fails after the apply.

---

## Immediate next step (default)

Start from **Block 0**, then **Block 1** (push + publish + apply), then
**Block 2** (adopt inventory). Do not open phase 3 or LTS until 2–3 are
closed.
