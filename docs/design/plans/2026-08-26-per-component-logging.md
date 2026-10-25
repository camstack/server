# Plan — turn on verbose logging on ONE component, not on everything

> **For the implementer:** REQUIRED SKILL — use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans`. The steps use checkboxes
> (`- [ ]`) for tracking.

**Goal:** a single mechanism to turn on diagnostic flooding on a named
**channel** (and, when needed, on a **camera**), armable both **before boot** and
**at runtime**, that switches itself off, that **loudly rejects** a wrong value,
and whose lines **reach Loki**. It replaces the current gesture — raising
`CAMSTACK_LOG_LEVEL` on the whole process — which is the only general tool this
repo has today and is unusable on a hub with ~30 runners.

**Architecture:** three tracks. **A** is the pure core (grammar, registry, gate)
and touches no hot path. **B** is the arming plumbing in BOTH cases (env at boot,
cap at runtime) plus the hub → runner → agent propagation. **C** retires the
mechanisms the new one replaces, fixes two real defects found during the audit,
and puts the guards in place. A must be complete and merged before B; C depends
on both.

**Stack:** TypeScript 5.7+, Zod 4, vitest, npm workspaces + nx.

## Global constraints

The rules of `CLAUDE.md` apply. In addition, verbatim:

- **No casts.** No `as any`, `as unknown as X`, `as never`. Exceptions: `as
  const` and a documented type boundary. Use discriminated unions and type guards.
- **`z.infer<>` for Zod schemas** — never duplicate a shape by hand.
- **Named types**: no inline types on signatures or return values.
- **Never `console.log`.** Only the injected `IScopedLogger`. It holds for the
  trace mechanism itself too: a diagnostic that writes to stdout does not reach
  Loki and so does not exist the next day.
- **Every log line about a device carries `tags: { deviceId }`** with the numeric
  id.
- **A branch that silently throws work away logs it.** It holds in particular for
  SUPPRESSION: a channel that discards lines for rate-limiting must say so, or
  the silence reads as "that branch was not taken".
- **A green test is not proof.** After every fix, DISARM the fix and confirm the
  test turns red. Report that you did.
- **Never `git --no-verify`, never `git add -A`, never `git stash`.** Explicit
  pathspecs. The tree is shared.
- **No task here touches the production hub.** Only code, tests and guards.
- The `camstack/` submodule is **read-only** in this work.

---

## Inventory — what exists today

Five independent mechanisms, plus the global knob. None of them is wrong; each
solves a different piece, and **none solves the operator's problem**, which is "I
want to see everything X does, only X, now".

| # | Mechanism | Where | How it is armed | What it really solves | Covers boot? | Per camera? | Reaches Loki? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `CAMSTACK_LOG_LEVEL` + `nodes.setProcessLogLevel` | `process-service.ts:501`, `nodes.cap.ts:225`, `cap-providers.ts:704-720`, `uds-logger.ts:45-54,112` | env at fork **and** admin mutation at runtime | the only GENERAL knob. Granularity: the whole process | yes (env) | no | **no** at `debug` level — see § "The Loki constraint" |
| 2 | `FleetReadCensus` | `packages/system/src/builtins/device-manager/fleet-read-census.ts`, built in `device-row-store.ts:469` | env `CAMSTACK_FLEET_READ_CENSUS_MS`, self-closing window, `MAX_WINDOW_MS = 10 min` (`:87`) | **attribution** of a fleet-read storm AT BOOT | **yes — it is its reason to be** | no | yes (report at `info`) |
| 3 | `StoreReadCensus` ×2 | `addon-post-analysis/.../store/read-census.ts` + twin `addon-pipeline/src/recorder/addon/store/read-census.ts`; action in `recorder/addon/debug-actions.ts:46-89`, `pipeline-analytics/index.ts:4295-4301` | custom action `debug.storeCensus` (admin), `CENSUS_MAX_WINDOW_MS = 10 min` | **attribution** of store reads at STEADY STATE | no (the action arrives after boot is over) | no | yes (`logCensus`, `read-census.ts:301`) |
| 4 | `streamingDebug` / `webrtcDebug` | `stream-broker.ts:425` (field), `:1650,1678,1697,1717,1810,1823` (gate), `:2328` (setter); `stream-broker-manager.ts:4640,4650,5189,5199,5428,5445`; `device-scoped-providers.ts:263-273` | **per-camera switch in the device UI** | broker/WebRTC verbosity **for one camera** | no | **yes** | yes (`info`) |
| 5 | Debug flags in providers | reolink `reolink-camera.ts:8269-8305` (`debugGeneral`, `debugSocketLogs`), read at `:9510-9511`, schema `schema.ts:507,513`; hikvision `hikvision-camera.ts:4052,4060,4161`; cloudflare `cloudflare-tunnel.addon.ts:1036` → argv at `cloudflare-tunnel.ts:290`; nodeav `nodeav-decoder-session.ts:324,412,1140-1163` | **per-device / per-addon switch in the UI** | **change what the process does**, not just how much it logs | no | yes | yes (`info`) |
| 6 | `ALWAYS_SHIP_SCOPES` (viewer) | `camstack/src/lib/logger.ts:60-98`, `shouldShip` `:131-135`, `setLogVerbose` `:159-165`, `UNEVICTABLE_SCOPES` `:113` | **compiled** allowlist, plus `settings.advanced.debugMode` | which `info` lines **leave the phone** towards the hub | n/a | no | yes (via `/clientlog`) |
| — | one-off debug envs (removed 2026-10-06) | `CAMSTACK_MOLECULER_DEBUG` (`broker-factory.ts:105-114`), `CAMSTACK_DECODE_COLOR_DEBUG` (`decode-worker-child.ts:712`), `CAMSTACK_SQLITE_STORAGE_REPORT=off` (`sqlite-settings-backend.ts:1324`), `CAMSTACK_APP_DEBUG` | env, each with its own grammar | each one thing only | yes | no | varies |

### The two mechanisms that contradict each other, and why

**(2) vs (3): env versus custom action.** `fleet-read-census.ts:19-27` justifies the
difference in writing, and the justification **is essential, not accidental**:

> *"`pipeline-analytics`'s `StoreReadCensus` is armed through a custom action,
> which is the right shape for a steady-state mystery: you notice, you arm, you
> read. It cannot work here. **The storm is at BOOT** — by the time a process is
> up enough to receive an action, the window being investigated has closed."*

This is true and cannot be worked around. But it **does not follow** that two
mechanisms are needed: it follows that **one with two arming roads** is needed.
It is exactly what is missing. The practical consequence is that today the store
census cannot be armed at boot — so the question "who reads `recording-configs`
581-892 times a minute **during startup**" has no tool, while the same question
at steady state has one.

**(3) against itself: two copies of the census.** `read-census.ts` exists twice,
in `addon-post-analysis` and in `addon-pipeline/recorder`, and the second declares
itself "ported from" the first (`recorder/addon/store/read-census.ts:17-19`).
Two copies of the same idea are two chances for one to diverge.

**(4)/(5) against (1): "debug" does not mean the same thing.** `streamingDebug`
raises verbosity. reolink's `debugSocketLogs` **resets the control channel**
(`reolink-camera.ts:8272-8274`); cloudflare's `debugLogging` **respawns
cloudflared** with different argv (`cloudflare-tunnel.ts:290`); `webrtcDebug` is
read **at session creation** and changes the session object
(`device-scoped-providers.ts:255-262`). A single verbosity knob cannot own a flag
whose flip restarts a subprocess.

### The Loki constraint — the piece that makes the global knob useless

`loki-logging.addon.ts:50` sets `level: 'info'` as default, and
`loki-destination.ts:168` discards everything below that threshold:

```ts
if (LEVEL_ORDER[entry.level] < LEVEL_ORDER[this.config.level]) return
```

So **a line emitted with `logger.debug()` does not reach Loki** with the default
configuration. The hub's in-memory ring holds ~35 minutes
(`fleet-read-census.ts:30-37`), so a measurement asked for an hour later simply
does not exist. It is no accident that **all** the existing censuses emit at
`info` (`read-census.ts:301`, `fleet-read-census.ts:161`): it is the only level
that survives. This is the most important design constraint of the document, and
it is the reason *"I raise the level to debug and look"* has never been a working
plan.

Related note: `loki-payload.ts` keeps `deviceId` **out of the labels** (for
cardinality) and puts it in the JSON body. Filtering by camera in LogQL is done
with `| json | deviceId="102"`, not with a stream selector. It is correct that
way; it only needs to be known.

### Two real defects found during the audit

**D-1 — `CAMSTACK_LOG_LEVEL` does not reach the addons' logger.**
`process-service.ts:497-501` carefully sets the variable on the child and explains
why (*"a hardcoded debug level force-forwarded every debug line to
`$hub.log`"*). `addon-runner.ts:40` documents it. **Nobody reads it.** The
runner's logger is born from `createUdsLoggerWithControl` with
`levelState = { current: 'debug' }` (`uds-logger.ts:169`), and the addons' logger
from `createUdsLogger` (`addon-context-factory.ts:451`), which opens a
**private, control-less** `{ current: 'debug' }` (`uds-logger.ts:145-158`).
Consequences: (a) every `debug` line of every forked addon crosses the UDS
anyway, that is the cost the comment says it eliminated; (b)
`nodes.setProcessLogLevel` on a hub-local runner returns `success: true` and
**touches only `addon-runner`'s self-logger**, not `ctx.logger`. The doc line at
`addon-runner.ts:40` is a leftover that describes the right design and reads as
verification — exactly the case `CLAUDE.md` says to delete.

**D-2 — `CAMSTACK_FLEET_READ_CENSUS_MS=true` disarms silently.**
`fleet-read-census.ts:95-97`: `Number('true')` is `NaN`, `valid` is `false`,
`windowMs` is `0`, `armed` is `false`, and **no line is emitted**. The operator
lost a whole boot before noticing. The file correctly says *"A bad value
**disarms**"* — but disarming is not enough: it must disarm **loudly**.

Neither is to be fixed in this plan before track C: D-1 is in the kernel and
changes the log volume of the whole hub, D-2 disappears together with the
variable that contains it.

---

## The proposal, in one line

**A named `TraceChannel` declared in a registry, armed by ONE grammar
(`channel[@cameras][:window]`) that arrives either from the env `CAMSTACK_TRACE`
at boot or from the mutation `nodes.setNodeTrace` at runtime, that emits at `info`
with `tags: { trace, deviceId }`, closes itself within 10 minutes, and rejects a
malformed spec without arming anything and saying so.**

### The exact shape of the API

The hot path always and only writes this shape:

```ts
if (T_FINALIZE.on && T_FINALIZE.wants(deviceId)) {
  T_FINALIZE.log('finalize', { tags: { deviceId }, meta: { segmentMs, bytes } })
}
```

`on` is a **plain boolean field**, not a getter: when the channel is off the cost
per line is a `load` and a `branch`, and **no object is built** — the `extras`
object literal sits inside the branch. It is the same shape already proven in
production at `stream-broker.ts:1650`. The `T.on &&` prefix is mandatory even
when `wants()` alone would suffice, and a guard verifies it: without it a
`Set.has` would be paid on every tick even with the channel off.

**Cost with the channel ON:** one log line per call → UDS `sendLog` → hub
`LogManager` → Loki batch. On a path at ~3.4 events/s
(`recorder/addon/index.ts:208`, `recording-index.ts:301`) it is irrelevant. On a
per-frame path **it is not**, and that is why a channel declares its cadence
(§ "cadence") instead of leaving it to the caller.

### How it is armed, in the two cases

| Case | Road | Why exactly this one is needed |
| --- | --- | --- |
| **Startup storm** | `CAMSTACK_TRACE="device-manager.fleet-read:90s"` in the container's / process's env | when the process is alive enough to receive a mutation, the window is already closed (`fleet-read-census.ts:19-27`). The only possible read is at construction |
| **Steady-state mystery** | `nodes.setNodeTrace({ nodeId, spec, })` — admin | requires neither re-creating the container nor a redeploy (`read-census.ts:38-42`). The real advantage already argued for `debug.storeCensus` |

**The same string** in both cases. That is the point: the grammar is one, the
channel list is one, and the documentation is generated from the registry.

### Propagation between processes — where it arrives and where it does not

- **hub-main → forked runners:** `process-service.ts:487` copies
  `...(process.env)` into the child's environment, so `CAMSTACK_TRACE` set on the
  container reaches **every runner forked afterwards**. It does not reach an
  already-live runner → for that the runtime road is needed.
- **hub → runner at runtime:** UDS message `set-trace`, modelled on
  `SetLogLevelMessage` (`child-cap-protocol.ts:241-249`) and routed by
  `LocalChildRegistry.setChildTrace`, twin of `setChildLogLevel`
  (`local-child-registry.ts:599-605`).
- **hub → agent node:** the env does NOT propagate (separate container). The
  Moleculer road is used, exactly as `setProcessLogLevel` does today
  (`cap-providers.ts:706-719`): UDS first, `$node-mgmt` fallback.
- **There is no cluster broadcast, on purpose.** Arming NAMES a node. The
  operator's question is always "why is 102 worse than 101", and 102 and 101 sit
  on ONE node; turning a channel on across the whole fleet is the gesture this
  plan exists to make unnecessary.

### Granularity — what "component" means

Not the addon (too big: `pipeline-analytics` is a whole process) and not the
logger's `scope` (already used for something else — `logging.ts:76-79` says
explicitly that it is "a single free-form label", not a hierarchy). A
**channel** is a dotted name declared in code:
`device-manager.fleet-read`, `recorder.finalize`, `stream-broker.rtp`. A channel
can declare itself `perDevice`, and then the spec accepts `@102+101`.

The `deviceId` filter is **needed** and is the non-negotiable part: it is the
question the operator asks every time, and it is already the only granularity
that (4) and (5) offer. A non-`perDevice` channel (e.g. a boot census) ignores
`@` and rejects a spec that uses it — reject, not ignore.

---

## File structure

| File | Responsibility | Track |
| --- | --- | --- |
| `packages/types/src/logging/trace-spec.ts` | **NEW** — grammar + `parseTraceSpec`, pure, no I/O | A | <!-- drift-ok: this plan creates it -->
| `packages/types/src/logging/trace-channel.ts` | **NEW** — `TraceChannel`: gate, window, cadence, suppression | A | <!-- drift-ok: this plan creates it -->
| `packages/types/src/logging/trace-registry.ts` | **NEW** — `declareTraceChannel` / `listTraceChannels` / `armTraces` | A | <!-- drift-ok: this plan creates it -->
| `packages/types/src/interfaces/logging.ts` | exports `TraceLogTags` (adds `trace` to `LogTags`) | A |
| `packages/system/src/kernel/transport/child-cap-protocol.ts` | `SetTraceMessage` in the `ParentToChildRequest` union | B |
| `packages/system/src/kernel/transport/local-child-client.ts` | `onSetTrace` | B |
| `packages/system/src/kernel/transport/local-child-registry.ts` | `setChildTrace(childId, spec)` | B |
| `packages/system/src/kernel/moleculer/addon-runner.ts` | reads `CAMSTACK_TRACE` at boot, applies `set-trace` at runtime | B |
| `packages/types/src/capabilities/nodes.cap.ts` | `setNodeTrace` + `listNodeTraceChannels` | B |
| `server/backend/src/api/core/cap-providers.ts` | provider of the two, UDS-first with Moleculer fallback | B |
| `packages/system/src/builtins/device-manager/fleet-read-census.ts` | loses the env parsing, gains a `TraceChannel` | C |
| `scripts/check-trace-call-shape.ts` | **NEW** — guard on the call shape | C | <!-- drift-ok: this plan creates it -->
| `scripts/check-trace-channel-registered.ts` | **NEW** — every channel used is declared | C | <!-- drift-ok: this plan creates it -->

---

## Track A — the core, pure and testable without processes

### Task A1: the grammar, and the loud rejection

This task **is** the fix of defect D-2. The value the operator fat-fingered
(`=true`) must produce a line, not a mute boot.

**Files:**
- Create: `packages/types/src/logging/trace-spec.ts` <!-- drift-ok: this plan creates it -->
- Create: `packages/types/src/logging/__tests__/trace-spec.spec.ts` <!-- drift-ok: this plan creates it -->

**Interfaces:**
- Produces: `parseTraceSpec(raw: string, known: ReadonlySet<string>): TraceSpecParse`
- Consumes: nothing. It is pure — no clock, no `process.env`, no logger.

- [ ] **Step 1 — write the failing test.**

```ts
import { describe, it, expect } from 'vitest'
import { parseTraceSpec, TRACE_MAX_WINDOW_MS } from '../trace-spec.js'

const KNOWN = new Set(['device-manager.fleet-read', 'recorder.finalize'])

describe('parseTraceSpec', () => {
  it('accepts a bare channel and applies the default window', () => {
    const r = parseTraceSpec('recorder.finalize', KNOWN)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.entries).toEqual([
      { channel: 'recorder.finalize', deviceIds: null, windowMs: 60_000 },
    ])
  })

  it('accepts cameras and window, and several comma-separated entries', () => {
    const r = parseTraceSpec('recorder.finalize@102+101:90s,device-manager.fleet-read:2m', KNOWN)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.entries).toEqual([
      { channel: 'recorder.finalize', deviceIds: [102, 101], windowMs: 90_000 },
      { channel: 'device-manager.fleet-read', deviceIds: null, windowMs: 120_000 },
    ])
  })

  it('REJECTS `true` instead of silently disarming — the 2026-08-25 defect', () => {
    // `CAMSTACK_FLEET_READ_CENSUS_MS=true` did `Number("true") === NaN`,
    // `armed === false`, and NOTHING was written. A whole boot lost.
    const r = parseTraceSpec('true', KNOWN)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.join(' ')).toContain('true')
  })

  it('REJECTS a channel that does not exist, instead of ignoring it', () => {
    const r = parseTraceSpec('recorder.finalise', KNOWN)
    expect(r.ok).toBe(false)
    if (r.ok) return
    // The typo must be DIAGNOSTIC: it names the channel and the known neighbours.
    expect(r.errors.join(' ')).toContain('recorder.finalise')
    expect(r.errors.join(' ')).toContain('recorder.finalize')
  })

  it('arms NOTHING when a single entry is malformed', () => {
    // A partial arming is the FleetReadCensus bug in another guise: you think
    // you are measuring 102 and you are measuring nothing.
    const r = parseTraceSpec('recorder.finalize:90s,unknown:5s', KNOWN)
    expect(r.ok).toBe(false)
  })

  it('truncates at the maximum instead of rejecting — a long window is a typo, not an attack', () => {
    const r = parseTraceSpec('recorder.finalize:99m', KNOWN)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.entries[0]?.windowMs).toBe(TRACE_MAX_WINDOW_MS)
  })

  it('REJECTS a non-numeric deviceId — a camera name is not an id', () => {
    const r = parseTraceSpec('recorder.finalize@hallway', KNOWN)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.join(' ')).toContain('hallway')
  })

  it('an empty string is not an error: it is "not armed"', () => {
    const r = parseTraceSpec('', KNOWN)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.entries).toEqual([])
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**
      `npx vitest run --root packages/types trace-spec`
      Expected: `Cannot find module '../trace-spec.js'`.

- [ ] **Step 3 — implement the minimum.**

```ts
/**
 * The trace arming grammar, and its parser.
 *
 * ## Why reject instead of disarm
 *
 * `CAMSTACK_FLEET_READ_CENSUS_MS=true` did `Number('true') === NaN` and
 * disarmed SILENTLY (`fleet-read-census.ts:95-97`): the operator lost a whole
 * boot before understanding that nothing was being measured. The file said
 * correctly "a bad value disarms" — but disarming is not enough. Here the parser
 * makes no decisions: it returns a discriminated union, and the CALLER is forced
 * by the type to handle the error branch, which is where the log line lives.
 *
 * ## Why all-or-nothing
 *
 * A partially armed spec is the same bug in disguise: you think you are measuring
 * `102` and you are measuring the empty set. One malformed entry invalidates the
 * spec.
 *
 * ## Why the window is truncated instead of rejected
 *
 * `:99m` is a scale typo, not an intention. Rejecting it would cost a
 * second round to the operator; truncating it to `TRACE_MAX_WINDOW_MS` gives
 * them the measurement and the ceiling. A NON-numeric value instead is
 * rejected: there is no honest interpretation of `:banana`.
 */

/** Window applied when the spec does not name one. One minute covers a short
 *  boot and a handful of gestures; enough to see, little enough not to weigh. */
export const TRACE_DEFAULT_WINDOW_MS = 60_000

/** Ceiling. Same value, for the same reason, as `CENSUS_MAX_WINDOW_MS`
 *  (`read-census.ts:57`) and `FleetReadCensus.MAX_WINDOW_MS` (`:87`): a
 *  diagnostic that can be left on becomes a tax nobody remembers having
 *  enabled. */
export const TRACE_MAX_WINDOW_MS = 10 * 60_000

/** A resolved arming entry. `deviceIds === null` means "all". */
export interface TraceArmEntry {
  readonly channel: string
  readonly deviceIds: readonly number[] | null
  readonly windowMs: number
}

export type TraceSpecParse =
  | { readonly ok: true; readonly entries: readonly TraceArmEntry[] }
  | { readonly ok: false; readonly errors: readonly string[] }

/** The grammar, in one line printable next to an error. */
export const TRACE_SPEC_GRAMMAR = 'channel[@id[+id…]][:duration]  (duration: 500ms | 90s | 2m)'

function parseWindow(raw: string): number | null {
  const m = /^(\d+)(ms|s|m)$/.exec(raw)
  if (m === null) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const unit = m[2]
  const ms = unit === 'ms' ? n : unit === 's' ? n * 1_000 : n * 60_000
  return Math.min(ms, TRACE_MAX_WINDOW_MS)
}

function parseDevices(raw: string): readonly number[] | null {
  const parts = raw.split('+').filter((p) => p.length > 0)
  if (parts.length === 0) return null
  const ids: number[] = []
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null
    ids.push(Number(p))
  }
  return ids
}

/** Known channels whose name resembles the wrong one — a typo must
 *  suggest, not only deny. */
function nearest(name: string, known: ReadonlySet<string>): readonly string[] {
  const head = name.split('.')[0] ?? name
  return [...known].filter((k) => k.startsWith(`${head}.`) || k === head).slice(0, 5)
}

export function parseTraceSpec(raw: string, known: ReadonlySet<string>): TraceSpecParse {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: true, entries: [] }

  const errors: string[] = []
  const entries: TraceArmEntry[] = []

  for (const token of trimmed.split(',').map((t) => t.trim()).filter((t) => t.length > 0)) {
    const [beforeWindow, windowRaw, ...extraColons] = token.split(':')
    if (extraColons.length > 0) {
      errors.push(`"${token}": too many ':'. Expected ${TRACE_SPEC_GRAMMAR}`)
      continue
    }
    const [channel, devicesRaw, ...extraAts] = (beforeWindow ?? '').split('@')
    if (extraAts.length > 0) {
      errors.push(`"${token}": too many '@'. Expected ${TRACE_SPEC_GRAMMAR}`)
      continue
    }
    if (channel === undefined || channel.length === 0) {
      errors.push(`"${token}": no channel. Expected ${TRACE_SPEC_GRAMMAR}`)
      continue
    }
    if (!known.has(channel)) {
      const hints = nearest(channel, known)
      const suffix = hints.length > 0 ? ` Maybe: ${hints.join(', ')}` : ''
      errors.push(`unknown channel "${channel}".${suffix}`)
      continue
    }
    const deviceIds = devicesRaw === undefined ? null : parseDevices(devicesRaw)
    if (devicesRaw !== undefined && deviceIds === null) {
      errors.push(`"${token}": "@${devicesRaw}" is not a list of numeric deviceIds.`)
      continue
    }
    const windowMs = windowRaw === undefined ? TRACE_DEFAULT_WINDOW_MS : parseWindow(windowRaw)
    if (windowMs === null) {
      errors.push(`"${token}": invalid duration "${windowRaw}". Expected ${TRACE_SPEC_GRAMMAR}`)
      continue
    }
    entries.push({ channel, deviceIds, windowMs })
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, entries }
}
```

- [ ] **Step 4 — run: green.**
- [ ] **Step 5 — verify the test is LOAD-BEARING.** Replace the branch
      `if (errors.length > 0) return { ok: false, errors }` with
      `return { ok: true, entries }`, re-run, confirm that the four rejection
      tests turn red, restore. **Report it.**
- [ ] **Step 6 — commit** (`feat(trace): la grammatica di armamento rifiuta, non disarma`).

### Task A2: the gate — ~zero cost when off, self-limiting when on

**Files:**
- Create: `packages/types/src/logging/trace-channel.ts` <!-- drift-ok: this plan creates it -->
- Create: `packages/types/src/logging/__tests__/trace-channel.spec.ts` <!-- drift-ok: this plan creates it -->

- [ ] **Step 1 — failing test.**

```ts
import { describe, it, expect } from 'vitest'
import type { IScopedLogger, LogExtras } from '../../interfaces/logging.js'
import { TraceChannel } from '../trace-channel.js'

interface Line { readonly level: string; readonly message: string; readonly extras?: LogExtras }

function spyLogger(lines: Line[]): IScopedLogger {
  const l: IScopedLogger = {
    debug: (m, e) => { lines.push({ level: 'debug', message: m, extras: e }) },
    info: (m, e) => { lines.push({ level: 'info', message: m, extras: e }) },
    warn: (m, e) => { lines.push({ level: 'warn', message: m, extras: e }) },
    error: (m, e) => { lines.push({ level: 'error', message: m, extras: e }) },
    child: () => l,
    withTags: () => l,
  }
  return l
}

const SPEC = { name: 'recorder.finalize', description: 'x', perDevice: true, maxPerSec: 20 } as const

describe('TraceChannel', () => {
  it('is born off: `on` is false and no line comes out', () => {
    const lines: Line[] = []
    const t = new TraceChannel(SPEC, spyLogger(lines))
    expect(t.on).toBe(false)
    t.log('never', { tags: { deviceId: 102 } })
    expect(lines).toHaveLength(0)
  })

  it('emits at INFO, never at debug — below info Loki discards (loki-destination.ts:168)', () => {
    const lines: Line[] = []
    const t = new TraceChannel(SPEC, spyLogger(lines))
    t.arm({ channel: SPEC.name, deviceIds: null, windowMs: 60_000 }, 1_000)
    t.log('line', { tags: { deviceId: 102 } })
    expect(lines.filter((l) => l.level === 'info')).toHaveLength(1)
    expect(lines.filter((l) => l.level === 'debug')).toHaveLength(0)
  })

  it('puts the channel name in tags.trace, next to the deviceId', () => {
    const lines: Line[] = []
    const t = new TraceChannel(SPEC, spyLogger(lines))
    t.arm({ channel: SPEC.name, deviceIds: null, windowMs: 60_000 }, 1_000)
    t.log('line', { tags: { deviceId: 102 } })
    expect(lines[0]?.extras?.tags).toMatchObject({ trace: 'recorder.finalize', deviceId: 102 })
  })

  it('filters by camera: 101 does not pass when the spec says 102', () => {
    const t = new TraceChannel(SPEC, spyLogger([]))
    t.arm({ channel: SPEC.name, deviceIds: [102], windowMs: 60_000 }, 1_000)
    expect(t.wants(102)).toBe(true)
    expect(t.wants(101)).toBe(false)
  })

  it('closes by itself at expiry and writes ONE closing line with the count', () => {
    const lines: Line[] = []
    const t = new TraceChannel(SPEC, spyLogger(lines))
    t.arm({ channel: SPEC.name, deviceIds: null, windowMs: 5_000 }, 1_000)
    t.log('a', { tags: { deviceId: 102 } })
    t.tick(6_500)
    expect(t.on).toBe(false)
    const close = lines.filter((l) => l.message === 'trace window closed')
    expect(close).toHaveLength(1)
    expect(close[0]?.extras?.meta).toMatchObject({ channel: 'recorder.finalize', lines: 1 })
    t.tick(9_000)
    expect(lines.filter((l) => l.message === 'trace window closed')).toHaveLength(1)
  })

  it('SUPPRESSES beyond maxPerSec but not silently: the count ends up in the closing line', () => {
    // Silence reads as "that branch was not taken". On a hot path that is
    // exactly the wrong conclusion.
    const lines: Line[] = []
    const t = new TraceChannel({ ...SPEC, maxPerSec: 2 }, spyLogger(lines))
    t.arm({ channel: SPEC.name, deviceIds: null, windowMs: 60_000 }, 1_000)
    for (let i = 0; i < 10; i += 1) t.log(`r${i}`, { tags: { deviceId: 102 } })
    expect(lines.filter((l) => l.message.startsWith('r'))).toHaveLength(2)
    t.tick(62_000)
    const close = lines.find((l) => l.message === 'trace window closed')
    expect(close?.extras?.meta).toMatchObject({ lines: 2, suppressed: 8 })
  })

  it('a second arm on the same channel RESTARTS instead of accumulating', () => {
    const lines: Line[] = []
    const t = new TraceChannel(SPEC, spyLogger(lines))
    t.arm({ channel: SPEC.name, deviceIds: null, windowMs: 5_000 }, 1_000)
    t.log('a', { tags: { deviceId: 102 } })
    t.arm({ channel: SPEC.name, deviceIds: [101], windowMs: 5_000 }, 2_000)
    expect(t.wants(102)).toBe(false)
    expect(t.wants(101)).toBe(true)
    t.tick(8_000)
    expect(lines.find((l) => l.message === 'trace window closed')?.extras?.meta)
      .toMatchObject({ lines: 0 })
  })
})
```

- [ ] **Step 2 — red.**
- [ ] **Step 3 — implement.**

```ts
import type { IScopedLogger, LogExtras, LogTags } from '../interfaces/logging.js'
import type { TraceArmEntry } from './trace-spec.js'

/** Declaration of a channel. Lives next to the code that uses it. */
export interface TraceChannelSpec {
  /** Dotted name, `area.thing`. It is the key of the spec and ends up in `tags.trace`. */
  readonly name: string
  /** What the operator will see by turning it on. Ends up in `listNodeTraceChannels`. */
  readonly description: string
  /** If true the spec accepts `@id`; if false it REJECTS it (does not ignore it). */
  readonly perDevice: boolean
  /**
   * Ceiling of lines per second. Mandatory: without it, a channel on a per-frame
   * path fills the Loki queue (`MAX_QUEUE = 10_000`,
   * `loki-destination.ts:37`) and silently drops the very lines it exists to
   * produce. Lines beyond the ceiling are COUNTED and reported at closing.
   */
  readonly maxPerSec: number
}

const SECOND_MS = 1_000

/**
 * An armable trace channel.
 *
 * ## The cost with the channel off
 *
 * `on` is a FIELD, not a getter, and the canonical call shape is
 * `if (T.on && T.wants(id)) T.log(...)`. When off you pay a load and a branch;
 * the `extras` object is not built because it sits inside the branch. It is the
 * same shape already in production at `stream-broker.ts:1650`.
 * `check-trace-call-shape.ts` rejects every other shape: without the `T.on &&`
 * prefix, `wants()` would pay a `Set.has` on every tick even with the channel
 * off.
 *
 * ## Why `info` and not `debug`
 *
 * `loki-logging.addon.ts:50` sets the threshold to `info` and
 * `loki-destination.ts:168` discards everything below it. A `debug` line does not
 * reach Loki, and the hub's in-memory ring holds ~35 minutes: a measurement asked
 * for an hour later does not exist. All the existing censuses emit at `info` for
 * this reason (`read-census.ts:301`, `fleet-read-census.ts:161`).
 */
export class TraceChannel {
  /** HOT-PATH GUARD. Do not turn into a getter. */
  on = false

  private devices: ReadonlySet<number> | null = null
  private closesAt = 0
  private armedAt = 0
  private emitted = 0
  private suppressed = 0
  private windowStartMs = 0
  private inWindow = 0
  private closed = true

  constructor(
    readonly spec: TraceChannelSpec,
    private readonly logger: IScopedLogger,
  ) {}

  /** Arms (or RE-arms, restarting) this channel. `nowMs` is injected: no clock
   *  inside, so tests do not wait. */
  arm(entry: TraceArmEntry, nowMs: number): void {
    this.devices = entry.deviceIds === null ? null : new Set(entry.deviceIds)
    this.armedAt = nowMs
    this.closesAt = nowMs + entry.windowMs
    this.emitted = 0
    this.suppressed = 0
    this.windowStartMs = nowMs
    this.inWindow = 0
    this.closed = false
    this.on = true
  }

  /** Does it want this line? Call ONLY behind `on &&`. */
  wants(deviceId: number): boolean {
    if (!this.on) return false
    return this.devices === null || this.devices.has(deviceId)
  }

  /** Writes the line, if the per-second ceiling allows it. */
  log(message: string, extras: LogExtras): void {
    if (!this.on) return
    const nowMs = Date.now()
    if (nowMs - this.windowStartMs >= SECOND_MS) {
      this.windowStartMs = nowMs
      this.inWindow = 0
    }
    if (this.inWindow >= this.spec.maxPerSec) {
      this.suppressed += 1
      return
    }
    this.inWindow += 1
    this.emitted += 1
    const tags: LogTags = { ...extras.tags, trace: this.spec.name }
    this.logger.info(message, { ...extras, tags })
  }

  /**
   * Closes the window if it has expired. Called by the registry on a timer; NOT
   * by the hot path — a diagnostic must not add a clock read to the path it is
   * measuring.
   */
  tick(nowMs: number): void {
    if (this.closed || nowMs < this.closesAt) return
    this.closed = true
    this.on = false
    this.devices = null
    this.logger.info('trace window closed', {
      meta: {
        channel: this.spec.name,
        elapsedMs: nowMs - this.armedAt,
        lines: this.emitted,
        // A channel that suppressed a lot was on the wrong path, or the
        // ceiling is wrong. In both cases the number is the answer.
        suppressed: this.suppressed,
      },
    })
  }
}
```

- [ ] **Step 4 — green.**
- [ ] **Step 5 — load-bearing check.** Change `this.logger.info` to
      `this.logger.debug` inside `log`; the "emits at INFO" test must turn
      red. Restore. Then remove `this.closed = true` from `tick`; the
      single-closing test must turn red. Restore. **Report both.**
- [ ] **Step 6 — commit.**

### Task A3: the registry, and the line that says "I rejected"

**Files:**
- Create: `packages/types/src/logging/trace-registry.ts` <!-- drift-ok: this plan creates it -->
- Create: `packages/types/src/logging/__tests__/trace-registry.spec.ts` <!-- drift-ok: this plan creates it -->
- Modify: `packages/types/src/interfaces/logging.ts` (add `trace?: string`
  to `LogTags`, next to `sessionId` — it is a cross-cutting tag, not `meta`)
- Modify: `packages/types/src/index.ts` (barrel)

- [ ] **Step 1 — failing test.** It covers exactly the three behaviours the
      existing mechanisms get wrong:

```ts
it('a malformed spec arms NOTHING and writes a WARN line naming the typo and the grammar', () => {
  const lines: Line[] = []
  const reg = new TraceRegistry(spyLogger(lines))
  const ch = reg.declare({ name: 'recorder.finalize', description: 'x', perDevice: true, maxPerSec: 20 })
  reg.applySpec('true', 1_000)
  expect(ch.on).toBe(false)
  const warn = lines.find((l) => l.level === 'warn')
  expect(warn?.message).toBe('trace spec rejected')
  expect(JSON.stringify(warn?.extras?.meta)).toContain('true')
  expect(JSON.stringify(warn?.extras?.meta)).toContain('channel[@id')
})

it('a valid spec writes an INFO line saying what was armed and for how long', () => {
  // Without this line the operator cannot tell "armed" from "the code is not
  // the one deployed" — the most expensive confusion in this repo.
  const lines: Line[] = []
  const reg = new TraceRegistry(spyLogger(lines))
  reg.declare({ name: 'recorder.finalize', description: 'x', perDevice: true, maxPerSec: 20 })
  reg.applySpec('recorder.finalize@102:90s', 1_000)
  const info = lines.find((l) => l.message === 'trace armed')
  expect(info?.extras?.meta).toMatchObject({
    channel: 'recorder.finalize', deviceIds: [102], windowMs: 90_000,
  })
})

it('REJECTS `@id` on a non-perDevice channel instead of ignoring it', () => {
  const lines: Line[] = []
  const reg = new TraceRegistry(spyLogger(lines))
  const ch = reg.declare({ name: 'device-manager.fleet-read', description: 'x', perDevice: false, maxPerSec: 50 })
  reg.applySpec('device-manager.fleet-read@102', 1_000)
  expect(ch.on).toBe(false)
  expect(lines.find((l) => l.level === 'warn')).toBeDefined()
})

it('two channels declared with the same name are a programming error, not a merge', () => {
  const reg = new TraceRegistry(spyLogger([]))
  reg.declare({ name: 'a.b', description: 'x', perDevice: false, maxPerSec: 1 })
  expect(() => reg.declare({ name: 'a.b', description: 'y', perDevice: false, maxPerSec: 1 })).toThrow()
})
```

- [ ] **Step 2 — red.**
- [ ] **Step 3 — implement** `TraceRegistry` with: `declare(spec): TraceChannel`
      (throw on duplicate name), `names(): ReadonlySet<string>`,
      `applySpec(raw, nowMs): boolean`, `list(): readonly TraceChannelSpec[]`,
      `startTicker(intervalMs)` / `stopTicker()` that calls `tick(Date.now())`
      on every channel. `perDevice: false` with `@` becomes an error
      **after** the parse (the parser does not know the specs) — add the check
      in `applySpec` and merge it into the same `errors` list.
- [ ] **Step 4 — green.** + **Step 5 — load-bearing check** (remove the `throw`
      on the duplicate → red).
- [ ] **Step 6 — commit.**

---

## Track B — the plumbing: two roads, one string

> **Do not start B before A is merged.** B is all plumbing: if the grammar
> changes afterwards, every piece of B must be redone.

### Task B1: arming at BOOT, from `CAMSTACK_TRACE`

This is the case that `fleet-read-census.ts:19-27` says — correctly — a custom
action cannot cover.

- [ ] At the point where the hub builds the `LoggingService`
      (`server/backend/src/core/logging/logging.service.ts`), and in
      `addon-runner.ts` right after `udsChildClient.start()` has resolved
      (`:455` — **after**, because before there is no transport and the rejection
      line would be lost: the `LocalChildClient` buffers, but the rejection of a
      malformed spec must be readable even if the connect fails), call
      `registry.applySpec(process.env['CAMSTACK_TRACE'] ?? '', Date.now())`.
- [ ] Test: `CAMSTACK_TRACE` unset → no line, no channel armed
      (a diagnostic that is off must not produce startup noise).
- [ ] Test: `CAMSTACK_TRACE` set to a broken value → the boot **proceeds**.
      Repo rule: `check-inventory-never-fatal.ts` exists because *"we should never
      prevent boot"*. A broken spec disarms and logs; it does not refuse to start.
- [ ] Propagation test: `spawnRunner` copies `...process.env`
      (`process-service.ts:487`), so assert that `CAMSTACK_TRACE`
      appears in `childEnv`. **Do not add it to the explicit list** near
      `CAMSTACK_LOG_LEVEL` (`:501`): that list exists for the variables
      REWRITTEN per child, and `CAMSTACK_TRACE` must arrive identical.
- [ ] Commit.

### Task B2: arming at RUNTIME, `nodes.setNodeTrace`

- [ ] `packages/types/src/capabilities/nodes.cap.ts`, next to
      `setProcessLogLevel` (`:225`):

```ts
/**
 * Arms verbose trace on ONE node, for a window that closes by itself.
 *
 * Runtime twin of `CAMSTACK_TRACE`: same grammar, same registry. The env road
 * exists because a STARTUP storm is already over when a process can receive a
 * mutation (`fleet-read-census.ts:19-27`); this one exists because a
 * STEADY-STATE mystery must cost neither a container re-creation nor a redeploy
 * (`read-census.ts:38-42`).
 *
 * There is NO cluster broadcast: arming NAMES a node. The operator's question is
 * "why is 102 worse than 101", and 102 and 101 sit on one node.
 */
setNodeTrace: method(
  z.object({ nodeId: z.string(), spec: z.string() }),
  z.object({ accepted: z.boolean(), errors: z.array(z.string()).readonly() }),
  { kind: 'mutation', auth: 'admin' },
),
/** The channels that node DECLARES, with description — the list from which a
 *  spec is built without guessing a name. */
listNodeTraceChannels: method(
  z.object({ nodeId: z.string() }),
  z.array(TraceChannelDescriptorSchema).readonly(),
  { auth: 'admin' },
),
```

- [ ] **`npm run codegen`.** Mandatory: you touched a `*.cap.ts`.
- [ ] `SetTraceMessage` in `child-cap-protocol.ts`, modelled line by line on
      `SetLogLevelMessage` (`:241-249`), added to `ParentToChildRequest`.
- [ ] `LocalChildRegistry.setChildTrace(childId, spec): boolean`, twin of
      `setChildLogLevel` (`:599-605`) — same `false` when the child is not
      connected, which is what enables the fallback.
- [ ] `LocalChildClient.onSetTrace(handler)`, twin of `onSetLogLevel`
      (`:192-194`), routed in the `switch` at `:248`.
- [ ] `addon-runner.ts`: registers `onSetTrace` next to `onSetLogLevel`
      (`:446`) and forwards to `registry.applySpec`.
- [ ] Provider in `cap-providers.ts`, **with the same shape** as
      `setProcessLogLevel` (`:704-720`): UDS first, `$node-mgmt` as fallback
      for agents.
- [ ] Test: an unreachable node returns `accepted: false` with an error
      that NAMES it. **Not** `success: true`: it is defect D-1 of
      `setProcessLogLevel`, which today answers `{ success: true }`
      (`cap-providers.ts:720`) even when it only touched the runner's
      self-logger.
- [ ] Commit.

### Task B3: `listNodeTraceChannels` is generated, not written

- [ ] The list comes from `registry.list()`. No hand-written copy: a hand-written
      channel list is the next thing that goes into drift.
- [ ] Extend `scripts/docs-generate.ts` so that it emits the declared channels in
      `docs/reference/`. It is the place `CLAUDE.md` sends you to look for facts,
      and the operator must not have to read the code to know what they can turn
      on.
- [ ] Commit.

---

## Track C — retirements, defects, guards

### Task C1: `CAMSTACK_FLEET_READ_CENSUS_MS` is retired

`FleetReadCensus` **stays**: it is an accumulator with stack attribution, not a
stream of lines, and its usefulness is orthogonal. Only **how it is armed**
changes.

- [ ] `fleet-read-census.ts`: remove the constructor that parses the env
      (`:94-99` — defect D-2 disappears with it) and replace it with an
      injected `TraceChannel`, declared `device-manager.fleet-read`,
      `perDevice: false`.
- [ ] `device-row-store.ts:469`: pass the channel instead of
      `process.env['CAMSTACK_FLEET_READ_CENSUS_MS']`.
- [ ] `siteOf()` (`:125`) becomes `if (!channel.on) return null` — the stack
      capture, which is the expensive part, stays behind the same guard as before.
- [ ] Test: `CAMSTACK_TRACE="device-manager.fleet-read:90s"` produces the same
      report the old env produced. **Do not change the report format**: there is
      a 2026-08-25 measurement in Loki to compare against.
- [ ] Delete every mention of `CAMSTACK_FLEET_READ_CENSUS_MS` from
      `scripts/deployment-templates.ts` and from the docs; <!-- drift-ok -->
      `check-deployment-templates.ts` rejects a file that tells the operator how
      to run the image while disagreeing with the image.
- [ ] Commit.

### Task C2: the two audit defects

Two separate commits, so a bisect distinguishes them.

- [ ] **D-1a.** `addon-context-factory.ts:451` uses `createUdsLogger`, which opens
      a private, control-less `{ current: 'debug' }` (`uds-logger.ts:145-158`):
      the `ctx.logger` of every forked addon is **not reachable** by
      `setProcessLogLevel`, and every `debug` line crosses the UDS. Make it go
      through `createUdsLoggerWithControl` with the runner's shared state. Test:
      a `set-log-level` to `warn` makes the `debug` lines of `ctx.logger`
      disappear, not only those of `addon-runner`.
- [ ] **D-1b.** Nobody reads `CAMSTACK_LOG_LEVEL` inside `addon-runner`, while
      `:40` documents it and `process-service.ts:497-501` explains why it sets it.
      Initialise `levelState` from the env. Test: `CAMSTACK_LOG_LEVEL=warn`
      at runner start discards the `debug` lines **before** `sendLog`.
- [ ] Delete the doc line `addon-runner.ts:40` if after the fix it is still
      imprecise (it says "default debug"; afterwards it becomes "default `info`,
      inherited from the parent"). A leftover that describes the right design
      reads as verification.

### Task C3: the guards

A rule nobody checks has already been broken somewhere.

- [ ] `scripts/check-trace-call-shape.ts` — every `\.log\(` on an identifier <!-- drift-ok: this plan creates it -->
      that is a `TraceChannel` must sit inside an `if` whose condition starts with
      `<same identifier>.on &&`. Textual, with per-file ratchet like
      `check-silent-observation-drop.ts` (which has exactly this shape and this
      motivation).
- [ ] `scripts/check-trace-channel-registered.ts` — every channel name that <!-- drift-ok: this plan creates it -->
      appears in a `TraceChannelSpec` is unique in the workspace, and every name
      cited in a doc exists. It stops `CAMSTACK_TRACE` from becoming a minefield
      of typos.
- [ ] `scripts/check-trace-emits-at-info.ts` — no `TraceChannel` calls <!-- drift-ok: this plan creates it -->
      `logger.debug`. It is the rule everything else in the plan rests on:
      **below `info` it does not reach Loki** (`loki-destination.ts:168`,
      `loki-logging.addon.ts:50`), and an invisible diagnostic is worse than no
      diagnostic because it looks done.
- [ ] Add all three to `.github/workflows/ci.yml`. `docs/reference/guards.md`
      is **generated**: do not touch it by hand.
- [ ] Commit.

### Task C4: document, with `covers` and not with `applies-to`

- [ ] `docs/architecture/` **has no logging page**: the "Logging and log shipping"
      section of `docs/reference/subsystems.md` is marked ⚠️ with 4+3+3+3
      uncovered files. This plan touches exactly that subsystem. Create
      `docs/architecture/logging.md` that claims the code <!-- drift-ok: this plan creates it -->
      with **`covers:`**, not with `applies-to:` — a class page armed
      via `applies-to` is suspect forever and destroys the ratchet (D145).
- [ ] A record in `docs/decisions/` (copy `docs/decisions/template.md`): *a
      single trace mechanism, two arming roads, emission at `info`, bounded
      window*. It must cite the contradiction (2) vs (3) and say why the
      difference was essential but did not require two mechanisms.
- [ ] Append to (planning repo: sessions/sessions.md) the two defects D-1 and D-2 and the <!-- drift-ok: moved to the private planning repo -->
      Loki constraint, **even though C2 fixes them**: the next person who raises
      `CAMSTACK_LOG_LEVEL` to `debug` and sees nothing in Loki must find the
      answer written down.
- [ ] Invoke the `sync-docs` skill. `docs/reference/*` and
      `docs/decisions/index.md` are generated on commit.

---

## What NOT to do, and why

- **Do not unify `streamingDebug`, `webrtcDebug`, `debugGeneral`,
  `debugSocketLogs`, `debugLogging`.** They are not verbosity: they **change what
  the process does**. `debugLogging` respawns cloudflared with different argv
  (`cloudflare-tunnel.ts:290`); `debugSocketLogs` resets the Baichuan control
  channel (`reolink-camera.ts:8272-8274`); `webrtcDebug` is read at session
  creation and changes the session object
  (`device-scoped-providers.ts:255-262`). A logging switch whose flip restarts a
  subprocess is exactly the "second switch that contradicts the first" of D62.
  They stay where they are, owned by their addon. The only thing to do is to
  **name** them in the logging page as "not trace".
- **Do not touch the viewer's `ALWAYS_SHIP_SCOPES`** (`camstack/src/lib/logger.ts:60`).
  It solves a different problem: which low-rate `info` lines **leave a phone** on
  a network the hub does not control. It is not verbosity, it is a shipping
  decision on a device the hub cannot arm. And in this work the submodule is
  read-only.
- **Do not retire `StoreReadCensus` nor `debug.storeCensus`.** A census
  **aggregates and attributes** (3-frame stack → `(op, site, calls, rows)`); trace
  **emits lines**. They are different tools for different questions, and the
  action also returns a table to the UI, which a log line does not. What should be
  done — separately, not here — is to **merge the two copies**
  (`addon-post-analysis/.../read-census.ts` and its "ported from" in
  `recorder/addon/store/read-census.ts:17-19`) into a shared primitive,
  exactly as track B of the storage plan does with `placement-planner`.
- **Do not retire `CAMSTACK_LOG_LEVEL` nor `nodes.setProcessLogLevel`.** They remain
  the coarse production knob. Trace replaces their **diagnostic** use, not their
  operational use.
- **Never emit trace at `debug`**, not even "since in debug mode the hub is already
  verbose". Below `info` the line does not reach Loki and the measurement does not
  exist an hour later.
- **Do not add `deviceId` to the Loki labels** to make the filter more convenient.
  `loki-payload.ts:20-42` explains the cardinality; `| json | deviceId="102"`
  works and is the right way.
- **Do not make the hot path read the clock** to close the window. Closing is on a
  registry ticker. A diagnostic that adds a `Date.now()` to the path it is
  measuring measures itself.
- **Do not introduce a `console.log` "just for trace"**, not even before the UDS
  is connected. The `LocalChildClient` already buffers
  (`uds-logger.ts:4-16`).

---

## What remains unknown, and must be measured instead of assumed

- **The real cost of a line on the UDS → `LogManager` → Loki batch round.** The
  plan asserts "3.4/s is fine, per-frame is not" by analogy with
  `nodeav-decoder-session.ts:1140` (which self-limits to 1 Hz) and with the
  `MAX_QUEUE` ceiling. **It is not measured.** `maxPerSec` is the mitigation, not
  the answer. The measurement to take: arm a channel on a path of known rate and
  read `LokiStatus.dropped` (`loki-destination.ts`) before and after.
- **Whether a trace window on a hot path drops its own lines.**
  `LokiDestination` discards **the oldest** when the queue exceeds 10,000
  (`loki-destination.ts:37,172`) and counts the drops, but exposes them **only**
  from `getStatus()`, that is to the UI — deliberately, because that module cannot
  log (`loki-destination.ts:7-20`). So today it is not known whether an
  aggressive trace silently erases the very lines it was turned on for. If the
  number turns out to be real, the channel's closing line must report it — and it
  must be understood **whether an addon can read that state**, which has not been
  verified.
- **Whether `process.env['CAMSTACK_TRACE']` set on hub-main really reaches a
  runner forked afterwards.** The code says yes (`process-service.ts:487`), but
  nobody has done it, and this repo has already had a case where a test passed
  because the fake supplied the value that production forgot to read. The test of
  Task B1 must be written against `spawnRunner`, not against an env fake.
- **How many channels are really needed.** Zero channels are declared at the end
  of this plan except `device-manager.fleet-read`. Declaring twenty in advance is
  the same bet that produced five mechanisms. The next channel is declared the
  first time someone needs it, and the plan is finished when the mechanism exists
  — not when it is full.
- **Whether defect D-1 explains a log volume that is unexplained today.** Every
  `debug` line of every forked addon crosses the UDS and reaches the hub's
  `LogManager`, against the intention written at `process-service.ts:497-500`.
  How much that is, in lines per second on a hub with ~30 runners, **is not
  measured**. Measuring it before C2 also gives the "before" of an after.

---

## Addendum (operator request, 2026-08-26) — a logging page, and no more environment variable

> Added after the parking. **To be incorporated into the tasks when work resumes**,
> it has not yet been broken down into steps.

The operator: *"converrebbe eliminare la variabile di ambiente ed averne una di
sistema runtime, con una nuova pagina specifica per il logging dove settare i
vari livelli"* [it would be better to eliminate the environment variable and have
a runtime system one, with a new page specific to logging where the various
levels can be set].

### Why it is the right move

The audit above found that levels are **five knobs scattered across three
different settings panels** (console-logging, winston-logging, loki-logging) plus
two kernel config keys (`maxTotalLogBufferSize`, `logBufferPruneLevel`) plus an
environment variable that **does not work**. No place shows the picture, and the
picture is exactly what is needed to answer the real question: *"this line, where
does it end up and for how long?"*.

A single page showing the path and its thresholds makes visible the rule that
everyone today rediscovers from scratch: **a diagnostic that must survive more
than 35 minutes must be emitted at `info`, because Loki discards below `info` and
the in-memory ring holds ~35 minutes.**

### What the page must show, and in this order

The path of a line, not an alphabetical list of settings:

    emission  →  UDS  →  hub-main  →  ┬→ log-buffer (RAM)   level + ceilings
                                       ├→ console            level
                                       ├→ winston (file)     level + days
                                       └→ loki               level

For each destination: the level, the cost it pays (RAM / disk / network) and the
retention window. The `log-buffer` shows `perAddonLogBufferSize`,
`maxTotalLogBufferSize` and `logBufferPruneLevel` — with the clarification that
that is a PRUNING level and not an admission level (it keeps everything as long
as there is room).

### The constraint this idea must face

**A runtime setting cannot govern boot.** It is the only legitimate use the
environment variable would have: the moment when the settings store is not yet
readable. The options, to be decided when work resumes:

- (a) Accept that the very first instants stay at the default `info`, and remove
  the variable without replacing it. Simple, and honest in practice — the default
  is `info` and at `info` the line reaches Loki anyway.
- (b) Persist the setting in a file read before the settings store — in effect
  reintroduces the environment variable under another name.

Provisional recommendation: **(a)**. The boot storm is investigated with trace
(`CAMSTACK_TRACE`), which is armed at construction exactly for that; raising the
global level at boot was never the right way to investigate it, and it did not
reach Loki anyway.

### What must be eliminated, and said explicitly

- `CAMSTACK_LOG_LEVEL` — it does not reach any addon's code (D-1).
- `nodes.setProcessLogLevel` — it answers `{ success: true }` without doing what it
  says (D-1). **Removing it is an API change**: it must be taken out of any UI
  that calls it as well, and the removal goes in the changelog. A method that lies
  is worse than an absent method, but disappearing silently is worse than both.
- The doc line at `addon-runner.ts:40`, which describes the right design and is
  not true — it is the leftover that for months made people believe the knob
  worked.

### What NOT to do here

- **Do not turn the page into a log viewer.** That already exists. This page
  configures the path; showing the lines too would make it two things and
  neither done well.
- **Do not expose an admission level for the ring.** See above: pruning is the
  better choice and is already there.

---

# Addendum — 2026-08-27: the TRANSPORT plane

Added after a day of hunting `deviceManager.listAll` that burned half a day for
one reason only: **we know what was called, and not from which PLANE it came.**

## The fact that motivates it

At hub boot: **4,960 calls to `listAll` in two minutes**, ~1,017 rows each. The
fleet census (`fleet-read-census.ts`) attributes the addons (~64 calls) and says
nothing about the other 4,960 — it **cannot**, by construction: it lives in the
store and sees a stack that stops at the dispatcher.

The `HttpRequestCensus` (ADR-0244, in main since 2026-08-27) covers the HTTP
plane: it counts **per procedure and per caller**. But `main.ts` declares that the
viewer talks to the hub **exclusively via `wsLink`**, naming `listAll` in the
comment itself. So the expected outcome of the HTTP census is ~zero, and the
culprit stays invisible.

Demonstrated cost of the ignorance: two client fixes (admin-ui `GlobalSearch`,
embed `EmbedGridPage`) shipped against a wrong hypothesis, with the number
unmoved — 4,960 against 4,888. They were not useless, but they were not the
cause.

## Track D — a declared plane for every call

> **Done on 2026-08-27 (D246).** D1 (WS plane, hooked on the FRAME because the
> tRPC adapter exposes no per-operation seam), D2 (mesh plane on `$core-caps`,
> with `CoreCapCallOrigin` to name the caller) and D3 (the `transport census` line
> with `planes` + `planesExplainTotal`) are in code. Subscriptions are counted
> separately and do not enter `procedureCalls`.
> The non-double-counting with the fleet census is declared in
> `http-request-census.ts` and pinned in `core-cap-bridge.spec.ts`.

**The invariant**: every call to a procedure is attributed to ONE transport
plane — `http`, `ws`, `mesh` (in-process, `createCaller`) — and to a caller. A
plane that cannot attribute **says so**, and its calls end up in a named bucket:
never lost, never silently absent.

### Task D1 — the WebSocket plane

The hard part, and the reason it is not already done: `applyWSSHandler` creates
**one context per CONNECTION**, not per call. `recordTrpcHttpRequest` is hooked
onto the context factory, which on WS fires once every 37 connections, not once
every call.

A **per-operation** hook is needed, not per-context. Constraints:

- The cost when off stays the cost of today: a boolean field read as the FIRST
  instruction, no `Date.now()` read, no allocation. The spec that pins it already
  exists (`http-request-census.spec.ts`: a request whose getters throw) —
  **extend it, do not write a second one**.
- Identity is that of the CONNECTION, not of the single call: derived once with
  `describeTrpcPrincipal` and reused. Never the token, never a header.
- A subscription is not a query: count `subscription` separately, or a long-lived
  stream will disguise itself as a storm.

### Task D2 — the mesh (in-process) plane

`createCaller` does not touch the network and no census sees it. If the 4,960 are
its, today there is no tool that says so.

**Beware of double counting**: a mesh call that ends up in the store is already
seen by the fleet census. The two tools must be readable TOGETHER without adding
up the same call twice — declaring which counts what is part of the task, not a
margin note.

### Task D3 — the line that ANSWERS the question

A single line, per window, that puts the planes side by side:

```
transport census  http=8  ws=4931  mesh=21  unattributed=0
                  top=[{plane:ws, caller:…, procedure:deviceManager.listAll, calls:4931}]
```

The acceptance criterion is not "the line exists": it is that **the sum of the
planes explains the store's total**. If it does not add up, a plane is missing —
and that is the result, not a failure.

## Track E — align the arming, do NOT add a second one

⚠ **Track B of this plan was written before ADR-0244 existed.** It envisages
`nodes.setNodeTrace` as the runtime arming mechanism. In the meantime the HTTP
census has implemented one: **a persisted EXPIRY** (not a switch), which survives
a restart by re-arming the remaining time before the socket opens, and which
expires by itself if forgotten.

That shape is better for the case we care about — **the storm is at BOOT**, and
a switch turned on by hand after startup always arrives late.

Before writing Track B: **reuse the shape of ADR-0244.** Two arming mechanisms
that contradict each other are exactly the defect that the section "The two
mechanisms that contradict each other" of this same plan denounces —
reintroducing it from the side of the cure would be grotesque.

## Track F — EXTEND the page that exists, do not create a new one

⚠ **Corrected on 2026-08-27 after looking at the code.** The previous version said
"a new specific page". Wrong: the surfaces already exist, and there are TWO.

- `/system/logs` (`pages/system/Logs.tsx`) — the **viewer**, in the navigation
  bar.
- `pages/system/Logging.tsx` (`LoggingPage`) — the **settings**, mounted as a TAB
  inside `Data.tsx` together with Storage and Backup. One tab for each
  `log-destination` provider; each carries its own `globalSettingsSchema()`,
  rendered by the attached Settings panel. Nothing is hand-wired.

The defect is not the absence of a page: it is that **the settings are buried
under "Data" while the logs are under "System"**. The operator asked "where is
this page?" — which is the measure of the problem.

### The three intended sections

1. **General log level** — today it belongs to no destination.
2. **The loggers' capability with their own settings** — it ALREADY EXISTS and
   works: do not rewrite it, reuse it where it is.
3. **The new settings** — census per transport plane (Track D), channels per
   component (Tracks A/B).

### The design knot to untie BEFORE writing code

`Logging.tsx` documents *why there is no orchestrating capability for
logging*: it is not needed, because each destination owns its settings
and `LogManager` already distributes to all of them.

But sections 1 and 3 **belong to no destination**: they are NODE-level. So one of
two things — either the capability that page deliberately avoided is introduced
(with the cost the comment lists: codegen, a framework publication, a second
place where a destination's identity lives), or these settings are given a home
that **does not pretend to be a destination**.

Deciding this is the first task of the track. A node knob disguised as a
destination would be a structural lie, and this repo has already paid for two
(D62).

### The chosen solution (2026-08-27, operator decision)

No new orchestrating capability: **the `system` cap is extended**, which already
hosts `getRequestCensus`/`setRequestCensus` (ADR-0244) and is already `auth:
'admin'`. And the `Logging` page **moves inside `/system/logs`**, which becomes
tabbed.

#### 1. ONE pair of methods, not a pair per knob

The risk of this road is crumbling: today two methods for the census, tomorrow
two for the level, two for the channels, two for WS. Eight methods that configure
the same thing are eight places to get it wrong.

So **a single document**, read and written whole:

```
system.getLoggingSettings { nodeId? }        -> { effective, explicit, activeWindows }
system.setLoggingSettings { nodeId?, patch } -> the same state, after
```

`patch` **merges**, it does not replace (`setAll` already merges: do not write
`{...snapshot, ...patch}`). Adding a knob = adding a field to the schema, **never**
a method.

#### 2. "All the levels" = a hierarchy, and it is RETURNED

Three layers, from general to particular: **cluster -> node -> component**.
The most specific wins.

`getLoggingSettings` returns **both `effective` and `explicit`**. Without
`explicit` the page cannot distinguish *"this node is at `info` because I decided
so"* from *"...because it inherits"*, and an operator who turns off an override
thinking they are turning off an inherited value understands nothing anymore. It
is the same defect as the two knobs that contradict each other, moved up a plane.

#### 3. Every DIAGNOSTIC setting carries an expiry, not a boolean

General level and destinations are permanent. Everything else — channels per
component, transport census — is diagnostic: it is armed for a WINDOW, with the
shape of ADR-0244 (persisted expiry, re-armed at boot for the remaining time,
expiring by itself).

`activeWindows` in the response is what the page shows. A diagnostic left on and
forgotten is itself an incident, and this is the only way to notice.

#### 4. The authority is the document; the hot path reads a MIRROR

The constraint that decides whether the thing is usable: the gate is read **at
every log line and at every request** — at 41 req/s it cannot touch the settings
store. So the document is the **durable** authority, and in memory lives a mirror
refreshed off the hot path (D49/D224). The cost when off stays a boolean field
read as the first instruction.

A failed read of the store **does not change the mirror**: it neither turns off an
armed channel nor turns one on. D49 to the letter.

#### 5. `setRequestCensus` becomes a FACADE, or disappears

It cannot remain a second authority over the same state. Either it is absorbed
into the document and the two methods become shortcuts that write THERE, or they
are retired. What **cannot** happen is that two writes exist that say different
things about the same window — which is exactly the defect denounced in
"The two mechanisms that contradict each other", reintroduced from the side of the
cure.

#### 5-bis. Channels are DECLARED by addons, but the values stay ONE

Operator question (2026-08-27): *"come gestiamo le flags per
camera/addon? Ogni addon puo' estendere una cap logging? stream-broker
(webrtc), reolink con i suoi debug logs..."* [how do we handle the flags per
camera/addon? Can each addon extend a logging cap? stream-broker (webrtc), reolink
with its debug logs...]

They are **two axes**, and they must be separated or everything breaks:

- **DECLARATION** — which channels exist. Only the addon knows: `stream-broker`
  knows webrtc/ICE/RTP/repacketizer, `provider-reolink` knows
  baichuan/handshake/PTZ. A hand-wired central list **rots at the first
  addition**, and it is invisible when it rots.
- **VALUE** — at what level, for which scope, until when. This stays **ONE**
  (§1): the document on the `system` cap. Two authorities over the values are the
  defect this plan denounces.

So: **yes, a new cap — but to DECLARE, not to store.**

##### The shape, traced on `log-destination`

`log-destination.cap.ts` is already exactly this job: `mode:
'collection'`, `internal: true`, `mount: { kind: 'skip' }` — no tRPC route, no
generated hook, and `addons.listCapabilityProviders` enumerates it all the same
(it is the trick `Logging.tsx` already uses). **Copy that shape.**

A `log-channels` provider declares the channels of its addon: name, a sentence
saying what you will see by turning it on, and the default level. Nothing else —
no value, no state.

##### The scope includes the CAMERA, and it works for a precise reason

A diagnostic window carries a scope: **cluster / node / addon / channel /
`deviceId`**.

The per-camera case is feasible **only because the repo already mandates that
every line about a device carries `tags: { deviceId }` with the numeric id**. It
is the rule written in `CLAUDE.md`, paid for with 22% of missing thumbnails and a
3-hour blackout diagnosed by hand. The per-camera gate is that rule finally
paying off.

Corollary to write on the page: **a channel whose logs do not carry the tag is
not filterable by camera.** Declaring it as if it were would be a lie.

##### The guard — the third time today this pattern is needed

A **declared** channel that no point of the code consults is a dead knob: you turn
it on and nothing happens, forever, without a line. It is D62, and it is the same
defect as `audioThresholdDbfs` and the HA entities without a source.

`scripts/check-log-channel-gated.ts` <!-- drift-ok: this plan creates it --> is needed, modelled on
`check-recording-trigger-fed.ts` (which exists, works and is already in CI): every
channel declared by a `log-channels` provider must be consulted by at least one
real gate, or appear in a set of **dated and motivated** exceptions. Hook it into
`.github/workflows/ci.yml` next to the other one.

#### 6. The tabs of `/system/logs`

`Viewer` (today's) · `Destinations` (the current `LoggingPage`, unchanged: each
provider already carries its schema) · `Levels` (the hierarchy, with `effective`
vs `explicit` visible) · `Diagnostics` (armed windows and their expiry).

The `Logging` tab under `Data` **disappears**. Not two places that configure
logging.

### Constraints

- **One road only.** If the page moves or is unified, the old one disappears —
  not two places that configure logging. It is the same rule that today made the
  double assignment path in the Review page be deleted.
- The page shows **the active diagnostic windows with their expiry**: a
  diagnostic left on and forgotten is itself an incident.

## (superseded) The new page

Explicit request: *"eliminare la variabile di ambiente ed averne una di
sistema runtime, con una nuova pagina specifica per il logging dove settare i
vari livelli"* [eliminate the environment variable and have a runtime system one,
with a new page specific to logging where the various levels can be set].

The page governs **channels, levels and arming windows** — and shows the
**active** windows **with their expiry**, because a diagnostic left on and
forgotten is itself an incident.

The prohibition already written at the bottom of Track C holds: **do not turn it
into a line viewer.** That already exists; making it two things would make it bad
at both.

## What this addendum does NOT solve

Why `listAll` is called 4,960 times. This plan makes the question
**answerable**; the answer is an investigation of its own, and it must be done
AFTER — with the tool in hand, not before.
