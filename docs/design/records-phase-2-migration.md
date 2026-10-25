# Records phase 2 — migrate config tables one owner at a time

Status: **done** (2026-10-18) — steps 1–26 adopted on `.50` and prod. Plan: `records-api-plan.md` §4.2 phase 2.
Binding decisions: secret fields are a records feature; brokers → entries later;
**no generic entries UI** (each page keeps its own table/buttons). First env: **`.50`**,
then prod `.9`. Agents carry no records.

## Mechanism (every step)

1. **Code** (on a worktree): `defineRecordKinds` with `adoptsFrom`, rewrite the store
   over `ctx.records`, mapper module for `scripts/hub/records-adopt.ts`, discriminating <!-- drift-ok -->
   specs. Empty legacy tables still set `adoptsFrom` and finish with
   `--copy --apply --owner-stopped` (empty batch + `complete: true`) so the boot guard
   is disarmed for good.
2. **`.50`**: snapshot counts → stop owner → deploy new build →
   `records-adopt.ts --mapper … --copy` → `--copy --apply --owner-stopped` → start →
   10 min live check.
3. **Prod `.9`**: same, only after `.50` is green. Quiet window for `recorder`.
4. Stop the whole phase only when a verify fails.

## Order (live counts 2026-10-18, prod)

| # | Owner (addon) | Kind ← legacy table | Rows | Notes |
| --- | --- | --- | --- | --- |
| **1** | `training` | `jobs` ← `training:jobs` | 0 | **First adopter** — proves the pattern |
| 2 | `ai` | `llm-meta` ← `ai:llm-meta` | 1 | |
| 3 | `ai` | `llm-defaults` ← `ai:llm-defaults` | 2 | |
| 4 | `ai` | `chats` ← `ai:chats` | 0 | index `user` |
| 5 | `ai` | `llm-profiles` ← `ai:llm-profiles` | 3 | `apiKey` → `.meta({ secret: true })`; import markers before adopt |
| 6 | `ai` | `usage` ← `ai:usage` | 2225 | `ttlMs: 90d`, `at` required |
| 7 | `pipeline-analytics` | `scenes` ← `pipeline-analytics:scenes` | 0 | |
| 8 | `pipeline-analytics` | `migrations` ← `pipeline-analytics:migrations` | 2 | |
| 9 | `pipeline-analytics` | `sweep-cursors` ← `pipeline-analytics:sweep-cursors` | 1 | |
| 10 | `pipeline-analytics` | `face-rescore-state` ← `pipeline-analytics:face-rescore-state` | 1 | |
| 11 | `pipeline-analytics` | `viewer-settings-snapshots` ← `pipeline-analytics:viewer-settings-snapshots` | 1 | keep prefixed name as kind |
| 12 | `pipeline-orchestrator` | `node-stress-moves` ← `…:node-stress-moves` | 0 | `ttlMs: 2h` |
| 13 | `pipeline-orchestrator` | `node-benchmark-mode` ← `…:node-benchmark-mode` | 0 | |
| 14 | `pipeline-orchestrator` | `node-benchmark-runs` ← `…:node-benchmark-runs` | 8 | |
| 15 | `pipeline-orchestrator` | `node-benchmarks` ← `…:node-benchmarks` | 21 | (live name; plan said `node-benchmark-results/plans`) |
| 16 | `provider-homeassistant` | `ha-notification-targets` ← `…:ha-notification-targets` | 0 | |
| 17 | `notifiers` | `notification-targets` ← `notifiers:notification-targets` | 5 | secrets in config — records secret paths; scan before adopt |
| 18 | `notification-center` | `texts` ← `…:texts` | 1 | code done |
| 19 | `notification-center` | `sequences` ← `…:sequences` | 0 | code done |
| 20 | `notification-center` | `rule-ai` ← `…:rule-ai` | 0 | code done |
| 21 | `notification-center` | `calendar-events-rules` ← `…:calendar-events-rules` | 1 | code done |
| 22 | `notification-center` | `summary-rules` ← `…:summary-rules` | 1 | code done |
| 23 | `notification-center` | `timelapse-rules` ← `…:timelapse-rules` | 3 | code done |
| 24 | `notification-center` | `rules` ← `…:rules` | 18 | last NC — most coupled; code done |
| 25 | `recorder` | `exports` ← `recorder:exports` | 138 | quiet window |
| 26 | `recorder` | `ops-log` ← `recorder:ops-log` | 500 | ring `maxRows: 500`; quiet window |

One owner = one deploy + one stop/start. Steps 2–6 can ship as one `addon-ai` deploy
with six kinds declared together (still adopted kind-by-kind so a failed verify
leaves later kinds unadopted). Same for analytics (7–11), orchestrator (12–15), NC (18–24).

## Per-step checklist

```
STEP <n> — <owner>/<kind>
[ ] kinds module + Records*Store (ctx.records), legacy declareCollection removed
[ ] mapper scripts/hub/records-mappers/<owner>-<kind>.ts
[ ] specs: store over records world; adopt mapper round-trip; boot guard when rows>0
[ ] .50: snapshot → stop → deploy → adopt apply → start → cap answers
[ ] prod: same (recorder: quiet window)
[ ] sessions.md one line; tick this table
```

## Out of this phase

Brokers-as-entries, generic entries UI, phase 3 DurableLedgers, phase 4 hub-main,
auth, event ledgers. Orphan drop of old tables = D872 after 14 d (or operator
`dropCollection` once unused).

## Progress

| # | State |
| --- | --- |
| 1 training/jobs | **done** (.50 + prod; owner `training`; 0 rows) |
| 2–6 ai/* | **done** (.50 + prod; kinds owned by **`ml`** — AI’s `execution.group`; usage 2225 verified) |
| 7–11 analytics/* | **done** (.50 + prod; owner `pipeline-analytics`; hub-only `declare` — agents have no records; migrations 2 + sweep 1 + face-rescore 1 + viewer-settings 1) |
| 12–15 orchestrator/* | **done** (.50 + prod; owner `pipeline-orchestrator`; runs 8 + benchmarks 21; `@camstack/addon-pipeline-orchestrator@1.2.600` — bump above closure stamp or upload is overwritten; always `-s` the target hub) |
| 16 HA ha-notification-targets | **done** (.50 + prod; 0 rows; `@camstack/addon-provider-homeassistant@1.2.600`) |
| 17 notifiers notification-targets | **done** (.50 + prod; 5 rows; owner `notifiers`; `@camstack/addon-notifiers@1.2.600`) |
| 18–24 NC/* | **done** (.50 + prod; owner `pipeline-analytics`; texts 1 + calendar 1 + summary 1 + timelapse 3 + rules 18; `@camstack/addon-post-analysis@1.2.600`) |
| 25–26 recorder | **done** (.50 + prod; owner `recorder`; exports 138 + ops-log 503; `@camstack/addon-pipeline@1.2.600` hub+agents) |

**Lesson (AI):** a grouped runner stamps `callerAddonId` as the runner id
(`local-child-registry`), so `adoptRecords` / mappers must use that owner, not
the addon id. Solo runners (training) match the addon id.
