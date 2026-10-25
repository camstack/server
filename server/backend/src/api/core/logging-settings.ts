/**
 * The logging settings DOCUMENT — one authority over log levels and armed
 * diagnostics, read and written whole through `system.getLoggingSettings` /
 * `system.setLoggingSettings`.
 *
 * ## Why one document and not one method per knob
 *
 * The audit in `docs/design/plans/2026-08-26-per-component-logging.md` found
 * the level spread over five knobs in three settings panels, two kernel config
 * keys and an env var that never reached an addon. Adding a cap method per
 * knob would have reproduced that on the API. So: adding a logging setting
 * means adding a FIELD to `LoggingSettingsPatchSchema`, never a method.
 *
 * ## The patch merges
 *
 * A field absent from the patch is left exactly as it was. The record is never
 * rebuilt as `{ ...stored, ...patch }` — that spelling turns "absent" into
 * "erased" the moment someone adds a nested object, and this repo already has
 * a rule against it. Each field decides for itself: absent → keep, `null` →
 * clear, value → set.
 *
 * ## Hierarchy: cluster → node → component, most specific wins
 *
 * A node's own level wins over the cluster's, and a COMPONENT — a declared log
 * channel such as `stream-broker.webrtc` — wins over both. With none set the
 * hub emits at {@link DEFAULT_LOG_LEVEL}. Both `effective` AND `explicit` are
 * returned, because collapsing them is the defect: an operator who clears an
 * override believing they are clearing an inherited value has no way back.
 *
 * A component level is CLUSTER-WIDE. There is no per-node component map and
 * there must not be one: a channel means the same thing wherever the addon
 * that declared it runs, and a second per-node copy would be the knob that
 * disagrees with the first (D62).
 *
 * ## Channels are DECLARED by addons; only the VALUE lives here
 *
 * Which channels exist is knowledge only the owning addon has, and it arrives
 * through the `log-channels` capability ({@link LogChannelPlane}). A central
 * list maintained by hand rots at the first addition, invisibly. What this
 * document owns is which channel is armed, for which cameras, until when —
 * and that stays singular, because two authorities over one value is the
 * defect the plan behind this file exists to remove.
 *
 * ## The hot path reads the MIRROR, and a failed read changes nothing
 *
 * This service is the durable authority. {@link LoggingGate} is the mirror the
 * log path reads, refreshed here — on a write and once at boot — and NEVER
 * from a value that was not actually read. A store read that throws returns
 * `null` from {@link LoggingSettingsService.read} and every caller treats that
 * as "unknown", not as "cleared": the mirror keeps its floor and an armed
 * diagnostic stays armed (D49). A doorbell in this repo rang 0/3 because one
 * bad read looked exactly like a real "off".
 *
 * ## Diagnostics carry a deadline, never a boolean
 *
 * `request-census` is armed through this document and nowhere else. The window
 * mechanics — the persisted deadline, the clamp, the boot restore of the
 * REMAINDER — stay in {@link RequestCensusService}, which owns them (ADR-0244);
 * this service is its only caller, so there is exactly one write authority
 * over the window (D245).
 */

import {
  errMsg,
  type DiagnosticWindow,
  type IScopedLogger,
  type ILogChannelsProvider,
  type LogChannelDescriptor,
  type LogChannelWindow,
  type LogChannelWindowPatch,
  type LogChannelWindowState,
  type LoggingLevelLayer,
  type LoggingLevelSource,
  type LoggingSettingsPatch,
  type LoggingSettingsState,
  type LogLevel,
} from '@camstack/types'
import { DEFAULT_LOG_LEVEL, type LoggingGate } from '@camstack/system'
import type { RequestCensusService } from './request-census-settings.js'
import type { SettingsStoreGateway } from './site-location.js'

/** The `system-settings` row this module owns. */
export const LOGGING_SETTINGS_KEY = 'logging-settings'

const SYSTEM_SETTINGS_COLLECTION = 'system-settings'

/** The node a hub speaks for when a caller does not name one. */
export const HUB_NODE_ID = 'hub'

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

/**
 * The persisted row. Every field optional — an older row must still read, and
 * a field this version does not know about must survive a write by a version
 * that does not know it either.
 */
/**
 * How long the analytics ops log is kept when nothing is configured.
 *
 * Thirty days, the number that was hardcoded in `pipeline-analytics/index.ts`
 * until D485. It is longer than any device retention window on purpose:
 * `retention-model.ts` calls it "the one root that must NOT follow a device
 * window … the audit trail is not history of the camera, it is history of the
 * sweep". That reasoning is why the value stays 30 by default; it was never a
 * reason for the value to be unreachable.
 */
export const OPS_LOG_RETENTION_DEFAULT_DAYS = 30

export interface LoggingSettingsRecord {
  /** Explicit cluster-wide level, or absent when the cluster inherits nothing. */
  readonly clusterLevel?: LogLevel
  /** Explicit per-node levels, keyed by node id. */
  readonly nodeLevels?: Readonly<Record<string, LogLevel>>
  /**
   * Explicit per-COMPONENT levels, keyed by declared channel name.
   *
   * Cluster-wide by construction — there is no per-node component map, and
   * there must not be one. The convention this repo settled on is a single
   * cluster-wide setting per function (D52); a per-node copy of a component
   * level would be the second knob that disagrees with the first (D62).
   */
  readonly componentLevels?: Readonly<Record<string, LogLevel>>
  /**
   * The armed channel windows, keyed by channel name. A DEADLINE, never a
   * flag — persisted so a window armed to measure the next boot is still
   * running when the boot happens, and so a channel somebody forgot expires
   * by itself rather than costing forever.
   */
  readonly channelWindows?: Readonly<Record<string, StoredChannelWindow>>
  /**
   * How many days the analytics ops log is kept. `0` = forever. Absent = the
   * shipped {@link OPS_LOG_RETENTION_DEFAULT_DAYS}.
   *
   * Cluster-wide, with no per-node layer, for the same reason the component
   * levels have none: one setting per function (D52). An audit trail whose
   * length differed per node would answer "what deleted my data" differently
   * depending on which node you asked, which is the opposite of an audit.
   */
  readonly opsLogRetentionDays?: number
  readonly updatedAt?: number
}

/** One persisted channel window. `deviceIds: null` = every camera. */
export interface StoredChannelWindow {
  readonly armedUntilMs: number
  readonly deviceIds: readonly number[] | null
}

/**
 * The seam between the document (hub-main) and the GATES, which live in the
 * addon processes that declared them.
 *
 * Some seam has to exist: a channel the document can name but not reach is
 * precisely the dead knob this work exists to make impossible (D62). It is
 * deliberately narrow — enumerate the declarations, push the armed set — and
 * it is never asked for a VALUE, because the document is the only authority
 * over those.
 */
export interface LogChannelPlane {
  /** Every channel every `log-channels` provider declares. */
  declarations(): Promise<readonly LogChannelDescriptor[]>
  /**
   * Push the FULL armed set to every provider. Called only with a set this
   * process actually resolved — a store read that failed never reaches here,
   * so a bad read can neither disarm an armed channel nor arm a disarmed one
   * (D49).
   */
  apply(windows: readonly LogChannelWindow[]): Promise<void>
}

/** A plane that reaches nothing. The shape of a hub with no addon booted yet. */
export const EMPTY_LOG_CHANNEL_PLANE: LogChannelPlane = {
  declarations: async () => [],
  apply: async () => {},
}

/** What {@link buildLogChannelPlane} needs off the registry, and nothing more. */
export interface LogChannelProviderSource {
  entries(): readonly (readonly [string, ILogChannelsProvider])[]
}

/**
 * The plane over the hub's `CapabilityRegistry`.
 *
 * Every `log-channels` provider is either in-process or an RPC proxy the
 * registry already built for a forked runner or an agent
 * (`moleculer.service.ts` registers one method-per-method), so this reaches
 * the gates over transport that already exists — no new UDS message, no second
 * registry (D3).
 *
 * One provider failing must not silence the others: each is awaited on its
 * own, a failure is reported to `onProviderError` (a branch that drops work
 * logs it), and the remaining providers still get the value.
 */
export function buildLogChannelPlane(
  source: LogChannelProviderSource,
  onProviderError?: (addonId: string, phase: 'list' | 'apply', error: string) => void,
): LogChannelPlane {
  return {
    declarations: async () => {
      const seen = new Map<string, LogChannelDescriptor>()
      for (const [addonId, provider] of source.entries()) {
        try {
          for (const descriptor of await provider.list()) {
            // First declaration wins. A duplicate name across addons is a
            // collision the guard refuses at CI time; at runtime the honest
            // move is to keep one rather than show the operator two rows that
            // arm the same gate.
            if (!seen.has(descriptor.name)) seen.set(descriptor.name, descriptor)
          }
        } catch (err: unknown) {
          onProviderError?.(addonId, 'list', errMsg(err))
        }
      }
      return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
    },
    apply: async (windows) => {
      for (const [addonId, provider] of source.entries()) {
        try {
          await provider.apply({ windows })
        } catch (err: unknown) {
          onProviderError?.(addonId, 'apply', errMsg(err))
        }
      }
    },
  }
}

/**
 * Ceiling on a channel window, and the same value as `CENSUS_MAX_WINDOW_MS`
 * for the same reason: a diagnostic you can leave on becomes a tax nobody
 * remembers enabling.
 */
export const MAX_CHANNEL_WINDOW_MS = 30 * 60_000

export interface LoggingSettingsServiceDeps {
  readonly store: SettingsStoreGateway
  readonly gate: LoggingGate
  readonly requestCensus: RequestCensusService
  /** The node this process IS. Only its own floor reaches the local mirror. */
  readonly localNodeId?: string
  readonly logger?: IScopedLogger
  readonly now?: () => number
  /** Absent = a hub whose channels cannot be reached yet. */
  readonly channels?: LogChannelPlane
}

export class LoggingSettingsService {
  private readonly store: SettingsStoreGateway
  private readonly gate: LoggingGate
  private readonly requestCensus: RequestCensusService
  private readonly localNodeId: string
  private readonly logger: IScopedLogger | undefined
  private readonly now: () => number
  private readonly channels: LogChannelPlane

  constructor(deps: LoggingSettingsServiceDeps) {
    this.store = deps.store
    this.gate = deps.gate
    this.requestCensus = deps.requestCensus
    this.localNodeId = deps.localNodeId ?? HUB_NODE_ID
    this.logger = deps.logger
    this.now = deps.now ?? Date.now
    this.channels = deps.channels ?? EMPTY_LOG_CHANNEL_PLANE
  }

  /**
   * The document as it stands, resolved for `nodeId` (absent = the cluster).
   *
   * A read that fails yields `persisted: false` and the DEFAULT hierarchy —
   * and, crucially, does not touch the mirror. What the operator sees is
   * honestly labelled as un-persisted; what the hub does is unchanged.
   */
  async get(scopeNodeId?: string, scopeComponent?: string): Promise<LoggingSettingsState> {
    const record = await this.read()
    return this.describe(record, scopeNodeId ?? null, scopeComponent ?? null)
  }

  /**
   * Apply a patch. Fields absent from it are untouched.
   *
   * The diagnostics are armed FIRST and the level row written after, for the
   * same reason ADR-0244 arms before it writes: a settings store that is down
   * must still give the operator a live measurement, and must say so rather
   * than reporting a durable arm that is not durable.
   */
  async set(
    patch: LoggingSettingsPatch,
    scopeNodeId?: string,
    scopeComponent?: string,
  ): Promise<LoggingSettingsState> {
    await this.applyDiagnostics(patch)

    const scope = scopeNodeId ?? null
    const component = scopeComponent ?? null
    const stored = await this.read()
    const levelChanged = patch.level !== undefined
    const channelsChanged = patch.channels !== undefined
    let persisted = true
    let next = stored ?? {}

    if (levelChanged) {
      next = mergeLevel(next, scope, component, patch.level ?? null, this.now())
    }
    if (patch.opsLogRetentionDays !== undefined) {
      // A scalar, merged like any other field. Absent leaves it alone — the
      // patch contract: arming a channel must not silently rewrite how long the
      // audit trail lives.
      next = { ...next, opsLogRetentionDays: patch.opsLogRetentionDays, updatedAt: this.now() }
    }
    if (channelsChanged) {
      // Validated BEFORE anything is written: a patch that names an
      // undeclared channel, or narrows a channel whose lines carry no
      // `tags: { deviceId }`, is REFUSED whole. Applying the valid half would
      // leave the operator believing the refused half took, which is the
      // partial-arm defect wearing a different hat.
      const declared = await this.channels.declarations()
      const rejected = validateChannelPatch(patch.channels ?? [], declared)
      if (rejected.length > 0) {
        this.logger?.warn('log channel patch refused - nothing was armed or disarmed', {
          meta: { reasons: rejected },
        })
        throw new Error(`log channel patch refused: ${rejected.join('; ')}`)
      }
      next = mergeChannelWindows(next, patch.channels ?? [], this.now())
    }

    if (levelChanged || channelsChanged) {
      persisted = await this.write(next)
      // The mirror moves only from a value this call actually produced.
      this.refreshMirror(next)
      // The gates live in other processes; the document has to reach them or
      // it configures nothing (D62).
      await this.pushChannels(next)
      this.logger?.info('logging settings written', {
        meta: {
          scope: component !== null ? 'component' : scope === null ? 'cluster' : 'node',
          nodeId: scope,
          component,
          level: levelChanged ? (patch.level ?? null) : undefined,
          channels: (patch.channels ?? []).map((c) => `${c.channel}:${c.armMs}`),
          persisted,
        },
      })
      const state = await this.describe(next, scope, component)
      return { ...state, persisted: state.persisted && persisted }
    }

    return this.describe(stored, scope, component)
  }

  /**
   * Re-establish the mirror and re-arm any diagnostic window that outlived the
   * last shutdown. Called once at boot, before the socket opens.
   *
   * A read that fails leaves the mirror at its default and says so. It never
   * writes: a restore that refreshed a deadline would make a forgotten
   * diagnostic immortal across restarts, which is the one failure a deadline
   * exists to prevent.
   */
  async restore(): Promise<void> {
    const record = await this.read()
    if (record !== null) {
      this.refreshMirror(record)
      // The REMAINDER of a window survives the restart; an expired one is
      // dropped by `liveChannelWindows` rather than re-armed, so a forgotten
      // diagnostic cannot become immortal across reboots.
      await this.pushChannels(record)
    }
    await this.requestCensus.restore()
  }

  // ── internals ─────────────────────────────────────────────────────

  /** Push the LOCAL node's effective level into the hot-path mirror. */
  private refreshMirror(record: LoggingSettingsRecord): void {
    this.gate.setDestinationFloor(resolveLevel(record, this.localNodeId).level)
  }

  private async applyDiagnostics(patch: LoggingSettingsPatch): Promise<void> {
    for (const window of patch.diagnostics ?? []) {
      if (window.id !== 'request-census') continue
      await this.requestCensus.set({
        armMs: window.armMs,
        ...(window.reportEveryMs !== undefined ? { reportEveryMs: window.reportEveryMs } : {}),
      })
    }
  }

  /**
   * Push the live windows to every declared gate.
   *
   * A failure here is logged and swallowed: the document is written and the
   * operator is told what it says, and a runner that could not be reached
   * simply keeps the mirror it has. Throwing would turn one unreachable addon
   * into a failed write for the whole cluster.
   */
  private async pushChannels(record: LoggingSettingsRecord): Promise<void> {
    try {
      await this.channels.apply(liveChannelWindows(record, this.now()))
    } catch (err: unknown) {
      this.logger?.warn('log channel windows written but NOT pushed to every gate', {
        meta: { error: errMsg(err) },
      })
    }
  }

  private async describe(
    record: LoggingSettingsRecord | null,
    scopeNodeId: string | null,
    scopeComponent: string | null,
  ): Promise<LoggingSettingsState> {
    const resolved = resolveLevel(record ?? {}, scopeNodeId, scopeComponent)
    return {
      scopeNodeId,
      scopeComponent,
      effective: { level: resolved.level, levelSource: resolved.source },
      explicit: { layers: describeLayers(record ?? {}, scopeNodeId, scopeComponent) },
      activeWindows: await this.describeWindows(),
      channels: await this.declaredChannels(),
      activeChannels: describeChannelWindows(record ?? {}, this.now()),
      opsLogRetentionDays: record?.opsLogRetentionDays ?? OPS_LOG_RETENTION_DEFAULT_DAYS,
      persisted: record !== null,
    }
  }

  /**
   * The declarations, assembled per read.
   *
   * Not cached and not stored: a channel added by a redeployed addon has to
   * appear without anybody editing a list, and a channel whose addon is gone
   * has to stop being offered. A read that throws yields the EMPTY list and
   * says so — "unknown" is the truth about a set of addons nobody reached, and
   * it changes no armed window (D49/D224).
   */
  private async declaredChannels(): Promise<readonly LogChannelDescriptor[]> {
    try {
      return await this.channels.declarations()
    } catch (err: unknown) {
      this.logger?.warn('log channel declarations unreadable - reporting none', {
        meta: { error: errMsg(err) },
      })
      return []
    }
  }

  /**
   * The armed windows, with their deadline.
   *
   * Read from the LIVE diagnostic, never from the stored row: a window armed
   * before a restart that was never restored must not look armed. `persisted`
   * is the census's own comparison of the stored deadline against the running
   * one — asking it rather than re-deriving it is what keeps the two from
   * drifting.
   */
  private async describeWindows(): Promise<readonly DiagnosticWindow[]> {
    const census = await this.requestCensus.status()
    const remainingMs = census.armed ? Math.max(0, census.armedUntilMs - this.now()) : 0
    return [
      {
        id: 'request-census',
        armed: census.armed,
        armedUntilMs: census.armedUntilMs,
        remainingMs,
        persisted: census.persisted,
      },
    ]
  }

  /**
   * The stored row, or `null` when it is absent OR unreadable.
   *
   * The two collapse on purpose at this level — every caller treats `null` as
   * "do not touch anything" — and the difference is in the log, because a
   * branch that drops work silently reads as "never happened".
   */
  private async read(): Promise<LoggingSettingsRecord | null> {
    try {
      const raw = await this.store.get({
        collection: SYSTEM_SETTINGS_COLLECTION,
        key: LOGGING_SETTINGS_KEY,
      })
      return toLoggingSettingsRecord(raw)
    } catch (err: unknown) {
      this.logger?.warn('logging settings read failed - mirror left untouched', {
        meta: { error: errMsg(err) },
      })
      return null
    }
  }

  private async write(record: LoggingSettingsRecord): Promise<boolean> {
    try {
      await this.store.set({
        collection: SYSTEM_SETTINGS_COLLECTION,
        key: LOGGING_SETTINGS_KEY,
        value: record,
      })
      return true
    } catch (err: unknown) {
      this.logger?.warn(
        'logging settings applied in memory but NOT persisted - they will not survive a restart',
        { meta: { error: errMsg(err) } },
      )
      return false
    }
  }
}

// ── pure helpers ────────────────────────────────────────────────────

/** Structural read of the stored row. Anything unrecognised reads as absent. */
export function toLoggingSettingsRecord(value: unknown): LoggingSettingsRecord {
  if (typeof value !== 'object' || value === null) return {}
  const clusterLevel = asLogLevel(Reflect.get(value, 'clusterLevel'))
  const nodeLevels = asNodeLevels(Reflect.get(value, 'nodeLevels'))
  const componentLevels = asNodeLevels(Reflect.get(value, 'componentLevels'))
  const channelWindows = asChannelWindows(Reflect.get(value, 'channelWindows'))
  const updatedAt: unknown = Reflect.get(value, 'updatedAt')
  return {
    ...(clusterLevel !== null ? { clusterLevel } : {}),
    ...(nodeLevels !== null ? { nodeLevels } : {}),
    ...(componentLevels !== null ? { componentLevels } : {}),
    ...(channelWindows !== null ? { channelWindows } : {}),
    ...(typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? { updatedAt } : {}),
  }
}

export interface ResolvedLevel {
  readonly level: LogLevel
  readonly source: LoggingLevelSource
}

/**
 * cluster → node → component, most specific wins.
 *
 * `nodeId === null` resolves the CLUSTER layer, which by definition cannot
 * inherit a node value — reading the document at cluster scope must never show
 * one node's override as if it were everybody's.
 *
 * `component` is the most specific layer and it is CLUSTER-WIDE: a channel
 * means the same thing wherever the addon that declared it runs, and a
 * per-node copy of it would be a second knob that disagrees with the first
 * (D62). It sits above `node` because it is narrower in the dimension the
 * operator actually reasons in — "everything on this node except make
 * `stream-broker.webrtc` louder" is the request; "this node's level, but only
 * where it is not a channel" is not a request anybody makes.
 */
export function resolveLevel(
  record: LoggingSettingsRecord,
  nodeId: string | null,
  component: string | null = null,
): ResolvedLevel {
  const componentLevel = component === null ? undefined : record.componentLevels?.[component]
  if (componentLevel !== undefined) return { level: componentLevel, source: 'component' }
  const nodeLevel = nodeId === null ? undefined : record.nodeLevels?.[nodeId]
  if (nodeLevel !== undefined) return { level: nodeLevel, source: 'node' }
  if (record.clusterLevel !== undefined) return { level: record.clusterLevel, source: 'cluster' }
  return { level: DEFAULT_LOG_LEVEL, source: 'default' }
}

/**
 * The layers as they stand, general → specific. `level: null` means the layer
 * carries no explicit value and inherits.
 */
export function describeLayers(
  record: LoggingSettingsRecord,
  nodeId: string | null,
  component: string | null = null,
): readonly LoggingLevelLayer[] {
  const layers: LoggingLevelLayer[] = [
    { scope: 'cluster', nodeId: null, component: null, level: record.clusterLevel ?? null },
  ]
  if (nodeId !== null) {
    layers.push({
      scope: 'node',
      nodeId,
      component: null,
      level: record.nodeLevels?.[nodeId] ?? null,
    })
  }
  if (component !== null) {
    layers.push({
      scope: 'component',
      nodeId: null,
      component,
      level: record.componentLevels?.[component] ?? null,
    })
  }
  return layers
}

/**
 * Merge a level into the record at one scope.
 *
 * `next === null` CLEARS that scope so it inherits again; a value sets it.
 * Everything else in the record is carried through untouched — including a
 * per-node map the caller never mentioned.
 *
 * A named `component` wins the addressing: a caller that supplies both is
 * addressing the component layer, because a component level is cluster-wide
 * and the node selector has no meaning there.
 */
export function mergeLevel(
  record: LoggingSettingsRecord,
  nodeId: string | null,
  component: string | null,
  next: LogLevel | null,
  updatedAt: number,
): LoggingSettingsRecord {
  if (component !== null) {
    const { [component]: _clearedComponent, ...otherComponents } = record.componentLevels ?? {}
    const componentLevels: Record<string, LogLevel> = {
      ...otherComponents,
      ...(next !== null ? { [component]: next } : {}),
    }
    return { ...record, componentLevels, updatedAt }
  }
  if (nodeId === null) {
    const { clusterLevel: _dropped, ...rest } = record
    return { ...rest, ...(next !== null ? { clusterLevel: next } : {}), updatedAt }
  }
  const { [nodeId]: _cleared, ...otherNodes } = record.nodeLevels ?? {}
  const nodeLevels: Record<string, LogLevel> = {
    ...otherNodes,
    ...(next !== null ? { [nodeId]: next } : {}),
  }
  return {
    ...record,
    ...(Object.keys(nodeLevels).length > 0 ? { nodeLevels } : { nodeLevels: {} }),
    updatedAt,
  }
}

// ── channel windows ─────────────────────────────────────────────────

/**
 * Why a patch is refused, in the operator's words. Empty = accepted.
 *
 * Two refusals, and the second is the point of the whole per-camera design:
 *
 *  - an UNDECLARED channel. Silently accepting one would let a typo look like
 *    a working arm forever — the `CAMSTACK_FLEET_READ_CENSUS_MS=true` failure,
 *    which cost a whole boot before anyone noticed nothing was being measured.
 *  - `deviceIds` on a channel declared `perDevice: false`. That channel's
 *    lines carry no `tags: { deviceId }`, so the narrowing would produce a
 *    filter matching nothing. Widening it silently to "every camera" would be
 *    worse: the operator would believe per-camera filtering works there, and
 *    conclude from the first unrelated line that the wrong camera is at fault.
 */
export function validateChannelPatch(
  patches: readonly LogChannelWindowPatch[],
  declared: readonly LogChannelDescriptor[],
): readonly string[] {
  const byName = new Map(declared.map((d) => [d.name, d]))
  const reasons: string[] = []
  for (const patch of patches) {
    const descriptor = byName.get(patch.channel)
    if (descriptor === undefined) {
      const known = [...byName.keys()].sort().slice(0, 8).join(', ')
      reasons.push(
        `"${patch.channel}" is not declared by any addon on this cluster` +
          (known.length > 0 ? ` (declared: ${known})` : ''),
      )
      continue
    }
    const ids = patch.deviceIds
    if (ids !== undefined && ids !== null && ids.length > 0 && !descriptor.perDevice) {
      reasons.push(
        `"${patch.channel}" is declared perDevice: false — its lines carry no ` +
          'tags.deviceId, so narrowing it to a camera would match nothing',
      )
    }
  }
  return reasons
}

/**
 * Apply channel patches to the record. `armMs: 0` disarms; a positive value
 * arms until `now + min(armMs, MAX_CHANNEL_WINDOW_MS)`.
 *
 * Only the channels NAMED are touched — a channel absent from the patch keeps
 * whatever window it had, so the Levels page and the Diagnostics page cannot
 * disarm each other's work.
 */
export function mergeChannelWindows(
  record: LoggingSettingsRecord,
  patches: readonly LogChannelWindowPatch[],
  nowMs: number,
): LoggingSettingsRecord {
  const windows: Record<string, StoredChannelWindow> = { ...record.channelWindows }
  for (const patch of patches) {
    if (patch.armMs <= 0) {
      delete windows[patch.channel]
      continue
    }
    const ids = patch.deviceIds
    windows[patch.channel] = {
      armedUntilMs: nowMs + Math.min(patch.armMs, MAX_CHANNEL_WINDOW_MS),
      deviceIds: ids === undefined || ids === null || ids.length === 0 ? null : [...ids],
    }
  }
  return { ...record, channelWindows: windows, updatedAt: nowMs }
}

/**
 * The windows still running at `nowMs`, in the shape the gates take.
 *
 * An expired window is DROPPED rather than pushed: this is what stops a
 * restore from re-arming a diagnostic somebody forgot months ago, which is the
 * one failure a deadline exists to prevent.
 */
export function liveChannelWindows(
  record: LoggingSettingsRecord,
  nowMs: number,
): readonly LogChannelWindow[] {
  const out: LogChannelWindow[] = []
  for (const [channel, window] of Object.entries(record.channelWindows ?? {})) {
    if (window.armedUntilMs <= nowMs) continue
    out.push({ channel, armedUntilMs: window.armedUntilMs, deviceIds: window.deviceIds })
  }
  return out.sort((a, b) => a.channel.localeCompare(b.channel))
}

/** The windows as the page shows them: deadline plus time left, never a flag. */
export function describeChannelWindows(
  record: LoggingSettingsRecord,
  nowMs: number,
): readonly LogChannelWindowState[] {
  const out: LogChannelWindowState[] = []
  for (const [channel, window] of Object.entries(record.channelWindows ?? {})) {
    const armed = window.armedUntilMs > nowMs
    out.push({
      channel,
      armed,
      armedUntilMs: armed ? window.armedUntilMs : 0,
      remainingMs: armed ? window.armedUntilMs - nowMs : 0,
      deviceIds: armed ? window.deviceIds : null,
    })
  }
  return out.sort((a, b) => a.channel.localeCompare(b.channel))
}

function asChannelWindows(value: unknown): Readonly<Record<string, StoredChannelWindow>> | null {
  if (typeof value !== 'object' || value === null) return null
  const out: Record<string, StoredChannelWindow> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'object' || raw === null) continue
    const armedUntilMs: unknown = Reflect.get(raw, 'armedUntilMs')
    if (typeof armedUntilMs !== 'number' || !Number.isFinite(armedUntilMs)) continue
    out[key] = { armedUntilMs, deviceIds: asDeviceIds(Reflect.get(raw, 'deviceIds')) }
  }
  return out
}

function asDeviceIds(value: unknown): readonly number[] | null {
  if (!Array.isArray(value)) return null
  const ids = value.filter((id): id is number => typeof id === 'number' && Number.isInteger(id))
  return ids.length > 0 ? ids : null
}

function asLogLevel(value: unknown): LogLevel | null {
  return typeof value === 'string' && isLogLevel(value) ? value : null
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value)
}

function asNodeLevels(value: unknown): Readonly<Record<string, LogLevel>> | null {
  if (typeof value !== 'object' || value === null) return null
  const out: Record<string, LogLevel> = {}
  for (const [key, raw] of Object.entries(value)) {
    const level = asLogLevel(raw)
    if (level !== null) out[key] = level
  }
  return out
}
