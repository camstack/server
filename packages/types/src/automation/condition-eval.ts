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

import { evaluateExpressionSource, toExpressionValue } from '../expression/expression-source.js'
import type { AutomationCondition, AutomationConditionOperator } from './recipe.js'
import type { AutomationConditionTraceNode, TraceValue } from './trace.js'

// ── The mirror ────────────────────────────────────────────────────────────

/** One device cap whose slice the mirror must hold. */
export type MirrorSource =
  | { readonly kind: 'device'; readonly deviceId: number; readonly cap: string }
  | { readonly kind: 'stable'; readonly stableId: string; readonly cap: string }

function collectInto(cond: AutomationCondition, out: MirrorSource[]): void {
  switch (cond.kind) {
    case 'all':
    case 'any':
      for (const child of cond.children) collectInto(child, out)
      return
    case 'not':
      collectInto(cond.child, out)
      return
    case 'condition':
      out.push({ kind: 'device', deviceId: cond.deviceId, cap: cond.cap })
      return
    case 'expression':
      for (const binding of Object.values(cond.bindings)) {
        if (binding.kind === 'global') {
          out.push({ kind: 'stable', stableId: binding.sourceStableId, cap: binding.cap })
        }
      }
      return
  }
}

/** Every (device, cap) a tree reads, deduplicated. */
export function collectMirrorSources(cond: AutomationCondition | undefined): MirrorSource[] {
  if (cond === undefined) return []
  const all: MirrorSource[] = []
  collectInto(cond, all)
  const seen = new Set<string>()
  return all.filter((s) => {
    const key = s.kind === 'device' ? `d|${s.deviceId}|${s.cap}` : `s|${s.stableId}|${s.cap}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export interface ConditionReader {
  /** `undefined` = unknown. */
  read(deviceId: number, cap: string, fieldPath: string): unknown
  readStable(stableId: string, cap: string, fieldPath: string): unknown
}

export interface MirrorRefreshReport {
  readonly updated: number
  /** Sources whose read failed or answered nothing — their old value stays. */
  readonly kept: number
}

export interface MirrorRefreshFetchers {
  readonly fetchSlice: (deviceId: number, cap: string) => Promise<unknown>
  /** stableId → device id. A rejection leaves the previous map. */
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
      if (s.kind === 'stable' && s.cap === cap && this.stableIds.get(s.stableId) === deviceId) {
        return true
      }
    }
    return false
  }

  read(deviceId: number, cap: string, fieldPath: string): unknown {
    const slice = this.slices.get(sliceKey(deviceId, cap))
    return slice === undefined ? undefined : pick(slice, fieldPath)
  }

  readStable(stableId: string, cap: string, fieldPath: string): unknown {
    const deviceId = this.stableIds.get(stableId)
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
      const deviceId = s.kind === 'device' ? s.deviceId : this.stableIds.get(s.stableId)
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

function compare(
  actual: unknown,
  operator: AutomationConditionOperator,
  expected: unknown,
): boolean {
  switch (operator) {
    case 'eq':
      return actual === expected
    case 'ne':
      return actual !== expected
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected
    case 'contains':
      return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected)
    case 'in':
      return Array.isArray(expected) && expected.some((v) => v === actual)
  }
}

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
  /** Pre-order: a container, then its children. */
  readonly nodes: readonly AutomationConditionTraceNode[]
}

function markSkipped(
  cond: AutomationCondition,
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

function evalNode(
  cond: AutomationCondition,
  path: string,
  reader: ConditionReader,
  now: number,
  out: AutomationConditionTraceNode[],
): boolean {
  switch (cond.kind) {
    case 'condition': {
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
      if (observed === undefined) {
        out.push({ ...base, outcome: 'fail', reason: `${cond.fieldPath} value unknown → fail` })
        return false
      }
      const ok = compare(observed, cond.operator, cond.value)
      out.push({
        ...base,
        outcome: ok ? 'pass' : 'fail',
        reason: `${cond.fieldPath} ${show(observed)}, expected ${OPERATOR_SYMBOL[cond.operator]} ${show(cond.value)} → ${ok ? 'pass' : 'fail'}`,
      })
      return ok
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
            ? reader.readStable(binding.sourceStableId, binding.cap, binding.fieldPath)
            : undefined
        if (raw === undefined) {
          out.push({
            path,
            kind: cond.kind,
            outcome: 'fail',
            reason: `${alias} value unknown → fail`,
          })
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
      const ok = result.value === true
      out.push({
        path,
        kind: cond.kind,
        outcome: ok ? 'pass' : 'fail',
        reason: `${cond.expr} with ${JSON.stringify(values)} → ${ok ? 'pass' : 'fail'}`,
      })
      return ok
    }
    case 'not': {
      const at = out.length
      out.push({ path, kind: 'not', outcome: 'not-evaluated', reason: '' })
      const inner = evalNode(cond.child, `${path}.0`, reader, now, out)
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
        const ok = evalNode(child, `${path}.${i}`, reader, now, out)
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

/** No condition tree is a pass with no nodes. */
export function evaluateConditionTree(
  cond: AutomationCondition | undefined,
  reader: ConditionReader,
  now: number,
): ConditionEvaluation {
  if (cond === undefined) return { pass: true, nodes: [] }
  const nodes: AutomationConditionTraceNode[] = []
  const pass = evalNode(cond, 'conditions', reader, now, nodes)
  return { pass, nodes }
}
