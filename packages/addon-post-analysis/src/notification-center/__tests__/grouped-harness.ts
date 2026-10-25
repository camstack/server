/**
 * The shared harness of the grouped-immediate specs (D692, Tasks 8–10, 13, 15).
 *
 * Boots the REAL `NotificationCenter` on a fake settings store, with:
 *  - a controllable recognition outlook (per track; default `face-unseen`, i.e. pending);
 *  - a RECORDING logger, so the specs assert the lines the operator will read;
 *  - a drain that never fires on its own (`drainIntervalMs` huge): `tick(at)` sets the clock
 *    and runs ONE drain through the public test seam, which also awaits the evaluation
 *    chain (fresh review L-6).
 *
 * Lifted from `track-grouping.spec.ts`, which D692 (T17) deleted along with the D143 burst.
 */

import type { InMemoryRecords } from '@camstack/types'
import { makeNcRecords, ncTable } from './support/nc-test-deps.js'
import type { IScopedLogger, NcRuleInput, ObjectEvent, Track } from '@camstack/types'
import { NcRuleInputSchema } from '@camstack/types'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcDispatcherDeps, NcSendInput, NcTargetRef } from '../dispatcher.js'
import type { NcRecognitionOutlook } from '../grouped/grouped-inputs.js'
import { NotificationCenter, type NotificationCenterDeps } from '../index.js'
import { type NcOutboxPayload } from '../outbox.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

export const CALLER = { userId: 'admin-42', isAdmin: true }
export const DEVICE = 104
export const T0 = 100_000

export interface LoggedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly msg: string
  readonly meta: Readonly<Record<string, unknown>>
  readonly tags: Readonly<Record<string, unknown>>
}

export interface LogRecorder {
  readonly logger: IScopedLogger
  readonly lines: LoggedLine[]
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object') return {}
  return Object.fromEntries(Object.entries(value))
}

export function makeLogRecorder(): LogRecorder {
  const lines: LoggedLine[] = []
  const at =
    (level: LoggedLine['level']) =>
    (msg: string, ctx?: { readonly meta?: unknown; readonly tags?: unknown }): void => {
      lines.push({ level, msg, meta: asRecord(ctx?.meta), tags: asRecord(ctx?.tags) })
    }
  const logger: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, lines }
}

export function rule(overrides: Record<string, unknown> = {}): NcRuleInput {
  return NcRuleInputSchema.parse({
    name: 'persone su uscio',
    delivery: 'immediate',
    targets: [{ targetId: 'tgt-1' }],
    conditions: { classes: ['person'] },
    throttle: { cooldownSec: 60, scope: 'rule-device' },
    groupingSec: 20,
    // Text-only: the mosaic has its own spec; a media policy would spend the dispatcher's
    // bounded still-wait on a media store this harness leaves empty.
    media: { attach: 'none' },
    ...overrides,
  })
}

let nextEventId = 1

export function event(overrides: Partial<ObjectEvent> = {}): ObjectEvent {
  nextEventId += 1
  return {
    id: nextEventId,
    kind: 'object',
    deviceId: DEVICE,
    timestamp: T0,
    trackId: 'trk-1',
    className: 'person',
    confidence: 0.9,
    zones: [],
    bbox: { x: 100, y: 50, w: 60, h: 140 },
    frameWidth: 640,
    frameHeight: 360,
    ...overrides,
  }
}

export function track(overrides: Partial<Track> = {}): Track {
  return {
    trackId: 'trk-1',
    deviceId: DEVICE,
    className: 'person',
    firstSeen: T0 - 10_000,
    lastSeen: T0,
    positions: [],
    snapshots: [],
    zonesVisited: [],
    totalDistance: 0.2,
    state: 'left',
    active: false,
    ...overrides,
  }
}

export interface Harness {
  readonly center: NotificationCenter
  readonly store: FakeSettingsStore
  readonly world: InMemoryRecords
  readonly sends: NcSendInput[]
  readonly lines: LoggedLine[]
  /** Per-track outlook the fake recogniser answers; absent ⇒ `face-unseen` (pending). */
  readonly outlooks: Map<string, NcRecognitionOutlook>
  /** Every `onTrigger` actuation, in order. */
  readonly actuations: { readonly deviceId: number; readonly method: string }[]
  setNow(at: number): void
  /** Set the clock, run ONE drain tick, await the evaluation chain. */
  tick(at: number): Promise<void>
  /** Await everything already appended to the evaluation chain. */
  settle(): Promise<void>
  linesOf(msg: string): LoggedLine[]
}

/** Options of {@link makeHarness}. */
export interface HarnessOptions {
  /** The target catalog (default: one unowned `tgt-1`). */
  readonly targets?: readonly NcTargetRef[]
  /** Replaces the catalog READ (a spec makes it reject to model an unreadable owner). */
  readonly listTargets?: () => Promise<readonly NcTargetRef[]>
  /** The records world another harness already wrote — a RESTART of the centre over it. */
  readonly world?: InMemoryRecords
  /** The clock at construction (default {@link T0}) — a restart boots later. */
  readonly startAt?: number
  /** The persisted object events the boot reconcile scans (default: none). */
  readonly listObjectEventsSince?: (
    sinceMs: number,
    limit: number,
  ) => Promise<readonly ObjectEvent[]>
  /** The alias store's durable read (default: absent — no fusion on this wiring). */
  readonly resolveTrackAlias?: (trackId: string) => Promise<string | null>
  /** The user fan-out reads (default: absent — a user-only rule resolves no target). */
  readonly listUsers?: NotificationCenterDeps['listUsers']
  readonly getDeviceRoute?: NotificationCenterDeps['getDeviceRoute']
  /** The persisted (closed) tracks read (default: none — every track reads as still open). */
  readonly listRecentTracks?: NotificationCenterDeps['listRecentTracks']
  /** A stand-in for the AI confirm gate (the centre builds a real one only with a vision LLM). */
  readonly confirmGate?: NcDispatcherDeps['confirmGate']
  /** The media store read (default: empty). */
  readonly getMediaForOwner?: NcDispatcherDeps['getMediaForOwner']
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const store = makeFakeSettingsStore()
  const world = options.world ?? makeNcRecords()
  const sends: NcSendInput[] = []
  const recording = makeLogRecorder()
  const outlooks = new Map<string, NcRecognitionOutlook>()
  const actuations: { deviceId: number; method: string }[] = []
  const targets: readonly NcTargetRef[] = options.targets ?? [
    { id: 'tgt-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
  ]
  let now = options.startAt ?? T0
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: recording.logger,
    pruneWindows: async () => ({
      outboxMs: null,
      timelapseExportMs: null,
      artifactShelfMs: null,
      summaryMosaicMs: null,
    }),
    dispatcher: {
      listTargets: options.listTargets ?? (async () => targets),
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: options.getMediaForOwner ?? (async () => []),
      getDeviceName: async () => 'Front door',
      ...(options.confirmGate !== undefined ? { confirmGate: options.confirmGate } : {}),
    },
    listObjectEventsSince: options.listObjectEventsSince ?? (async () => []),
    listRecentTracks: options.listRecentTracks ?? (async () => []),
    ...(options.resolveTrackAlias !== undefined
      ? { resolveTrackAlias: options.resolveTrackAlias }
      : {}),
    ...(options.listUsers !== undefined ? { listUsers: options.listUsers } : {}),
    ...(options.getDeviceRoute !== undefined ? { getDeviceRoute: options.getDeviceRoute } : {}),
    now: () => now,
    // Never fires on its own: `tick` drives the drain.
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
    // Like the real outlook: a recognition label is final; otherwise the per-track answer.
    recognitionOutlook: ({ trackId, labelKind }) =>
      labelKind !== undefined
        ? { final: true }
        : (outlooks.get(trackId) ?? { final: false, awaiting: 'face-unseen' }),
    actuate: async (input) => {
      actuations.push({ deviceId: input.deviceId, method: input.method })
    },
    isCapDeviceScoped: () => true,
  })
  return {
    center,
    store,
    world,
    sends,
    lines: recording.lines,
    outlooks,
    actuations,
    setNow(at) {
      now = at
    },
    async tick(at) {
      now = at
      await center.runDrainTickForTest()
    },
    async settle() {
      await center.runDrainTickForTest()
    },
    linesOf(msg) {
      return recording.lines.filter((l) => l.msg === msg)
    },
  }
}

export function outboxIds(world: InMemoryRecords): string[] {
  return [...(ncTable(world, 'outbox')?.keys() ?? [])]
}

export function payloads(world: InMemoryRecords): NcOutboxPayload[] {
  return [...(ncTable(world, 'outbox')?.values() ?? [])].map((row) => {
    const payload = row['payload']
    if (payload === null || typeof payload !== 'object') throw new Error('no payload')
    // Documented type boundary — payload JSON round-trips as `unknown` through the fake
    // store, the same narrowing the real `rowToEntry` performs.
    return payload as NcOutboxPayload
  })
}

export async function boot(h: Harness, input: NcRuleInput = rule()): Promise<string> {
  await h.center.start({ evaluation: true })
  await h.center.whenHydrated()
  const created = await h.center.buildProvider().createRule({ rule: input, caller: CALLER })
  return created.rule.id
}

/**
 * A RESTART over a store an earlier centre wrote (Task 10): start, then wait for the
 * back-fill — the hydration, the cooldown reseed and the reconcile replay. The rules come
 * from the store, so nothing is created.
 */
export async function restart(h: Harness): Promise<void> {
  await h.center.start({ evaluation: true })
  await h.center.whenHydrated()
}

/** The persisted boot watermark, or `undefined` when none was ever written. */
export function persistedWatermark(world: InMemoryRecords): number | undefined {
  const value = ncTable(world, 'meta').get('watermark')?.['value']
  if (value === null || typeof value !== 'object') return undefined
  const ts: unknown = Object.fromEntries(Object.entries(value))['ts']
  return typeof ts === 'number' ? ts : undefined
}
