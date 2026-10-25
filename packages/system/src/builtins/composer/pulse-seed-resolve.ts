/**
 * Gather a pulse override's start seed (D938). The stored expression is not
 * changed. A failed read holds the field: no seed, and a claimed stamp is
 * not cleared (D49).
 */
import {
  type CapabilityLookup,
  type ClaimsListing,
  type CompositionFieldPlan,
  type CompositionSourceRef,
  errMsg,
  expressionContainsBuiltinCall,
  type IScopedLogger,
} from '@camstack/types'
import { capSeriesKey } from '../device-history/capture/capture-engine.js'
import { DEFAULT_RETENTION } from '../device-history/retention/retention.js'
import { DAY_MS } from '../device-history/time/bucket-time.js'
import type { ExistingTargetSeedRead } from './existing-target.js'
import { fieldKey } from './field-record.js'
import {
  decidePulseSeed,
  mergePulseDecisions,
  type OwnedPulse,
  type PulseFieldSeed,
  type PulseHistoryPoint,
  type PulseHistoryRead,
  type PulseSourceLevel,
  type PulseStampDecision,
} from './pulse-seed.js'
import type { SourceResolution } from './source-readings.js'

export type { PulseFieldSeed } from './pulse-seed.js'

export interface PulseHistorySeries {
  readonly beforeOn: boolean | null
  readonly points: readonly PulseHistoryPoint[]
}

export type PulseHistoryAnswer =
  | { readonly kind: 'unread'; readonly error: string }
  | { readonly kind: 'series'; readonly series: PulseHistorySeries }

export type ReadPulseHistory = (
  deviceId: number,
  cap: string,
  fieldPath: string,
  fromMs: number,
  toMs: number,
) => Promise<PulseHistoryAnswer>

export interface PulseClaimListing {
  listClaims(input: { readonly ownerPrefix?: string }): Promise<ClaimsListing>
}

export interface PulseSourceLookup {
  resolve(ref: CompositionSourceRef, reset: boolean): Promise<SourceResolution>
}

export interface ResolvePulseSeedsInput {
  readonly blockId: string
  readonly deviceId: number
  readonly fields: readonly CompositionFieldPlan[]
  readonly targetSeed: ExistingTargetSeedRead
  readonly lookupCap: CapabilityLookup
  readonly claims: PulseClaimListing
  readonly sources: PulseSourceLookup
  readonly readCap: (
    deviceId: number,
    capName: string,
  ) => Promise<Readonly<Record<string, unknown>> | null>
  readonly readPulseHistory: ReadPulseHistory
  readonly now: () => number
  readonly logger: IScopedLogger
}

interface RosePair {
  readonly source: CompositionSourceRef
  readonly cap: string
  readonly activeField: string
  readonly changedAtField: string
}

const ROSE_CALL = String.raw`rose\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)`

export function historySeriesKey(cap: string, fieldPath: string): string {
  return capSeriesKey(cap, fieldPath)
}

export async function resolvePulseSeeds(
  input: ResolvePulseSeedsInput,
): Promise<ReadonlyMap<string, PulseFieldSeed>> {
  try {
    return await resolveNow(input)
  } catch (err: unknown) {
    input.logger.warn(
      'pulse override seed held — gathering the source facts threw, so nothing is seeded and nothing is cleared',
      {
        tags: { deviceId: input.deviceId },
        meta: { blockId: input.blockId, error: errMsg(err) },
      },
    )
    return new Map()
  }
}

async function resolveNow(
  input: ResolvePulseSeedsInput,
): Promise<ReadonlyMap<string, PulseFieldSeed>> {
  const roses = input.fields.filter(isPulseTimestamp)
  if (roses.length === 0) return new Map()
  const listing = await readClaims(input)
  if (listing === null) return new Map()
  const seeds = new Map<string, PulseFieldSeed>()
  for (const field of roses) {
    const decision = await decideField(input, field, listing)
    logDecision(input, field, decision)
    for (const [key, seed] of seedsFor(input.fields, field, decision)) seeds.set(key, seed)
  }
  return seeds
}

function isPulseTimestamp(field: CompositionFieldPlan): boolean {
  return (
    field.source.kind === 'expression' && expressionContainsBuiltinCall(field.source.expr, 'rose')
  )
}

async function readClaims(input: ResolvePulseSeedsInput): Promise<ClaimsListing | null> {
  try {
    const listing = await input.claims.listClaims({ ownerPrefix: input.blockId })
    if (listing.state === 'loaded') return listing
    input.logger.warn(
      'pulse override seed held — the claims index has not loaded, so nothing is seeded and nothing is cleared',
      {
        tags: { deviceId: input.deviceId },
        meta: { blockId: input.blockId, reason: listing.reason },
      },
    )
    return null
  } catch (err: unknown) {
    input.logger.warn(
      'pulse override seed held — the claims index could not be read, so nothing is seeded and nothing is cleared',
      {
        tags: { deviceId: input.deviceId },
        meta: { blockId: input.blockId, error: errMsg(err) },
      },
    )
    return null
  }
}

async function decideField(
  input: ResolvePulseSeedsInput,
  field: CompositionFieldPlan,
  listing: ClaimsListing,
): Promise<PulseStampDecision> {
  if (listing.state !== 'loaded') return { kind: 'hold', reason: 'claims-unread' }
  const claim = listing.claims.find(
    (row) =>
      row.owner === input.blockId && row.deviceId === input.deviceId && row.capName === field.cap,
  )
  const slice = input.targetSeed.byCap.get(field.cap) ?? null
  const counter = counterField(input.fields, field)
  const owned = ownedOf(claim, slice, field.path, counter?.path ?? null)
  const nativeStamp = stampOf(slice, field.path)
  const pairs = rosePairs(field)
  if (pairs.length === 0) return { kind: 'keep' }
  const decisions: PulseStampDecision[] = []
  for (const pair of pairs) decisions.push(await decidePair(input, pair, owned, nativeStamp))
  return mergePulseDecisions(decisions)
}

async function decidePair(
  input: ResolvePulseSeedsInput,
  pair: RosePair,
  owned: OwnedPulse,
  nativeStamp: number | null,
): Promise<PulseStampDecision> {
  const resolution = await input.sources.resolve(pair.source, false)
  if (resolution.kind === 'missing') return { kind: 'keep' }
  if (resolution.kind !== 'found') {
    return decidePulseSeed({
      owned,
      nativeStamp,
      history: { kind: 'unread' },
      level: { kind: 'unread' },
    })
  }
  const history = await historyOf(input, resolution.deviceId, pair)
  const level = await levelOf(input, resolution.deviceId, pair)
  return decidePulseSeed({ owned, nativeStamp, history, level })
}

async function historyOf(
  input: ResolvePulseSeedsInput,
  deviceId: number,
  pair: RosePair,
): Promise<PulseHistoryRead> {
  if (!recordsField(input.lookupCap, pair.cap, pair.activeField)) return { kind: 'absent' }
  const now = input.now()
  const fromMs = now - DEFAULT_RETENTION.rawDays * DAY_MS
  try {
    const answer = await input.readPulseHistory(deviceId, pair.cap, pair.activeField, fromMs, now)
    if (answer.kind === 'unread') return { kind: 'unread' }
    return { kind: 'series', beforeOn: answer.series.beforeOn, points: answer.series.points }
  } catch (err: unknown) {
    input.logger.warn('pulse override history read threw — treated as unread', {
      tags: { deviceId: input.deviceId },
      meta: {
        blockId: input.blockId,
        sourceDeviceId: deviceId,
        cap: pair.cap,
        field: pair.activeField,
        error: errMsg(err),
      },
    })
    return { kind: 'unread' }
  }
}

async function levelOf(
  input: ResolvePulseSeedsInput,
  deviceId: number,
  pair: RosePair,
): Promise<PulseSourceLevel> {
  try {
    const slice = await input.readCap(deviceId, pair.cap)
    return levelFromSlice(slice, pair)
  } catch (err: unknown) {
    input.logger.warn('pulse override source slice could not be read — treated as unread', {
      tags: { deviceId: input.deviceId },
      meta: {
        blockId: input.blockId,
        sourceDeviceId: deviceId,
        cap: pair.cap,
        error: errMsg(err),
      },
    })
    return { kind: 'unread' }
  }
}

function levelFromSlice(
  slice: Readonly<Record<string, unknown>> | null,
  pair: RosePair,
): PulseSourceLevel {
  if (slice === null) return { kind: 'off', changedAt: null }
  const active = slice[pair.activeField]
  if (typeof active !== 'boolean') return { kind: 'unread' }
  const changed = slice[pair.changedAtField]
  const changedAt = typeof changed === 'number' && Number.isFinite(changed) ? changed : null
  return active ? { kind: 'on', changedAt } : { kind: 'off', changedAt }
}

function recordsField(lookup: CapabilityLookup, cap: string, fieldPath: string): boolean {
  const history = lookup(cap)?.history
  if (history === undefined || history === 'none') return false
  return Object.hasOwn(history.fields, fieldPath)
}

function ownedOf(
  claim: { readonly fields: readonly string[] } | undefined,
  slice: Readonly<Record<string, unknown>> | null,
  timestampPath: string,
  counterPath: string | null,
): OwnedPulse {
  if (claim === undefined || slice === null || !claim.fields.includes(timestampPath)) {
    return { kind: 'none' }
  }
  const at = slice[timestampPath]
  if (at === null) return { kind: 'never' }
  if (typeof at !== 'number' || !Number.isFinite(at)) return { kind: 'none' }
  const rawCount = counterPath === null ? undefined : slice[counterPath]
  const count =
    typeof rawCount === 'number' && Number.isFinite(rawCount) && rawCount >= 0 ? rawCount : 0
  return { kind: 'stamp', at, count }
}

function stampOf(slice: Readonly<Record<string, unknown>> | null, path: string): number | null {
  const at = slice?.[path]
  return typeof at === 'number' && Number.isFinite(at) ? at : null
}

function counterField(
  fields: readonly CompositionFieldPlan[],
  timestamp: CompositionFieldPlan,
): CompositionFieldPlan | undefined {
  return fields.find((field) => {
    if (field.cap !== timestamp.cap || field.path === timestamp.path) return false
    return field.source.kind === 'expression' && field.source.expr === `count(${timestamp.path})`
  })
}

function rosePairs(field: CompositionFieldPlan): readonly RosePair[] {
  if (field.source.kind !== 'expression') return []
  const found: RosePair[] = []
  for (const match of field.source.expr.matchAll(new RegExp(ROSE_CALL, 'g'))) {
    const pair = rosePair(field, match[1], match[2])
    if (pair !== null) found.push(pair)
  }
  return found
}

function rosePair(
  field: CompositionFieldPlan,
  activeName: string | undefined,
  changedName: string | undefined,
): RosePair | null {
  if (field.source.kind !== 'expression') return null
  if (activeName === undefined || changedName === undefined) return null
  const active = field.source.bindings[activeName]
  const changed = field.source.bindings[changedName]
  if (active === undefined || changed === undefined) return null
  if (active.kind !== 'from' || changed.kind !== 'from') return null
  if (active.cap !== changed.cap) return null
  if (active.source.addonId !== changed.source.addonId) return null
  if (active.source.stableId !== changed.source.stableId) return null
  return {
    source: active.source,
    cap: active.cap,
    activeField: active.fieldPath,
    changedAtField: changed.fieldPath,
  }
}

function seedsFor(
  fields: readonly CompositionFieldPlan[],
  timestamp: CompositionFieldPlan,
  decision: PulseStampDecision,
): ReadonlyMap<string, PulseFieldSeed> {
  const seeds = new Map<string, PulseFieldSeed>()
  if (decision.kind === 'keep') return seeds
  const counter = counterField(fields, timestamp)
  if (decision.kind === 'hold') {
    seeds.set(fieldKey(timestamp), { kind: 'hold' })
    if (counter !== undefined) seeds.set(fieldKey(counter), { kind: 'value', value: 0 })
    return seeds
  }
  if (decision.kind === 'none') {
    seeds.set(fieldKey(timestamp), { kind: 'value', value: null })
    if (counter !== undefined) seeds.set(fieldKey(counter), { kind: 'value', value: 0 })
    return seeds
  }
  seeds.set(fieldKey(timestamp), { kind: 'value', value: decision.at })
  if (counter !== undefined) seeds.set(fieldKey(counter), { kind: 'value', value: decision.count })
  return seeds
}

export interface PulseHistoryQueryPoint {
  readonly t: number
  readonly last: number | null
}

export interface PulseHistoryQueryBefore {
  readonly value: number | null
}

export interface PulseHistoryQuerySeries {
  readonly scope: string
  readonly before: PulseHistoryQueryBefore | null
  readonly points: readonly PulseHistoryQueryPoint[]
}

/** Raw boolean points of the device-level series (`scope` empty). 1 is on. */
export function pulseHistoryFromQuery(
  series: readonly PulseHistoryQuerySeries[],
): PulseHistorySeries {
  const row = series.find((item) => item.scope === '')
  if (row === undefined) return { beforeOn: null, points: [] }
  const beforeOn = levelBit(row.before?.value ?? null)
  const points = row.points.flatMap((point) => {
    const on = levelBit(point.last)
    return on === null ? [] : [{ t: point.t, on }]
  })
  return { beforeOn, points }
}

function levelBit(value: number | null): boolean | null {
  if (value === 1) return true
  if (value === 0) return false
  return null
}

function logDecision(
  input: ResolvePulseSeedsInput,
  field: CompositionFieldPlan,
  decision: PulseStampDecision,
): void {
  const meta = { blockId: input.blockId, cap: field.cap, field: field.path }
  if (decision.kind === 'stamp') {
    input.logger.info('pulse override seeded lastPressedAt from its source', {
      tags: { deviceId: input.deviceId },
      meta: { ...meta, at: decision.at, via: decision.via, count: decision.count },
    })
    return
  }
  if (decision.kind === 'none') {
    input.logger.info(
      'pulse override seeded no ring — the source proved none, so the native stamp is not used',
      { tags: { deviceId: input.deviceId }, meta },
    )
    return
  }
  if (decision.kind === 'hold') {
    input.logger.warn(
      'pulse override seed held — a source read failed, so nothing is seeded and nothing is cleared',
      { tags: { deviceId: input.deviceId }, meta: { ...meta, reason: decision.reason } },
    )
  }
}
