---
name: camstack-addon
description: Create or change a CamStack addon (plugin) — a device provider, notifier, storage or log destination, pipeline stage, exporter, a builtin, or any new `camstack.addons[]` manifest entry. Covers the silent wiring misses (vite entries, `super({})`), forked vs in-process behaviour, the two per-device settings stores, custom actions, device-page widgets, `camstack deploy` and its traps (installs, may not respawn, ships what is built), and how to prove the new code is the code running. Use for "new addon", "add a provider", "my addon change has no effect", "the addon is running but nothing happens".
---

# Addon (repository overlay)

The canonical PUBLIC text of this skill is `packages/develop/skills/camstack-addon.md` (shipped with `@camstack/develop`; `camstack develop skill camstack-addon`). **Read it first** — it holds the procedure, the traps and the done-gate, and this file does not repeat it. Below is only what is true of THIS repository. `scripts/check-skill-pack-sync.ts` keeps the two from drifting.

## Repo workflow

1. Decide where it lives and write it (pack §1–§2) — a UI surface also loads
   `camstack-ui`; a new or changed `*.cap.ts` is the `camstack-capability`
   skill first; a credential field is `camstack-secrets`.
2. Wire the four places and choose the opt-in (pack §3–§4).
3. Verify locally, then document (pack §5–§6) — including the changelog line:
   `npm run changelog:add -- <package> "<operator-facing line>"`; a publish of a
   changed package without one is refused.
4. Deploy and PROVE the new code runs (pack §7) — "running" in a list is not proof.
5. Paste the repo done-gate below.

## Repo done-gate — paste it before "done"

```
ADDON DONE — <addonId>
placement:  <builtin | packages/addon-…>, manifest entries: <ids>
wiring:     manifest + vite entries + index re-export (+ system index for a builtin); npx tsx scripts/check-addon-entries.ts — <ok>
checks:     npm run typecheck -w packages/<pkg> — <ok>; tests — <result>; build emitted <dist path>
deployed:   <hub | node ids> — fresh runner: <pid / boot line>; caps registered: <listCapabilities result>
proved:     <the call / log line / behaviour observed on the node>
docs:       camstack-docs gate — <files | none needed: reason>
```
