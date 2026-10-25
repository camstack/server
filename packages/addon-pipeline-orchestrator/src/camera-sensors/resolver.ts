/**
 * Resolve a camera's attached sensors (D672) from stable refs
 * (`{ addonId, stableId }`) to device ids — OFF the event path, through
 * ports, with no state of its own.
 *
 * D49 shapes every branch: a read that FAILS changes nothing (the prior input
 * is kept and the attachment says `unreadable`), and a read that says a READY
 * ref is gone — the direction that destroys work — needs a second by-id read
 * to agree, and then a by-addon listing that also does not find the stableId,
 * before the sensor stops routing. A row matches only on id AND addonId AND
 * stableId: a number alone never identifies a device across a re-adoption.
 */
import {
  type AddonApi,
  type CameraSensorAttachment,
  type CameraSensorEntry,
  type CameraSensorMode,
  type CameraSensorRef,
  type CameraSensorsConfig,
  type CameraSensorsStatus,
  cameraSensorRefKey,
  type DeviceInfo,
  errMsg,
  type IScopedLogger,
  isSourceCap,
  SOURCE_CAPS,
} from '@camstack/types'
import { cameraOwnMotionRule } from './effective-motion.js'
import type { CameraSensorsSetting } from './settings.js'

export interface CameraSensorDeviceRow {
  readonly id: number
  readonly addonId: string
  readonly stableId: string
  readonly name: string
  readonly online: boolean
  readonly disabled: boolean
  readonly isCamera: boolean
}
export type DeviceRowsRead =
  | { readonly kind: 'rows'; readonly rows: readonly CameraSensorDeviceRow[] }
  | { readonly kind: 'unreadable'; readonly error: string }
export type SourceCapsRead =
  | { readonly kind: 'caps'; readonly byDevice: ReadonlyMap<number, readonly string[]> }
  | { readonly kind: 'unreadable'; readonly error: string }

export interface CameraSensorsResolverPorts {
  readonly logger: IScopedLogger
  /** `deviceManager.listAll({ addonId, projection: 'slim' })` — the composer's own resolution read. */
  readonly listByAddon: (addonId: string) => Promise<DeviceRowsRead>
  /** `deviceManager.listAll({ deviceIds, projection: 'slim' })`. */
  readonly listByIds: (deviceIds: readonly number[]) => Promise<DeviceRowsRead>
  /** `deviceManager.getBindingsBatch`, narrowed to `SOURCE_CAPS`. A device missing from the answer is absent from the map. */
  readonly sourceCapsOf: (deviceIds: readonly number[]) => Promise<SourceCapsRead>
}

export interface ResolvedCameraSensor {
  readonly ref: CameraSensorEntry
  readonly deviceId: number
  readonly mode: CameraSensorMode
  /** C3: `ready` attachment; an `unreadable` one keeps the PRIOR readiness (D49). */
  readonly ready: boolean
}
export interface CameraSensorsResolution {
  readonly status: CameraSensorsStatus
  /** The sensors whose state drives this camera's onboard motion. */
  readonly inputs: readonly ResolvedCameraSensor[]
}

/** Where one ref landed after the device reads (before the bindings read). */
type RefOutcome =
  | { readonly kind: 'found'; readonly row: CameraSensorDeviceRow }
  | { readonly kind: 'unreadable'; readonly reason: string; readonly keptDeviceId: number | null }
  | { readonly kind: 'missing' }

/** A known ref's by-id outcome: `gone` is confirmed by two agreeing reads. */
type KnownOutcome = RefOutcome | { readonly kind: 'gone'; readonly deviceId: number }

/**
 * A ref the by-addon listing must find. `priorDeviceId` is the id a ref
 * confirmed gone by two by-id reads was routed to: a FAILED listing keeps it
 * (R10, D49); only an ANSWERED listing that lacks the stableId un-routes.
 */
interface UnresolvedRef {
  readonly ref: CameraSensorRef
  readonly priorDeviceId: number | null
}

/** One found row's verdict: its attachment, and whether it drives the camera. */
interface JudgedAttachment {
  readonly attachment: CameraSensorAttachment
  readonly routed: boolean
}

/** One configured ref's verdict: its attachment, and the id it routes (null = none). */
interface JudgedRef {
  readonly attachment: CameraSensorAttachment
  readonly deviceId: number | null
}

type ReadName = 'listByIds' | 'listByAddon' | 'sourceCapsOf'

const NOT_CONFIGURED_RESOLUTION: CameraSensorsResolution = Object.freeze({
  status: Object.freeze({ state: 'not-configured' }),
  inputs: Object.freeze([]),
})

const NO_SOURCE_CAP_REASON = `no motion-capable cap bound (supported: ${SOURCE_CAPS.join(', ')})`

function matchesRef(row: CameraSensorDeviceRow, ref: CameraSensorRef): boolean {
  return row.addonId === ref.addonId && row.stableId === ref.stableId
}

function logReadFailure(
  ports: CameraSensorsResolverPorts,
  cameraId: number,
  read: ReadName,
  error: string,
): void {
  ports.logger.warn('camera-sensors: read failed — the previous mapping stands where it had one', {
    tags: { deviceId: cameraId },
    meta: { read, error },
  })
}

function findKnown(
  rows: readonly CameraSensorDeviceRow[],
  ref: CameraSensorRef,
  deviceId: number,
): CameraSensorDeviceRow | undefined {
  return rows.find((row) => row.id === deviceId && matchesRef(row, ref))
}

/**
 * Refs that were routed before: re-read by id. A miss is only believed when a
 * second by-id read agrees; either read failing keeps the input.
 */
async function readKnown(
  cameraId: number,
  known: readonly ResolvedCameraSensor[],
  ports: CameraSensorsResolverPorts,
): Promise<ReadonlyMap<string, KnownOutcome>> {
  if (known.length === 0) return new Map()
  const first = await ports.listByIds(known.map((k) => k.deviceId))
  if (first.kind === 'unreadable') {
    logReadFailure(ports, cameraId, 'listByIds', first.error)
    const reason = `device lookup failed — ${first.error}`
    return new Map(
      known.map((k) => [
        cameraSensorRefKey(k.ref),
        { kind: 'unreadable', reason, keptDeviceId: k.deviceId },
      ]),
    )
  }
  const found = known.flatMap((k) => {
    const row = findKnown(first.rows, k.ref, k.deviceId)
    return row ? [[cameraSensorRefKey(k.ref), { kind: 'found', row }] as const] : []
  })
  const missed = known.filter((k) => !findKnown(first.rows, k.ref, k.deviceId))
  if (missed.length === 0) return new Map(found)
  const second = await ports.listByIds(missed.map((k) => k.deviceId))
  if (second.kind === 'unreadable') logReadFailure(ports, cameraId, 'listByIds', second.error)
  const confirmed = missed.map((k): readonly [string, KnownOutcome] => {
    const key = cameraSensorRefKey(k.ref)
    if (second.kind === 'unreadable') {
      const reason = `awaiting confirmation — second lookup failed: ${second.error}`
      return [key, { kind: 'unreadable', reason, keptDeviceId: k.deviceId }]
    }
    const row = findKnown(second.rows, k.ref, k.deviceId)
    return [key, row ? { kind: 'found', row } : { kind: 'gone', deviceId: k.deviceId }]
  })
  return new Map([...found, ...confirmed])
}

/** Refs with no confirmed id: one listing per addon, matched by stableId. */
async function readByAddon(
  cameraId: number,
  refs: readonly UnresolvedRef[],
  ports: CameraSensorsResolverPorts,
): Promise<ReadonlyMap<string, RefOutcome>> {
  const addonIds = [...new Set(refs.map(({ ref }) => ref.addonId))]
  const listings = await Promise.all(
    addonIds.map(async (addonId) => [addonId, await ports.listByAddon(addonId)] as const),
  )
  const byAddon = new Map(listings)
  for (const [addonId, read] of listings) {
    if (read.kind === 'unreadable')
      logReadFailure(ports, cameraId, 'listByAddon', `${addonId}: ${read.error}`)
  }
  return new Map(
    refs.map(({ ref, priorDeviceId }): readonly [string, RefOutcome] => {
      const read = byAddon.get(ref.addonId)
      if (!read || read.kind === 'unreadable') {
        const reason = `device listing of ${ref.addonId} failed — ${read?.error ?? 'no answer'}`
        return [
          cameraSensorRefKey(ref),
          { kind: 'unreadable', reason, keptDeviceId: priorDeviceId },
        ]
      }
      const row = read.rows.find((r) => matchesRef(r, ref))
      return [cameraSensorRefKey(ref), row ? { kind: 'found', row } : { kind: 'missing' }]
    }),
  )
}

/** One found row, judged against its bindings (R7 first: a camera is never an input). */
function judgeFound(
  ref: CameraSensorEntry,
  row: CameraSensorDeviceRow,
  caps: SourceCapsRead,
): JudgedAttachment {
  const base = { ...ref, deviceId: row.id, name: row.name }
  if (row.isCamera) {
    return {
      attachment: { ...base, state: 'unsupported', reason: 'a camera cannot be a camera sensor' },
      routed: false,
    }
  }
  const bound = caps.kind === 'caps' ? caps.byDevice.get(row.id) : undefined
  if (bound === undefined) {
    const error = caps.kind === 'unreadable' ? caps.error : `no answer for device ${row.id}`
    return {
      attachment: { ...ref, state: 'unreadable', reason: `bindings unreadable — ${error}` },
      routed: true,
    }
  }
  if (bound.length === 0) {
    return {
      attachment: { ...base, state: 'unsupported', reason: NO_SOURCE_CAP_REASON },
      routed: false,
    }
  }
  if (row.disabled)
    return { attachment: { ...base, state: 'offline', reason: 'disabled' }, routed: true }
  if (!row.online)
    return { attachment: { ...base, state: 'offline', reason: 'offline' }, routed: true }
  return { attachment: { ...base, state: 'ready', caps: bound }, routed: true }
}

function judgeRef(
  ref: CameraSensorEntry,
  outcome: RefOutcome | undefined,
  caps: SourceCapsRead,
): JudgedRef {
  if (outcome?.kind === 'found') {
    const judged = judgeFound(ref, outcome.row, caps)
    return { attachment: judged.attachment, deviceId: judged.routed ? outcome.row.id : null }
  }
  if (outcome?.kind === 'unreadable') {
    return {
      attachment: { ...ref, state: 'unreadable', reason: outcome.reason },
      deviceId: outcome.keptDeviceId,
    }
  }
  const reason = `no device ${ref.addonId}/${ref.stableId}`
  return { attachment: { ...ref, state: 'missing', reason }, deviceId: null }
}

/** C3: only a READY attachment reshapes the camera; a failed READ keeps the prior readiness (D49). */
function readinessOf(
  attachment: CameraSensorAttachment,
  ref: CameraSensorEntry,
  prior: CameraSensorsResolution | null,
): boolean {
  if (attachment.state === 'ready') return true
  if (attachment.state !== 'unreadable') return false
  // D49: a failed read changes nothing — the prior readiness stands.
  const key = cameraSensorRefKey(ref)
  return prior?.inputs.find((i) => cameraSensorRefKey(i.ref) === key)?.ready ?? false
}

/** Status in config order; inputs sorted by device id and deduplicated (the first in config order wins, and a dropped one is said). */
function assemble(
  cameraId: number,
  logger: IScopedLogger,
  config: CameraSensorsConfig,
  outcomes: ReadonlyMap<string, RefOutcome>,
  caps: SourceCapsRead,
  prior: CameraSensorsResolution | null,
): CameraSensorsResolution {
  const judged = config.sensors.map((ref) => {
    const verdict = judgeRef(ref, outcomes.get(cameraSensorRefKey(ref)), caps)
    return { ref, ...verdict, ready: readinessOf(verdict.attachment, ref, prior) }
  })
  const routed = judged.flatMap((j): ResolvedCameraSensor[] =>
    j.deviceId === null
      ? []
      : [{ ref: j.ref, deviceId: j.deviceId, mode: j.ref.mode, ready: j.ready }],
  )
  const kept = new Map<number, ResolvedCameraSensor>()
  for (const input of routed) {
    const winner = kept.get(input.deviceId)
    if (winner === undefined) {
      kept.set(input.deviceId, input)
      continue
    }
    // Two refs on one device (a reused id): only one can drive it. Never a silent drop (D391).
    logger.warn('camera-sensors: input dropped — another ref resolves to the same device', {
      tags: { deviceId: cameraId },
      meta: {
        sensor: cameraSensorRefKey(input.ref),
        mode: input.mode,
        sensorDeviceId: input.deviceId,
        kept: cameraSensorRefKey(winner.ref),
        keptMode: winner.mode,
      },
    })
  }
  const inputs = [...kept.values()].sort((a, b) => a.deviceId - b.deviceId)
  return {
    status: {
      state: 'configured',
      sensors: judged.map((j) => j.attachment),
      cameraMotion: cameraOwnMotionRule(judged.map((j) => ({ mode: j.ref.mode, ready: j.ready }))),
    },
    inputs,
  }
}

async function readSourceCaps(
  cameraId: number,
  outcomes: ReadonlyMap<string, RefOutcome>,
  ports: CameraSensorsResolverPorts,
): Promise<SourceCapsRead> {
  const foundIds = [...outcomes.values()].flatMap((o) => (o.kind === 'found' ? [o.row.id] : []))
  if (foundIds.length === 0) return { kind: 'caps', byDevice: new Map() }
  const caps = await ports.sourceCapsOf(foundIds)
  if (caps.kind === 'unreadable') logReadFailure(ports, cameraId, 'sourceCapsOf', caps.error)
  return caps
}

export async function resolveCameraSensors(
  cameraId: number,
  setting: CameraSensorsSetting,
  prior: CameraSensorsResolution | null,
  ports: CameraSensorsResolverPorts,
): Promise<CameraSensorsResolution> {
  if (setting.state === 'not-configured') return NOT_CONFIGURED_RESOLUTION
  if (setting.state === 'unreadable') {
    const keptInputs = prior?.inputs ?? []
    ports.logger.warn('camera-sensors: settings unreadable — keeping the previous mapping', {
      tags: { deviceId: cameraId },
      meta: { reason: setting.reason, keptInputs: keptInputs.map((i) => i.deviceId) },
    })
    return { status: { state: 'unreadable', reason: setting.reason }, inputs: keptInputs }
  }
  const configuredKeys = new Set(setting.config.sensors.map(cameraSensorRefKey))
  const known = (prior?.inputs ?? []).filter((input) =>
    configuredKeys.has(cameraSensorRefKey(input.ref)),
  )
  const knownOutcomes = await readKnown(cameraId, known, ports)
  const unresolved = setting.config.sensors.flatMap((ref): readonly UnresolvedRef[] => {
    const outcome = knownOutcomes.get(cameraSensorRefKey(ref))
    if (outcome === undefined) return [{ ref, priorDeviceId: null }]
    return outcome.kind === 'gone' ? [{ ref, priorDeviceId: outcome.deviceId }] : []
  })
  const addonOutcomes = await readByAddon(cameraId, unresolved, ports)
  const outcomes = new Map<string, RefOutcome>([
    ...[...knownOutcomes].flatMap(([key, o]) => (o.kind === 'gone' ? [] : [[key, o] as const])),
    ...addonOutcomes,
  ])
  const caps = await readSourceCaps(cameraId, outcomes, ports)
  return assemble(cameraId, ports.logger, setting.config, outcomes, caps, prior)
}

/** A device-manager row, field by field: nothing else from the row is kept. */
function toSensorRow(row: DeviceInfo): CameraSensorDeviceRow {
  return {
    id: row.id,
    addonId: row.addonId,
    stableId: row.stableId,
    name: row.name,
    online: row.online,
    disabled: row.disabled,
    isCamera: row.isCamera,
  }
}

/** One wrapped API call: its value, or why it could not be read. */
type ApiRead<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }

/** `getBindingsBatch`'s answer, as the API types it. */
type BindingsBatchAnswer = Awaited<
  ReturnType<AddonApi['deviceManager']['getBindingsBatch']['query']>
>

/** Only the source caps a device binds; `kind` is never read (D13). */
function toSourceCaps(entries: BindingsBatchAnswer): ReadonlyMap<number, readonly string[]> {
  return new Map(
    entries.map((entry): readonly [number, readonly string[]] => [
      entry.deviceId,
      [...new Set(entry.entries.map((e) => e.capName).filter(isSourceCap))].sort(),
    ]),
  )
}

/**
 * The resolver's ports over the hub API. Every call is wrapped: a throw — no
 * API yet, a timeout, a refused call — is `unreadable`, which the resolver
 * turns into "the previous mapping stands" (D49). No call is retried here;
 * the next lifecycle event re-asks (D3).
 */
export function buildCameraSensorsPorts(
  api: () => AddonApi | null | undefined,
  logger: IScopedLogger,
): CameraSensorsResolverPorts {
  const withApi = async <T>(read: (a: AddonApi) => Promise<T>): Promise<ApiRead<T>> => {
    try {
      const current = api()
      if (current === null || current === undefined)
        return { ok: false, error: 'no api in this context' }
      return { ok: true, value: await read(current) }
    } catch (err: unknown) {
      return { ok: false, error: errMsg(err) }
    }
  }
  const rows = async (
    read: (a: AddonApi) => Promise<readonly DeviceInfo[]>,
  ): Promise<DeviceRowsRead> => {
    const result = await withApi(read)
    return result.ok
      ? { kind: 'rows', rows: result.value.map(toSensorRow) }
      : { kind: 'unreadable', error: result.error }
  }
  return {
    logger,
    listByAddon: (addonId) =>
      rows((a) => a.deviceManager.listAll.query({ addonId, projection: 'slim' })),
    listByIds: (deviceIds) =>
      rows((a) => a.deviceManager.listAll.query({ deviceIds: [...deviceIds], projection: 'slim' })),
    sourceCapsOf: async (deviceIds) => {
      const result = await withApi((a) =>
        a.deviceManager.getBindingsBatch.query({ deviceIds: [...deviceIds] }),
      )
      return result.ok
        ? { kind: 'caps', byDevice: toSourceCaps(result.value) }
        : { kind: 'unreadable', error: result.error }
    },
  }
}
