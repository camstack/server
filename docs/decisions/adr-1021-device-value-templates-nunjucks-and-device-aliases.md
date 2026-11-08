---
id: D1021
title: Device value templates are nunjucks over device aliases, rendered only in a budgeted worker thread
status: accepted
date: 2026-11-08
supersedes:
applies-to:
  - packages/system/src/builtins/device-manager/device-template/**
  - packages/system/src/builtins/device-manager/device-alias-actions.ts
  - packages/types/src/expression/device-template.ts
  - packages/types/src/device/device-alias.ts
  - scripts/check-device-template-grammar.ts
---

## Context

A notification, an OSD line or a dashboard tile wants a sentence built from live
device state: `{{ stufa_veranda.temperature | unit('°F') | round(1) }}`. The
expression engine of the automation stack answers a boolean or a number; it has
no text, no loops and no filters. Writing a second small language was the first
option and the wrong one: the operator already knows Jinja.

nunjucks is Jinja for Node, and it does NOT sandbox. `{{ range.constructor("return
process")() }}` runs arbitrary code in the process that renders it, through the
globals nunjucks installs (`range`, `cycler`, `joiner`) or through
`''.constructor.constructor`. A template is operator text that reaches a hub
process holding every credential, so "it is only the operator" is not a defence.

A second problem sat under the first. A device is named in a template by an
alias, and the automation mirror resolved a stable id to a device through a map
keyed by the bare `stableId`, which is unique per ADDON, not per cluster: two
addons sharing a stable id made one device answer for both. A generated
automation block read the wrong device without a sound.

## Decision

1. **Aliases.** A device has an entity-id-style `alias`, generated ONCE from its
   name (ascii, lowercase, `_`, `_2` `_3` on a clash) when it registers, unique
   cluster-wide, editable through `device-manager.setAlias`, and NOT changed when
   the device is renamed. A template names `alias.field` when the field name is
   unique across the device's capabilities, else `alias.<cap>.field`; an
   ambiguous `alias.field` is refused by name, listing the capabilities. The
   alias is resolved to the device at render time, never stored in a template.
   `setAlias` answers a typed refusal (`empty`, `too-long`, `grammar`,
   `reserved`, `taken` with the owner), not a thrown string. **A removed
   device's alias stays reserved** (addon-store key `_reservedAliases`, written
   in the removal's lock before the row is deleted): a new device of the same
   name slugs to `_2`, so a template that still names the old alias never
   silently reads another device. An explicit `setAlias` may reclaim it.
2. **Templates are nunjucks**, with a closed vocabulary: `unit` (converts from
   the field's D944 base unit with the one conversion table and appends the
   symbol), `round`, `default`/`d`, `since`, `ago`, `format`, the string filters
   (`upper lower title capitalize trim truncate replace join`), `abs int float
   length first last sort reverse sum string list`, and the `range(n)` global
   (capped at 1000). Refused by name: `groupby selectattr rejectattr safe
   escape dump`, every `attribute`/`attr` argument, every other call. Each
   filter has a maximum parameter count. A value that is unknown or unavailable
   prints `—` and goes into a trace the caller can show; `+` and `~` with an
   unavailable operand yield the same `—` (the compiler's add/concat emission is
   patched to a checked form), never a quiet `0` or `undefined`. A template
   naming an alias that resolves to no device renders `—` with a trace entry.
3. **A template never runs outside the sandbox below.** Every one of these holds:
   - the template is parsed and every node is checked against a DEFAULT-DENY
     policy table (a node kind not listed is refused, and so is a node carrying
     a field or a child node the table does not declare; a spec compares the
     table with nunjucks' own node classes so an upgrade cannot add a path
     silently). The `is` test must be an allow-listed name. No call but
     `range`, no `include`/`import`/`extends`/`block`/`macro`, no
     dynamic member lookup (`a[k]`), no member named `constructor`,
     `__proto__`, `prototype` (and the getter/stack names), no filter outside
     the allow-list;
   - it renders only in a `worker_thread`, in a fresh environment with no
     loader, autoescape off, `range`/`cycler`/`joiner` neutralised and only the
     allow-listed filters;
   - the render context is frozen plain data (null-prototype objects), built
     from only the values the template names;
   - the host measures a 50 ms wall-time budget, TERMINATES a worker that
     overruns and respawns it lazily; output is capped at 4096 characters, the
     template at 4096, the worker heap is limited;
   - the worker re-runs the whitelist over what it receives, so a bypassed host
     check still cannot reach the engine;
   - the renderer queues at most 16 renders (`busy` beyond), keeps a per-template
     circuit breaker (three timeouts in a minute answer `budget-exceeded`
     without running), and kills a worker that does not report ready in time.
4. **The renderer lives in device-manager**, which owns the device rows and the
   aliases; `@camstack/types` carries only the vocabulary (limits, refusal
   reasons, how a reference resolves) and no engine.
5. **The mirror key is the pair.** A stable id resolves through
   `stableIdKey(stableId, addonId)`; the bare stable id answers only while no
   other addon shares it. `ExpressionGlobalBinding` gains `addonId`.

The alias backfill for devices that predate this is NOT a hub migration
(D987): it needs the rows API and the slug rules and must run after the
collection declares its new `alias` column, so it is a marker-gated boot pass
in the owner (`_deviceAliasBackfillVersion`), like the linked-devices backfill.

## Consequences

- An operator cannot write a macro, call a function or read anything the
  renderer did not put in the context; some Jinja stays unavailable on purpose.
- The member-name refusal is deliberately broad: a field named `caller` or
  `arguments` cannot be addressed by name.
- A render costs a worker round trip; the worker is persistent, so only the
  first render after a spawn or a kill pays the start.
- `nunjucks` is a dependency of `@camstack/server` (system) only, bundled into
  the render worker; no addon depends on it (D28).
- The change adds a capability method, so `@camstack/system` must be
  force-published for it to reach a hub.

## Enforcement

`scripts/check-device-template-grammar.ts` (wired into `checks.yml`): nunjucks
is imported only by `device-template/nunjucks-internals.ts`, and the worker
graph never value-imports the types barrel. Specs prove each escape payload
refused or inert (`template-grammar.spec.ts`, `template-renderer.spec.ts`), the
worker refusing alone when the host check is bypassed, and a budget overrun
terminated.
