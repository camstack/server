/**
 * The judgement of `check-onboard-motion-emitters.ts` (D673), as a pure
 * function over source files.
 *
 * A camera's EFFECTIVE onboard motion has one emitter — the orchestrator's
 * camera-sensors bridge — because Confirm and Replace must be able to
 * suppress the camera's own motion, and a provider that emits
 * `MotionOnMotionChanged` directly reaches every consumer raw (seven of them;
 * gating each would be seven authorities, D62). Providers emit their raw push
 * with `providerMotionEvent` (`ProviderMotion`). The other two allowed
 * emitters own other SOURCES: device-activity (`orchestrator-subscriptions.ts`)
 * and the runner's analyzer.
 *
 * Rule: outside the allowlist, no production file has a `createEvent(` or an
 * `.emit(` call whose call window names `EventCategory.MotionOnMotionChanged`
 * or `'motion.on-motion-changed'`. Comments are blanked by `walk-sources`.
 * Blind spot, stated: an event object built far from its `.emit(` and passed
 * by name is not seen — the provider specs and the bridge's pass-through spec
 * remain the proof.
 *
 * DEFERRED, by exact path (`MOTION_EMITTERS_DEFERRED`): an emitter that still
 * emits the event directly for a stated reason. It is reported in the OK line
 * and it is NOT an allowlist entry — remove it when the reason lapses.
 *
 * SECOND RULE — the camera's `motion` runtime SLICE (D696). The orchestrator
 * is its only writer, with the effective motion, through ONE module
 * (`camera-sensors/motion-slice-hub.ts`). No provider and not the runner writes it: outside the
 * allowlist, no production file calls `setCapSlice` / `setCapState` /
 * `patchCapState` on `motion` (by `motionCapability`, its `.name`, the string,
 * or `capName: 'motion'`), nor assigns through `this.state.motion.<field>`.
 * A SENSOR device writes its own `motion` slice (that is its fact, not a
 * camera's): each such file is a named exemption with a reason, by exact path
 * (`MOTION_SLICE_SENSOR_WRITERS`). Also seen (review F6): a whole-object or
 * bracket state-proxy write (`state.motion =`, `state['motion'] =`), a cap
 * name held in a `const` of the same file (`const X = 'motion'` /
 * `= motionCapability.name`), and a shorthand `capName` inside a slice write —
 * the framework's two generic writers are exempt by exact path
 * (`MOTION_SLICE_GENERIC_WRITERS`). Blind spot, stated: a cap name that
 * arrives from ANOTHER file or a function argument and is passed positionally
 * (`setCapState(this.capName, …)`, the HA binary sensor; the composer's
 * generic `seed`) is not seen; both write sensors or composed devices, and the
 * provider specs remain the proof for the cameras.
 *
 * RELEASE AND ROLLBACK. Not restated here — it rots: the order follows the
 * `@camstack/server` closure (addon-pipeline, the orchestrator and the admin UI
 * move at the server step), and the windows, the floor, the preflight and the
 * rollback are in `docs/architecture/update-and-release.md` ("Release order for
 * a camera's motion path") and D696. What this guard enforces is only that no
 * file outside the exemptions emits the motion event or writes a camera's
 * `motion` slice.
 */
import * as path from 'node:path'
import { type SourceFile, walkSources } from './lib/walk-sources.ts'
import { callWindow } from './owner-only-events-guard.ts'

export type GuardFile = Pick<SourceFile, 'rel' | 'code'>

const REPO_ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')

export const MOTION_EMITTERS_ALLOWED: ReadonlySet<string> = new Set([
  'packages/addon-pipeline-orchestrator/src/orchestrator-bootstrap.ts',
  'packages/addon-pipeline-orchestrator/src/orchestrator-subscriptions.ts',
  'packages/addon-pipeline/src/pipeline-runner/index.ts',
])

/** Path to the reason it still emits `MotionOnMotionChanged` directly. */
export const MOTION_EMITTERS_DEFERRED: ReadonlyMap<string, string> = new Map([
  [
    'packages/system/src/builtins/camera-grid/grid-activity.ts',
    'ships inside @camstack/server (@camstack/system), which cannot assume an orchestrator at the D673 floor (the closure re-aligns it only when strictly newer); split once the minimum orchestrator carries the D673 ProviderMotion subscription',
  ],
])

const CATEGORY = /EventCategory\.MotionOnMotionChanged\b|['"]motion\.on-motion-changed['"]/
const CALLS: readonly RegExp[] = [/\bcreateEvent\s*\(/g, /\.emit\s*\(/g]

function isTest(rel: string): boolean {
  return rel.includes('/__tests__/') || /\.(spec|test)\.tsx?$/.test(rel)
}

function isGenerated(rel: string): boolean {
  return rel.includes('/generated/') || rel.includes('/dist/') || rel.includes('/assets/')
}

export function collectOnboardMotionFiles(): readonly GuardFile[] {
  return walkSources(REPO_ROOT, ['packages', 'server'])
}

/** 1-based line of the first `MotionOnMotionChanged` emit in the file, or null. */
function firstEmitLine(code: string): number | null {
  let first: number | null = null
  for (const call of CALLS) {
    for (const m of code.matchAll(call)) {
      const open = (m.index ?? 0) + m[0].length - 1
      if (!CATEGORY.test(callWindow(code, open))) continue
      if (first === null || open < first) first = open
      break
    }
  }
  return first === null ? null : code.slice(0, first).split('\n').length
}

export function checkOnboardMotionEmitterFacts(files: readonly GuardFile[]): readonly string[] {
  const failures: string[] = []
  for (const f of files) {
    if (isTest(f.rel) || isGenerated(f.rel)) continue
    if (MOTION_EMITTERS_ALLOWED.has(f.rel) || MOTION_EMITTERS_DEFERRED.has(f.rel)) continue
    const line = firstEmitLine(f.code)
    if (line === null) continue
    failures.push(
      `${f.rel}:${line}: emits MotionOnMotionChanged — a camera provider emits its raw push with providerMotionEvent (ProviderMotion); only the camera-sensors bridge, the device-activity source and the runner's analyzer emit the motion event (D673)`,
    )
  }
  return failures
}

/**
 * An exemption that no longer applies is reported, never kept: a deferral for a
 * file that was split or deleted reads as "still needed" and an allowlist entry
 * that stopped emitting waves through whatever is added there next. Judged over
 * the WHOLE tree, so it is a separate check from the per-file one.
 */
export function checkStaleExemptionFacts(
  files: readonly GuardFile[],
  allowed: ReadonlySet<string> = MOTION_EMITTERS_ALLOWED,
  deferred: ReadonlyMap<string, string> = MOTION_EMITTERS_DEFERRED,
): readonly string[] {
  const byRel = new Map(files.map((f) => [f.rel, f]))
  const failures: string[] = []
  const judge = (rel: string, kind: string): void => {
    const f = byRel.get(rel)
    if (f === undefined) {
      failures.push(
        `${rel}: stale ${kind} exemption — the file no longer exists; remove it from the guard`,
      )
    } else if (firstEmitLine(f.code) === null) {
      failures.push(
        `${rel}: stale ${kind} exemption — the file no longer emits MotionOnMotionChanged; remove it from the guard`,
      )
    }
  }
  for (const rel of allowed) judge(rel, 'allowlist')
  for (const rel of deferred.keys()) judge(rel, 'deferred')
  return failures
}

// ── The camera `motion` slice (D696) ────────────────────────────────────────

/** The only writer of a camera's `motion` slice: the orchestrator. */
export const MOTION_SLICE_WRITERS_ALLOWED: ReadonlySet<string> = new Set([
  'packages/addon-pipeline-orchestrator/src/camera-sensors/motion-slice-hub.ts',
])

/** A SENSOR device's own `motion` slice, by exact path, with the reason. */
export const MOTION_SLICE_SENSOR_WRITERS: ReadonlyMap<string, string> = new Map([
  [
    'packages/addon-provider-homematic/src/homematic-device.ts',
    'a Homematic motion detector is a SENSOR device; its own motion is its fact, written from the CCU push',
  ],
  [
    'packages/addon-provider-homematic/src/devices/hm-sensor-device.ts',
    'a Homematic sensor device; its own motion is its fact, written from the CCU push',
  ],
  [
    'packages/addon-matter-broker/src/devices/matter-endpoint-device.ts',
    'a Matter occupancy endpoint is a SENSOR device; its own motion is its fact',
  ],
  [
    'packages/addon-import-alexa/src/devices/alexa-device.ts',
    'an Alexa-imported motion sensor is a SENSOR device; its own motion is its fact',
  ],
])

/**
 * The framework's GENERIC slice-write paths: they write whatever cap their
 * caller names (a shorthand `capName`). A provider's motion write THROUGH them
 * is caught at the provider's own call site (`setCapSlice(motionCapability, …)`),
 * so they are exempt by exact path, with the reason, and refused when stale.
 */
export const MOTION_SLICE_GENERIC_WRITERS: ReadonlyMap<string, string> = new Map([
  [
    'packages/types/src/device/base-device.ts',
    'BaseDevice runtime state: the generic write behind every provider setCapSlice; the provider call site names the cap',
  ],
  [
    'packages/types/src/device/device-state-handle.ts',
    'the generic device-state handle: writes whatever cap its caller names; the caller names the cap',
  ],
])

const SLICE_CALLS: readonly RegExp[] = [
  /\b(?:setCapSlice(?:\s*\.\s*mutate)?|setCapState|patchCapState)\s*\(/g,
]
/** What names the motion cap: the string, `motionCapability` or its `.name`. */
const MOTION_NAME = String.raw`(?:motionCapability(?:\.name)?\b|['"]motion['"])`
/**
 * The state-proxy writes: `this.state.motion.x =`, `this.state.motion =`, and
 * the bracket forms `state['motion'] =` / `state["motion"].x =`.
 */
const STATE_PROXY_WRITE =
  /\.state(?:\.motion|\s*\[\s*['"]motion['"]\s*\])(?:\??\.\w+|\s*\[[^\]]+\])?\s*=(?!=)/g
/** A constant that names the motion cap: `const X = 'motion'` / `= motionCapability.name`. */
const MOTION_CONSTANT =
  /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:motionCapability\.name\b|['"]motion['"])/g
/** A shorthand `capName` property inside a slice write's object: the cap is whatever a variable holds. */
const SHORTHAND_CAP_NAME = /[{,]\s*capName\s*[,}]/

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The names that mean "motion" in this file: the literal forms, plus its motion constants. */
function motionNames(code: string): string {
  const constants = [...code.matchAll(MOTION_CONSTANT)].map((m) => escapeRegex(m[1] ?? ''))
  return constants.length === 0
    ? MOTION_NAME
    : `(?:${MOTION_NAME}|\\b(?:${constants.join('|')})\\b)`
}

/** 1-based line of the first `motion` slice write in the file, or null. */
export function firstMotionSliceWriteLine(code: string): number | null {
  const names = motionNames(code)
  const firstArg = new RegExp(String.raw`^\(\s*` + names)
  const capNameProp = new RegExp(String.raw`\bcapName\s*:\s*` + names)
  let first: number | null = null
  for (const call of SLICE_CALLS) {
    for (const m of code.matchAll(call)) {
      const open = (m.index ?? 0) + m[0].length - 1
      const window = callWindow(code, open)
      const motion =
        firstArg.test(window) || capNameProp.test(window) || SHORTHAND_CAP_NAME.test(window)
      if (!motion) continue
      if (first === null || open < first) first = open
      break
    }
  }
  for (const m of code.matchAll(STATE_PROXY_WRITE)) {
    const at = m.index ?? 0
    if (first === null || at < first) first = at
    break
  }
  return first === null ? null : code.slice(0, first).split('\n').length
}

export function checkMotionSliceWriterFacts(files: readonly GuardFile[]): readonly string[] {
  const failures: string[] = []
  for (const f of files) {
    if (isTest(f.rel) || isGenerated(f.rel)) continue
    if (
      MOTION_SLICE_WRITERS_ALLOWED.has(f.rel) ||
      MOTION_SLICE_SENSOR_WRITERS.has(f.rel) ||
      MOTION_SLICE_GENERIC_WRITERS.has(f.rel)
    ) {
      continue
    }
    const line = firstMotionSliceWriteLine(f.code)
    if (line === null) continue
    failures.push(
      `${f.rel}:${line}: writes a \`motion\` runtime slice — a camera's motion slice is written only by the orchestrator, with the effective motion; a provider or the runner never writes it (D696). A SENSOR device's own motion slice is a named exemption in MOTION_SLICE_SENSOR_WRITERS`,
    )
  }
  return failures
}

/** A slice exemption whose file is gone, or no longer writes the slice, is reported (as the emitter rule). */
export function checkStaleSliceExemptionFacts(
  files: readonly GuardFile[],
  allowed: ReadonlySet<string> = MOTION_SLICE_WRITERS_ALLOWED,
  sensors: ReadonlyMap<string, string> = MOTION_SLICE_SENSOR_WRITERS,
  generic: ReadonlyMap<string, string> = MOTION_SLICE_GENERIC_WRITERS,
): readonly string[] {
  const byRel = new Map(files.map((f) => [f.rel, f]))
  const failures: string[] = []
  const judge = (rel: string, kind: string): void => {
    const f = byRel.get(rel)
    if (f === undefined) {
      failures.push(
        `${rel}: stale ${kind} exemption — the file no longer exists; remove it from the guard`,
      )
    } else if (firstMotionSliceWriteLine(f.code) === null) {
      failures.push(
        `${rel}: stale ${kind} exemption — the file no longer writes a motion slice; remove it from the guard`,
      )
    }
  }
  for (const rel of allowed) judge(rel, 'slice-writer')
  for (const rel of sensors.keys()) judge(rel, 'sensor slice-writer')
  for (const rel of generic.keys()) judge(rel, 'generic slice-writer')
  return failures
}

// ── A camera provider's `motion` READS (D696) ───────────────────────────────

/** The one module that may call `readHubMotionDetected` / `readHubMotionStatus` directly. */
export const HUB_MOTION_READ_MODULE = 'packages/types/src/device/hub-motion-read.ts'

const HUB_MOTION_READ_CALL = /\breadHubMotion(?:Detected|Status)\s*\(/

/**
 * THIRD RULE — a camera provider whose slice the orchestrator writes serves
 * BOTH `motion` reads from the hub, built by `hubMotionNativeProvider`. Calling
 * a hub read directly from a provider is how every camera came to serve only
 * `isDetected`: `registerNativeCap` then installed the framework's default
 * `getStatus`, which reads the provider's LOCAL runtime state — empty under
 * D696 — and `motion.getStatus` answered `null` for every camera on the fleet
 * while the hub held its slice (2026-10-06, the viewer's Motion order).
 */
export function checkHubMotionReadFacts(files: readonly GuardFile[]): readonly string[] {
  const failures: string[] = []
  for (const f of files) {
    if (isTest(f.rel) || isGenerated(f.rel) || f.rel === HUB_MOTION_READ_MODULE) continue
    const m = HUB_MOTION_READ_CALL.exec(f.code)
    if (m === null) continue
    const line = f.code.slice(0, m.index).split('\n').length
    failures.push(
      `${f.rel}:${line}: calls a hub motion read directly — register the camera's native \`motion\` cap with \`hubMotionNativeProvider\`, which serves \`isDetected\` AND \`getStatus\` from the hub; a provider without its own \`getStatus\` answers the framework default, its empty local state, \`null\` (D696)`,
    )
  }
  return failures
}
