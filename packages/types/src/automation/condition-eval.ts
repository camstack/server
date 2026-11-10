/**
 * Evaluating an automation's condition tree against the ConditionMirror.
 *
 * D49: a trigger is a one-shot event, so its gate must never hang on a read
 * that can fail. Every field a condition leaf names is therefore kept in
 * memory — filled at start, updated off device state-changed events, reconciled
 * on a timer — and evaluation reads that memory ONLY. A value the mirror does
 * not hold is UNKNOWN, which is `fail` with a reason, never a throw and never a
 * `pass`. A failed refresh changes nothing: the previous value stays.
 *
 * The evaluator returns a node per tree position (containers, leaves, and the
 * ones a short-circuit never reached) with a stable path and a human reason, so
 * the editor can paint each block.
 */

import { isQuantityValue } from '../units/quantity-input.js'
import { evaluateExpressionSource, toExpressionValue } from '../expression/expression-source.js'
import { anySubjectMatches } from './detection-subject.js'
import {
  type HoldReading,
  type HoldSpec,
  type HoldTracker,
  compareValues,
  describeHoldMs,
} from './hold.js'
import { type LegacyCondition, convertLegacyCondition } from './legacy-recipe.js'
import {
  type AutomationConditionOperator,
  type AutomationEventLeaf,
  type AutomationWhen,
  type StationaryPresentLeaf,
  forEachLeaf,
  isEventLeaf,
} from './when.js'
import type { AutomationConditionTraceNode, TraceValue } from './trace.js'

// ── The mirror ────────────────────────────────────────────────────────────

/** One device cap whose slice the mirror must hold. */
export type MirrorSource =
  | { readonly kind: 'device'; readonly deviceId: number; readonly cap: string }
  | {
      readonly kind: 'stable'
      readonly stableId: string
      readonly cap: string
      /** The owning addon — a stableId alone is only unique per addon. */
      readonly addonId?: string
    }

/**
 * The key a `stableId → device id` map answers on. A pair (`addonId`, `stableId`)
 * is a device; a bare stableId is only a device while no other addon shares it,
 * so the map's producer puts the bare key in ONLY when it is unique.
 */
export function stableIdKey(stableId: string, addonId?: string): string {
  return addonId === undefined ? stableId : `${addonId}\u0000${stableId}`
}

export interface StableIdDevice {
  readonly id: number
  readonly stableId?: string
  readonly addonId?: string
}

/**
 * The `stableIdKey → device id` map a mirror refresh hands back, from a device
 * listing. Every device is reachable by its (addonId, stableId) pair; the bare
 * stableId is offered only while NO other device shares it, so a legacy binding
 * that names no addon reads nothing rather than the wrong device.
 */
export function stableIdMapOf(devices: readonly StableIdDevice[]): Map<string, number> {
  const out = new Map<string, number>()
  const bare = new Map<string, number | null>()
  for (const d of devices) {
    if (d.stableId === undefined) continue
    if (d.addonId !== undefined) out.set(stableIdKey(d.stableId, d.addonId), d.id)
    bare.set(d.stableId, bare.has(d.stableId) ? null : d.id)
  }
  for (const [stableId, id] of bare) {
    if (id !== null) out.set(stableId, id)
  }
  return out
}

/** The cap whose runtime-state slice IS the occupancy snapshot, parked objects included. */
const ZONE_ANALYTICS_CAP = 'zone-analytics'

function collectInto(cond: AutomationWhen, out: MirrorSource[]): void {
  switch (cond.kind) {
    case 'all':
    case 'any':
      for (const child of cond.children) collectInto(child, out)
      return
    case 'not':
      collectInto(cond.child, out)
      return
    case 'device-is':
      out.push({ kind: 'device', deviceId: cond.deviceId, cap: cond.cap })
      return
    case 'stationary-present':
      out.push({ kind: 'device', deviceId: cond.deviceId, cap: ZONE_ANALYTICS_CAP })
      return
    case 'expression':
      for (const binding of Object.values(cond.bindings)) {
        if (binding.kind === 'global') {
          out.push({
            kind: 'stable',
            stableId: binding.sourceStableId,
            cap: binding.cap,
            ...(binding.addonId !== undefined ? { addonId: binding.addonId } : {}),
          })
        }
      }
      return
    default:
      // an event leaf reads nothing off the mirror — it is not a state
      return
  }
}

/** Every (device, cap) a `when` tree's STATE leaves read, deduplicated. */
export function collectWhenMirrorSources(cond: AutomationWhen | undefined): MirrorSource[] {
  if (cond === undefined) return []
  const all: MirrorSource[] = []
  collectInto(cond, all)
  const seen = new Set<string>()
  return all.filter((s) => {
    const key =
      s.kind === 'device'
        ? `d|${s.deviceId}|${s.cap}`
        : `s|${stableIdKey(s.stableId, s.addonId)}|${s.cap}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Legacy name, for blocks generated before the single tree: an old condition tree. */
export function collectMirrorSources(cond: LegacyCondition | undefined): MirrorSource[] {
  return collectWhenMirrorSources(cond === undefined ? undefined : convertLegacyCondition(cond))
}

export interface ConditionReader {
  /** `undefined` = unknown. */
  read(deviceId: number, cap: string, fieldPath: string): unknown
  readStable(stableId: string, cap: string, fieldPath: string, addonId?: string): unknown
}

export interface MirrorRefreshReport {
  readonly updated: number
  /** Sources whose read failed or answered nothing — their old value stays. */
  readonly kept: number
}

export interface MirrorRefreshFetchers {
  readonly fetchSlice: (deviceId: number, cap: string) => Promise<unknown>
  /** `stableIdKey(stableId, addonId)` → device id (the bare stableId only when unique). A
   *  rejection leaves the previous map. */
  readonly fetchStableIds: () => Promise<ReadonlyMap<string, number>>
}

function sliceKey(deviceId: number, cap: string): string {
  return `${deviceId}|${cap}`
}

function pick(slice: unknown, fieldPath: string): unknown {
  let cursor: unknown = slice
  for (const part of fieldPath.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = Reflect.get(cursor, part)
  }
  return cursor
}

function isSliceObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

export class ConditionMirror implements ConditionReader {
  private readonly slices = new Map<string, object>()
  private stableIds: ReadonlyMap<string, number> = new Map()
  private readonly watched: ReadonlySet<string>

  constructor(private readonly sources: readonly MirrorSource[]) {
    this.watched = new Set(
      sources.filter((s) => s.kind === 'device').map((s) => sliceKey(s.deviceId, s.cap)),
    )
  }

  /** A `device.state-changed` event. Slices nobody reads are ignored. */
  apply(deviceId: number, cap: string, slice: unknown): void {
    const key = sliceKey(deviceId, cap)
    if (!isSliceObject(slice)) return
    if (!this.watched.has(key) && !this.isStableTarget(deviceId, cap)) return
    this.slices.set(key, slice)
  }

  private isStableTarget(deviceId: number, cap: string): boolean {
    for (const s of this.sources) {
      if (
        s.kind === 'stable' &&
        s.cap === cap &&
        this.stableIds.get(stableIdKey(s.stableId, s.addonId)) === deviceId
      ) {
        return true
      }
    }
    return false
  }

  read(deviceId: number, cap: string, fieldPath: string): unknown {
    const slice = this.slices.get(sliceKey(deviceId, cap))
    return slice === undefined ? undefined : pick(slice, fieldPath)
  }

  /** The whole slice the mirror holds for a device cap — `undefined` when it holds none. */
  sliceOf(deviceId: number, cap: string): unknown {
    return this.slices.get(sliceKey(deviceId, cap))
  }

  readStable(stableId: string, cap: string, fieldPath: string, addonId?: string): unknown {
    const deviceId = this.stableIds.get(stableIdKey(stableId, addonId))
    return deviceId === undefined ? undefined : this.read(deviceId, cap, fieldPath)
  }

  /** Fill / reconcile. A read that fails or answers nothing keeps the old value. */
  async refresh(fetchers: MirrorRefreshFetchers): Promise<MirrorRefreshReport> {
    let updated = 0
    let kept = 0
    if (this.sources.some((s) => s.kind === 'stable')) {
      try {
        this.stableIds = await fetchers.fetchStableIds()
      } catch {
        // keep the previous map
      }
    }
    const targets = new Map<string, { deviceId: number; cap: string }>()
    for (const s of this.sources) {
      const deviceId =
        s.kind === 'device' ? s.deviceId : this.stableIds.get(stableIdKey(s.stableId, s.addonId))
      if (deviceId === undefined) {
        kept += 1
        continue
      }
      targets.set(sliceKey(deviceId, s.cap), { deviceId, cap: s.cap })
    }
    for (const [key, target] of targets) {
      try {
        const slice = await fetchers.fetchSlice(target.deviceId, target.cap)
        if (isSliceObject(slice)) {
          this.slices.set(key, slice)
          updated += 1
        } else {
          kept += 1
        }
      } catch {
        kept += 1
      }
    }
    return { updated, kept }
  }
}

// ── Evaluation ────────────────────────────────────────────────────────────

const OPERATOR_SYMBOL: Readonly<Record<AutomationConditionOperator, string>> = {
  eq: '=',
  ne: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  contains: 'contains',
  in: 'in',
}

const compare = compareValues

function toTraceValue(value: unknown): TraceValue {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number')) {
    return value
  }
  return JSON.stringify(value)
}

function show(value: unknown): string {
  return Array.isArray(value) ? `[${value.join(', ')}]` : String(value)
}

export interface ConditionEvaluation {
  readonly pass: boolean
  /** A state leaf could not be read (the mirror held nothing for it). A false
   *  that comes with this is "not known", and a `not` over it is not to be trusted. */
  readonly unknown: boolean
  /** Pre-order: a container, then its children. */
  readonly nodes: readonly AutomationConditionTraceNode[]
  /** The soonest a pending `for` completes (ms from now); absent when none is pending. */
  readonly holdDueInMs?: number
}

function markSkipped(
  cond: AutomationWhen,
  path: string,
  why: string,
  out: AutomationConditionTraceNode[],
): void {
  out.push({ path, kind: cond.kind, outcome: 'not-evaluated', reason: why })
  if (cond.kind === 'all' || cond.kind === 'any') {
    cond.children.forEach((c, i) => {
      markSkipped(c, `${path}.${i}`, why, out)
    })
  } else if (cond.kind === 'not') {
    markSkipped(cond.child, `${path}.0`, why, out)
  }
}

interface ParkedObjectRow {
  readonly id: string
  readonly className: string
}

function parkedObjectsOf(value: unknown): readonly ParkedObjectRow[] {
  if (!Array.isArray(value)) return []
  const rows: ParkedObjectRow[] = []
  for (const item of value) {
    const id = Reflect.get(Object(item), 'id')
    const className = Reflect.get(Object(item), 'className')
    if (typeof id === 'string' && typeof className === 'string') rows.push({ id, className })
  }
  return rows
}

/** `zoneId`s whose `trackIds` list the parked object (`stationary:<id>`, as the snapshot builds it). */
function zonesOfParked(zones: unknown, parkedId: string): readonly string[] {
  if (!Array.isArray(zones)) return []
  const out: string[] = []
  for (const zone of zones) {
    const zoneId = Reflect.get(Object(zone), 'zoneId')
    const trackIds = Reflect.get(Object(zone), 'trackIds')
    if (
      typeof zoneId === 'string' &&
      Array.isArray(trackIds) &&
      trackIds.includes(`stationary:${parkedId}`)
    ) {
      out.push(zoneId)
    }
  }
  return out
}

/**
 * Is a matching parked object there NOW? Read off the mirrored zone-analytics
 * snapshot: `frame` is always present in a snapshot, so its absence means the
 * slice was never read (UNKNOWN, a fail that says so), while a snapshot without
 * `stationaryObjects` is a definite "nothing parked" (the provider omits an
 * empty list).
 */
function judgeStationaryPresent(
  cond: StationaryPresentLeaf,
  reader: ConditionReader,
): { readonly pass: boolean; readonly why: string; readonly unknown?: true } {
  const frame = reader.read(cond.deviceId, ZONE_ANALYTICS_CAP, 'frame')
  if (frame === undefined) {
    return { pass: false, why: `device ${cond.deviceId} occupancy snapshot unknown`, unknown: true }
  }
  const parked = parkedObjectsOf(
    reader.read(cond.deviceId, ZONE_ANALYTICS_CAP, 'stationaryObjects'),
  )
  if (parked.length === 0) {
    return { pass: false, why: `no parked objects on device ${cond.deviceId}` }
  }
  const zones = reader.read(cond.deviceId, ZONE_ANALYTICS_CAP, 'zones')
  const matching: ParkedObjectRow[] = []
  for (const obj of parked) {
    if (
      cond.subjects !== undefined &&
      !anySubjectMatches(cond.subjects, { className: obj.className }).matches
    ) {
      continue
    }
    if (cond.zones !== undefined) {
      const inZones = zonesOfParked(zones, obj.id)
      if (!cond.zones.some((z) => inZones.includes(z))) continue
    }
    matching.push(obj)
  }
  const needed = cond.minCount ?? 1
  const first = matching[0]
  if (first !== undefined && matching.length >= needed) {
    return {
      pass: true,
      why:
        needed === 1
          ? `parked ${first.className} (${first.id}) on device ${cond.deviceId}`
          : `${matching.length} parked matching on device ${cond.deviceId} (need ${needed})`,
    }
  }
  if (matching.length > 0) {
    return {
      pass: false,
      why: `only ${matching.length} of ${needed} needed parked objects match on device ${cond.deviceId}`,
    }
  }
  return {
    pass: false,
    why: `${parked.length} parked on device ${cond.deviceId}, none matching the class/zone filter`,
  }
}

interface EvalState {
  /** The path of the event leaf that occurred; every other event leaf is false. */
  readonly firedPath: string | undefined
  /** Where a leaf's `for` keeps its clock; absent, a hold cannot be judged. */
  readonly holds: HoldTracker | undefined
  unknown: boolean
  /** The soonest a pending hold completes (ms from `now`), so the caller can arm a timer for it. */
  holdDueInMs: number | undefined
}

interface HoldVerdict {
  /** Pending only: ms until the window completes. */
  readonly due?: number
  readonly pass: boolean
  readonly unknown: boolean
  readonly why: string
}

function noteDue(state: EvalState, hold: HoldVerdict | undefined): void {
  if (hold?.due === undefined) return
  state.holdDueInMs =
    state.holdDueInMs === undefined ? hold.due : Math.min(state.holdDueInMs, hold.due)
}

/** What a state leaf's hold says, given whether the leaf's own condition is true NOW. */
function judgeHold(
  hold: HoldSpec,
  reading: HoldReading | undefined,
  conditionTrue: boolean,
): HoldVerdict {
  const window = `${hold.mode === 'stable' ? 'stable' : 'held'} for ${describeHoldMs(hold.ms)}`
  if (reading === undefined) {
    return { pass: false, unknown: true, why: `${window}: nothing keeps this leaf's history here` }
  }
  switch (reading.phase) {
    case 'met':
      return { pass: true, unknown: false, why: `${window}: met` }
    case 'pending':
      return {
        due: reading.remainingMs,
        pass: false,
        unknown: false,
        why: `${window}: ${describeHoldMs(hold.ms - reading.remainingMs)} so far`,
      }
    case 'inherited':
      return {
        pass: false,
        unknown: true,
        why: `${window}: it was already true when watching began, so how long it has held is not known`,
      }
    case 'idle':
      return {
        pass: false,
        unknown: false,
        why: conditionTrue ? `${window}: just changed` : `${window}: the condition is not true`,
      }
  }
}

function evalEventLeaf(
  cond: AutomationEventLeaf,
  path: string,
  state: EvalState,
  out: AutomationConditionTraceNode[],
): boolean {
  const occurred = state.firedPath === path
  out.push({
    path,
    kind: cond.kind,
    outcome: occurred ? 'pass' : 'fail',
    reason: occurred
      ? `${cond.kind} occurred → pass`
      : `${cond.kind} is an instant and did not occur now → fail`,
  })
  return occurred
}

function evalNode(
  cond: AutomationWhen,
  path: string,
  reader: ConditionReader,
  now: number,
  out: AutomationConditionTraceNode[],
  state: EvalState,
): boolean {
  if (isEventLeaf(cond)) return evalEventLeaf(cond, path, state, out)
  switch (cond.kind) {
    case 'device-is': {
      const observed = reader.read(cond.deviceId, cond.cap, cond.fieldPath)
      const base = {
        path,
        kind: cond.kind,
        deviceId: cond.deviceId,
        cap: cond.cap,
        fieldPath: cond.fieldPath,
        operator: cond.operator,
        expected: toTraceValue(cond.value),
        observed: toTraceValue(observed),
      } as const
      if (isQuantityValue(cond.value)) {
        out.push({
          ...base,
          outcome: 'fail',
          reason: `${cond.fieldPath} expected value's unit was never converted → fail`,
        })
        return false
      }
      if (observed === undefined) {
        state.unknown = true
        out.push({ ...base, outcome: 'fail', reason: `${cond.fieldPath} value unknown → fail` })
        return false
      }
      const compared = compare(observed, cond.operator, cond.value)
      const hold =
        cond.for === undefined
          ? undefined
          : judgeHold(
              cond.for,
              state.holds?.observe(path, cond.for, { holds: compared, value: observed }, now),
              compared,
            )
      if (hold?.unknown === true) state.unknown = true
      noteDue(state, hold)
      const ok = compared && (hold === undefined || hold.pass)
      out.push({
        ...base,
        outcome: ok ? 'pass' : 'fail',
        reason: `${cond.fieldPath} ${show(observed)}, expected ${OPERATOR_SYMBOL[cond.operator]} ${show(cond.value)}${hold === undefined ? '' : ` (${hold.why})`} → ${ok ? 'pass' : 'fail'}`,
      })
      return ok
    }
    case 'stationary-present': {
      const verdict = judgeStationaryPresent(cond, reader)
      if (verdict.unknown === true) state.unknown = true
      out.push({
        path,
        kind: cond.kind,
        outcome: verdict.pass ? 'pass' : 'fail',
        reason: `${verdict.why} → ${verdict.pass ? 'pass' : 'fail'}`,
        deviceId: cond.deviceId,
        cap: ZONE_ANALYTICS_CAP,
      })
      return verdict.pass
    }
    case 'expression': {
      const values: Record<string, string | number | boolean | null> = {}
      for (const [alias, binding] of Object.entries(cond.bindings)) {
        if (binding.kind === 'literal') {
          values[alias] = toExpressionValue(binding.value) ?? null
          continue
        }
        const raw =
          binding.kind === 'global'
            ? reader.readStable(
                binding.sourceStableId,
                binding.cap,
                binding.fieldPath,
                binding.addonId,
              )
            : undefined
        if (raw === undefined) {
          out.push({
            path,
            kind: cond.kind,
            outcome: 'fail',
            reason: `${alias} value unknown → fail`,
          })
          state.unknown = true
          return false
        }
        values[alias] = toExpressionValue(raw) ?? null
      }
      const result = evaluateExpressionSource(cond.expr, values, now)
      if (!result.ok) {
        out.push({
          path,
          kind: cond.kind,
          outcome: 'fail',
          reason: `${cond.expr}: ${result.error} → fail`,
        })
        return false
      }
      const truth = result.value === true
      const hold =
        cond.for === undefined
          ? undefined
          : judgeHold(
              cond.for,
              state.holds?.observe(path, cond.for, { holds: truth, value: truth }, now),
              truth,
            )
      if (hold?.unknown === true) state.unknown = true
      noteDue(state, hold)
      const ok = truth && (hold === undefined || hold.pass)
      out.push({
        path,
        kind: cond.kind,
        outcome: ok ? 'pass' : 'fail',
        reason: `${cond.expr} with ${JSON.stringify(values)}${hold === undefined ? '' : ` (${hold.why})`} → ${ok ? 'pass' : 'fail'}`,
      })
      return ok
    }
    case 'not': {
      const at = out.length
      out.push({ path, kind: 'not', outcome: 'not-evaluated', reason: '' })
      const inner = evalNode(cond.child, `${path}.0`, reader, now, out, state)
      const ok = !inner
      out.splice(at, 1, {
        path,
        kind: 'not',
        outcome: ok ? 'pass' : 'fail',
        reason: `not (${inner ? 'pass' : 'fail'}) → ${ok ? 'pass' : 'fail'}`,
      })
      return ok
    }
    case 'all':
    case 'any': {
      const isAll = cond.kind === 'all'
      const at = out.length
      out.push({ path, kind: cond.kind, outcome: 'not-evaluated', reason: '' })
      let decided: number | null = null
      for (let i = 0; i < cond.children.length; i += 1) {
        const child = cond.children[i]
        if (child === undefined) continue
        if (decided !== null) {
          markSkipped(child, `${path}.${i}`, `short-circuited by ${path}.${decided}`, out)
          continue
        }
        const ok = evalNode(child, `${path}.${i}`, reader, now, out, state)
        if (isAll ? !ok : ok) decided = i
      }
      const ok = isAll ? decided === null : decided !== null
      const reason = isAll
        ? ok
          ? `all ${cond.children.length} passed → pass`
          : `${path}.${decided} failed → fail`
        : ok
          ? `${path}.${decided} passed → pass`
          : `none of ${cond.children.length} passed → fail`
      out.splice(at, 1, { path, kind: cond.kind, outcome: ok ? 'pass' : 'fail', reason })
      return ok
    }
  }
}

/** Options of one evaluation of a `when` tree. */
export interface WhenEvaluationOptions {
  /** The path of the event leaf that occurred (`when.0`); absent for a state-only tree. */
  readonly firedPath?: string
  /** Keeps the clock of every `for` in the tree. Without it a hold cannot be judged (unknown). */
  readonly holds?: HoldTracker
  /** The root path (default `when`; the legacy wrapper keeps `conditions`). */
  readonly rootPath?: string
}

/** Evaluate a `when` tree: the fired event leaf is true, every other event leaf false. */
export function evaluateWhenTree(
  when: AutomationWhen,
  reader: ConditionReader,
  now: number,
  options: WhenEvaluationOptions = {},
): ConditionEvaluation {
  const nodes: AutomationConditionTraceNode[] = []
  const state: EvalState = {
    firedPath: options.firedPath,
    holds: options.holds,
    unknown: false,
    holdDueInMs: undefined,
  }
  const pass = evalNode(when, options.rootPath ?? 'when', reader, now, nodes, state)
  return {
    pass,
    unknown: state.unknown,
    nodes,
    ...(state.holdDueInMs === undefined ? {} : { holdDueInMs: state.holdDueInMs }),
  }
}

/** Does any state leaf of the tree carry a `for`? */
export function hasHoldLeaves(when: AutomationWhen): boolean {
  let found = false
  forEachLeaf(when, (leaf) => {
    if ((leaf.kind === 'device-is' || leaf.kind === 'expression') && leaf.for !== undefined) {
      found = true
    }
  })
  return found
}

/**
 * Feed the clock of EVERY `for` leaf, each on its own: a short-circuit in the
 * tree (an event leaf that is false right now) must not stop a hold from
 * counting. Returns the soonest a pending hold completes (ms), or undefined.
 */
export function observeHoldLeaves(
  when: AutomationWhen,
  reader: ConditionReader,
  now: number,
  holds: HoldTracker,
  rootPath = 'when',
): number | undefined {
  let due: number | undefined
  forEachLeaf(
    when,
    (leaf, path) => {
      if ((leaf.kind !== 'device-is' && leaf.kind !== 'expression') || leaf.for === undefined)
        return
      const state: EvalState = {
        firedPath: undefined,
        holds,
        unknown: false,
        holdDueInMs: undefined,
      }
      evalNode(leaf, path, reader, now, [], state)
      if (state.holdDueInMs !== undefined)
        due = due === undefined ? state.holdDueInMs : Math.min(due, state.holdDueInMs)
    },
    rootPath,
  )
  return due
}

/** Legacy name, for blocks generated before the single tree. No tree is a pass with no nodes. */
export function evaluateConditionTree(
  cond: LegacyCondition | undefined,
  reader: ConditionReader,
  now: number,
): ConditionEvaluation {
  if (cond === undefined) return { pass: true, unknown: false, nodes: [] }
  return evaluateWhenTree(convertLegacyCondition(cond), reader, now, { rootPath: 'conditions' })
}
