import type { CgiChannelStatusEntry, ReolinkBaichuanApi } from '@apocaliss92/nodelink-js'
import type { BatteryStatus, IScopedLogger } from '@camstack/types'
import { z } from 'zod'
import { resolveSnapshotAge, type SnapshotAge } from './snapshot-freshness.js'
import type { ReolinkCameraConfig } from './schema.js'

/**
 * Raw-read debug surface (D346): "what does the camera actually report,
 * versus what CamStack believes?"
 *
 * Every `deviceCache.*Snapshot` group is a PROJECTION — the probe keeps a
 * handful of fields and discards the rest of the camera's answer at read
 * time. When the settings form and the camera disagree (the OSD overlay
 * bug: form said ON, camera said OFF), the camera's own answer used to be
 * unrecoverable without Baichuan tracing. This module returns the
 * library's response UNPROJECTED, as plain JSON, side by side with the
 * persisted snapshot and its freshness, for inspection only.
 *
 * Safety properties, by construction — not by discipline:
 *   - **Read-only.** The catalog below is the complete set of commands
 *     this surface can issue; every entry is a lib `get*` read. The input
 *     names a SLICE (a closed enum), never a command string, so no write
 *     and no un-vetted read is reachable through this path.
 *   - **Secret-free by allow-list.** The catalog is the allow-list: each
 *     command in it was vetted to carry no auth material in its reply.
 *     The email/SMTP read (`getEmail`) is deliberately ABSENT — its reply
 *     echoes the camera's SMTP credentials. The device config (which
 *     carries `password`) is never consulted for the payload; only the
 *     projection snapshot for the requested slice is read back, and no
 *     snapshot in the slice map stores credentials.
 *   - **Never wakes a sleeping battery camera.** The sleep gate runs
 *     BEFORE any login (`ensureApi` on a sleeping UDP cam IS the wake);
 *     a sleeping camera refuses loudly and still reports what CamStack
 *     believes, with its age. The one exemption is a read the PARENT HUB
 *     answers on its own mains-powered socket without addressing the
 *     channel (`servedByParentHub` + `hubChild`) — that read costs the
 *     camera nothing, and refusing it would hide the only battery value
 *     that still moves while a hub child sleeps.
 *
 * Dispatched as the admin-only `debugRawRead` addon custom action (see
 * `debug-actions.ts`) — `addons.custom` is the one operator surface that
 * enforces per-action `auth: 'admin'` server-side and validates output.
 */

type ReolinkDeviceCache = NonNullable<ReolinkCameraConfig['deviceCache']>

/**
 * The lib surface this module is allowed to touch. A structural `Pick` so
 * tests can fake exactly these methods — and so a write method showing up
 * in the catalog is a TYPE error, not a review finding.
 */
export type RawReadApi = Pick<
  ReolinkBaichuanApi,
  | 'getVideoInput'
  | 'getMotionAlarm'
  | 'getAiDetectTypes'
  | 'getAiDetectionFull'
  | 'getEnc'
  | 'getEncOptions'
  | 'getMask'
  | 'getAudioNoise'
  | 'getAutoFocus'
  | 'getNetPort'
  | 'getNtp'
  | 'getSystemGeneral'
  | 'getOsd'
  | 'getOsdDatetime'
  | 'getIrLights'
  | 'getPirInfo'
  | 'getAutoReboot'
  | 'getBatteryInfo'
  | 'getAllChannelsBatteryInfo'
>

/**
 * Facts beyond the channel that an entry may need to choose HOW to read.
 * Only `battery` uses it today: the same question ("what is the charge
 * state?") is answered by two different firmware calls depending on whether
 * the camera hangs off a Hub. Passing it as a third argument keeps the
 * fifteen single-call entries on the signature they already had.
 */
export interface RawReadInvokeContext {
  /** True when the camera is a child of a Reolink Hub/NVR — `api` is then
   *  the parent's socket, not the camera's own. */
  readonly hubChild: boolean
}

/**
 * WHERE CamStack's belief about a slice lives.
 *
 * A discriminated union rather than one nullable `snapshotKey`, because the
 * two homes are not interchangeable and neither is optional:
 *
 *   - fifteen slices are Baichuan reads whose projection is persisted in
 *     `deviceCache.<snapshotKey>` and aged from the freshness stamp map;
 *   - `battery` has **no deviceCache field at all**. What CamStack believes
 *     about charge is the `battery` capability's runtime-state slice — the
 *     very thing `battery.getStatus` serves. Inventing a `batterySnapshot`
 *     cache key just to satisfy `keyof ReolinkDeviceCache` would have made
 *     the type lie about the system: nothing reads or writes such a field.
 *
 * The field is REQUIRED on every entry: a slice that cannot name where its
 * belief lives cannot answer "camera vs CamStack", which is the whole point
 * of the surface, so an entry that omits it must not compile.
 */
export type BelievedSource =
  | {
      readonly kind: 'deviceCache'
      readonly snapshotKey: keyof ReolinkDeviceCache & string
    }
  | {
      readonly kind: 'capRuntimeState'
      /** Only `battery` today; a literal so the reader is exhaustive. */
      readonly capName: 'battery'
    }

interface RawReadCatalogEntry {
  /** The lib call(s) behind the slice, for the operator's eyes. */
  readonly command: string
  /** Where CamStack's side of the comparison is read from. */
  readonly believed: BelievedSource
  /**
   * `true` when the read is answered by the PARENT HUB's own CGI over the
   * hub's mains-powered socket and never reaches the camera channel — so it
   * is safe while the camera sleeps, and the sleep gate does not apply to a
   * hub CHILD (a standalone camera still has to log itself in, which IS the
   * wake, so the exemption is `hubChild && servedByParentHub`).
   *
   * Optional on purpose, unlike `believed`: this is an exemption from a
   * safety gate, so the ABSENT value must be the conservative one. An entry
   * added later that forgets the flag refuses while asleep — the wrong
   * default here costs a battery, not a debug read.
   */
  readonly servedByParentHub?: true
  /**
   * Hardware this read REQUIRES. Absent means "every camera has it".
   *
   * Not a capability probe of its own: it names the part, and the caller
   * answers from the feature probe it already ran. A read the hardware cannot
   * answer is refused with a reason an operator can act on, rather than
   * surfacing as a failure that reads like a fault.
   */
  readonly needs?: 'ptz'
  /** Issue the read(s). MUST only call `get*` members of {@link RawReadApi}. */
  readonly invoke: (api: RawReadApi, channel: number, ctx: RawReadInvokeContext) => Promise<unknown>
}

/** Slice names — mirror `SnapshotSlice` in `reolink-camera.ts` (plus
 *  `encOptions`, which rides the `enc` slice there, and `battery`, which
 *  has no deviceCache projection at all — see {@link BelievedSource}). */
export const RAW_READ_SLICE_NAMES = [
  'image',
  'motion',
  'ai',
  'enc',
  'encOptions',
  'mask',
  'audioNoise',
  'autofocus',
  'netPort',
  'ntp',
  'systemGeneral',
  'osd',
  'led',
  'pir',
  'autoReboot',
  'battery',
] as const

export const RawReadSliceSchema = z.enum(RAW_READ_SLICE_NAMES)
export type RawReadSlice = z.infer<typeof RawReadSliceSchema>

/**
 * The allow-list. `Record<RawReadSlice, …>` keeps the catalog and the enum
 * in lockstep in both directions. Anything not in this map — email/SMTP
 * (`getEmail` echoes the camera's SMTP credentials), users, sessions, any
 * `set*` — cannot be requested.
 */
export const RAW_READ_CATALOG: Readonly<Record<RawReadSlice, RawReadCatalogEntry>> = {
  image: {
    command: 'getVideoInput',
    believed: { kind: 'deviceCache', snapshotKey: 'imageSnapshot' },
    invoke: (api, channel) => api.getVideoInput(channel),
  },
  motion: {
    command: 'getMotionAlarm',
    believed: { kind: 'deviceCache', snapshotKey: 'motionSnapshot' },
    invoke: (api, channel) => api.getMotionAlarm(channel),
  },
  ai: {
    command: 'getAiDetectTypes + getAiDetectionFull (per type)',
    believed: { kind: 'deviceCache', snapshotKey: 'aiSensitivitySnapshot' },
    invoke: async (api, channel) => {
      const detectTypes = await api.getAiDetectTypes(channel, { timeoutMs: 1500 })
      const perType: Record<string, unknown> = {}
      for (const aiType of detectTypes ?? []) {
        try {
          perType[aiType] = await api.getAiDetectionFull(channel, aiType)
        } catch (err) {
          perType[aiType] = { error: err instanceof Error ? err.message : String(err) }
        }
      }
      return { detectTypes: detectTypes ?? [], perType }
    },
  },
  enc: {
    command: 'getEnc',
    believed: { kind: 'deviceCache', snapshotKey: 'encSnapshot' },
    invoke: (api, channel) => api.getEnc(channel),
  },
  encOptions: {
    command: 'getEncOptions',
    believed: { kind: 'deviceCache', snapshotKey: 'encOptionsSnapshot' },
    invoke: (api, channel) => api.getEncOptions(channel),
  },
  mask: {
    command: 'getMask',
    believed: { kind: 'deviceCache', snapshotKey: 'maskSnapshot' },
    invoke: (api, channel) => api.getMask(channel),
  },
  audioNoise: {
    command: 'getAudioNoise',
    believed: { kind: 'deviceCache', snapshotKey: 'audioNoiseSnapshot' },
    invoke: (api, channel) => api.getAudioNoise(channel),
  },
  autofocus: {
    command: 'getAutoFocus',
    believed: { kind: 'deviceCache', snapshotKey: 'autoFocusSnapshot' },
    // A focus motor is a PTZ camera's part. cmd 224 appears in NEITHER packet
    // capture of the Reolink app taken on 2026-09-19 — the app never asks a
    // fixed-focus camera about a motor it does not have — and asking anyway
    // earns a 400, retried three times at 1.5 s apiece. Measured on 3825, the
    // only one of sixteen reads that failed.
    needs: 'ptz',
    invoke: (api, channel) => api.getAutoFocus(channel, { timeoutMs: 1500 }),
  },
  netPort: {
    command: 'getNetPort',
    believed: { kind: 'deviceCache', snapshotKey: 'netPortSnapshot' },
    invoke: (api) => api.getNetPort(),
  },
  ntp: {
    command: 'getNtp',
    believed: { kind: 'deviceCache', snapshotKey: 'ntpSnapshot' },
    invoke: (api) => api.getNtp(),
  },
  systemGeneral: {
    command: 'getSystemGeneral',
    believed: { kind: 'deviceCache', snapshotKey: 'systemGeneralSnapshot' },
    invoke: (api) => api.getSystemGeneral(),
  },
  /**
   * OSD — `getOsdDatetime` (cmd_id 44) is the RAW form of the read the
   * driver uses, so an operator sees the camera's own `<OsdDatetime>` +
   * `<OsdChannelName>` fields before any projection. The driver itself now
   * calls `getOsd`, which is the same command decoded into corners
   * (`@apocaliss92/nodelink-js` 0.7.0 — before that it was a placeholder on
   * cmd_id 26 and every camera reported the same fabricated tuple).
   */
  osd: {
    command: 'getOsdDatetime',
    believed: { kind: 'deviceCache', snapshotKey: 'osdSnapshot' },
    invoke: (api, channel) => api.getOsdDatetime(channel, { timeoutMs: 4000 }),
  },
  led: {
    command: 'getIrLights',
    believed: { kind: 'deviceCache', snapshotKey: 'ledSnapshot' },
    invoke: (api, channel) => api.getIrLights(channel),
  },
  pir: {
    command: 'getPirInfo',
    believed: { kind: 'deviceCache', snapshotKey: 'pirSnapshot' },
    invoke: (api, channel) => api.getPirInfo(channel),
  },
  autoReboot: {
    command: 'getAutoReboot',
    believed: { kind: 'deviceCache', snapshotKey: 'autoRebootSnapshot' },
    invoke: (api) => api.getAutoReboot(),
  },
  /**
   * Battery — one slice, TWO firmware reads, chosen by how the camera is
   * attached. They are not variants of one call:
   *
   *   - **standalone**: `getBatteryInfo(channel)` — the camera's own
   *     answer, one `BatteryInfo`;
   *   - **hub child**: `getAllChannelsBatteryInfo()` — a HUB-level CGI
   *     keyed by channel, projected to the requested one here so the slice
   *     stays per-camera like the other fifteen (a "cluster-wide" second
   *     slice shape would have to be understood by every caller).
   *
   * Both vocabularies carry `adapterStatus` next to `chargeStatus`, which
   * is why this slice exists: the provider keeps only the latter, and
   * whether `adapterStatus` MOVES was previously observable exactly once
   * per hub process (`ReolinkHub.batteryShapeLogged`). The answer is
   * returned as the firmware gave it, under a `readVia` that names the path
   * — NOT normalised into a shared shape. The paths do not carry the same
   * fields (`voltage`/`lowPower` on the camera read, `channelsReported` and
   * the channel-status row on the hub read); a field the firmware did not
   * send must be ABSENT, because a default here would be indistinguishable
   * from a reading (D315).
   *
   * A camera that cannot answer at all throws, and the read comes back
   * `read-failed` carrying the firmware's reason — "we could not read it"
   * must never be served as "it has no battery".
   */
  battery: {
    command: 'getBatteryInfo (standalone) / getAllChannelsBatteryInfo projected (hub child)',
    believed: { kind: 'capRuntimeState', capName: 'battery' },
    servedByParentHub: true,
    invoke: async (api, channel, ctx) => {
      if (!ctx.hubChild) {
        // The camera answers for itself. Verbatim — no key is added to or
        // removed from what the firmware sent.
        const info = await api.getBatteryInfo(channel)
        return { readVia: 'camera', command: 'getBatteryInfo', channel, batteryInfo: info }
      }
      const data = await api.getAllChannelsBatteryInfo()
      const byChannel = data.batteryInfoData
      const channelsReported = Object.keys(byChannel)
        .map(Number)
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b)
      const info = byChannel[channel]
      if (info === undefined) {
        throw new Error(
          `getAllChannelsBatteryInfo answered for channels [${channelsReported.join(', ')}] but not channel ${channel} — this camera's battery was NOT reported. That is an unanswered read, not "no battery".`,
        )
      }
      const [cgiBattery, channelStatus] = info.entries
      return {
        readVia: 'parentHub',
        command: 'getAllChannelsBatteryInfo',
        channel,
        channelsReported,
        // The hub's row verbatim except the channel-status `uid`; the
        // battery entry (where `adapterStatus` lives) is untouched.
        batteryInfo: {
          ...info,
          entries: [cgiBattery ?? null, redactChannelIdentity(channelStatus)],
        },
      }
    },
  },
} as const

/**
 * The hub's channel-status row (`entries[1]`) carries the camera's Reolink
 * P2P `uid` — a routable cloud identifier for the device. A charge-state
 * read has no reason to hand it out, so it is dropped here rather than
 * relied on not to be looked at. The drop is STATED (`uidRedacted`): a
 * removed field and a firmware that never sent one must not look alike.
 * Everything else in the row (channel, name, online, sleep, typeInfo) is
 * kept verbatim — it is the context that makes the battery row readable.
 */
function redactChannelIdentity(entry: CgiChannelStatusEntry | undefined): unknown {
  if (entry === undefined) return null
  const { uid, ...rest } = entry
  return { ...rest, uidRedacted: uid !== undefined }
}

/**
 * Age of a `capRuntimeState` belief. The cap slice carries `lastUpdated`
 * rather than a freshness-map stamp, and its `empty` seed is `0` — which is
 * NOT an observation, so it resolves to `never`. A slice that was never
 * written at all is `never` too: on a battery reading, "we hold no value"
 * and "we measured 0%" are an alarm apart (see `BatteryStatusSchema`).
 */
function capStateAge(state: BatteryStatus | undefined, now: number): SnapshotAge {
  if (state === undefined) return { state: 'never' }
  const lastUpdated = state.lastUpdated
  if (typeof lastUpdated !== 'number' || lastUpdated <= 0) return { state: 'never' }
  return { state: 'known', fetchedAt: lastUpdated, ageMs: Math.max(0, now - lastUpdated) }
}

/** What CamStack currently believes about the slice, with its own age. */
const BelievedStateSchema = z.object({
  /** The persisted projection / cap slice, verbatim. */
  snapshot: z.unknown(),
  /** Where that belief lives — mirrors {@link BelievedSource}. */
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('deviceCache'), snapshotKey: z.string() }),
    z.object({ kind: z.literal('capRuntimeState'), capName: z.literal('battery') }),
  ]),
  /** Tri-state freshness — `never` / `unknown` (legacy, no stamp) / `known`. */
  age: z.union([
    z.object({ state: z.literal('never') }),
    z.object({ state: z.literal('unknown') }),
    z.object({
      state: z.literal('known'),
      fetchedAt: z.number().int(),
      ageMs: z.number().int().nonnegative(),
    }),
  ]),
})

export const RawReadResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    deviceId: z.number().int(),
    slice: RawReadSliceSchema,
    command: z.string(),
    readAt: z.number().int(),
    /** The library's response, unprojected, as plain JSON. */
    camera: z.unknown(),
    believed: BelievedStateSchema,
  }),
  z.object({
    ok: z.literal(false),
    deviceId: z.number().int(),
    slice: RawReadSliceSchema,
    reason: z.enum(['sleeping', 'unsupported', 'login-failed', 'read-failed']),
    message: z.string(),
    /** The believed state is still reported — a refusal must not hide
     *  what CamStack is currently serving. */
    believed: BelievedStateSchema,
  }),
])
export type RawReadResult = z.infer<typeof RawReadResultSchema>

export const RawReadInputSchema = z.object({
  deviceId: z.number().int().nonnegative(),
  slice: RawReadSliceSchema,
})
export type RawReadInput = z.infer<typeof RawReadInputSchema>

/** Dependencies `performRawRead` needs from the camera — injected so the
 *  orchestration is unit-testable without a `ReolinkCamera`. */
export interface RawReadDeps {
  readonly deviceId: number
  readonly channel: number
  /** True when this is a battery camera currently believed asleep. The gate
   *  MUST be evaluated before `getApi` — login is the wake. */
  readonly sleeping: boolean
  /**
   * True when this camera is a child of a Reolink Hub/NVR. Its `getApi`
   * then borrows the parent's already-open, mains-powered socket instead of
   * logging the camera in, which is what makes a `servedByParentHub` read
   * safe on a sleeping child.
   */
  readonly hubChild: boolean
  /** Whether this camera's feature probe found a pan/tilt/zoom head. */
  readonly hasPtz: boolean
  /** Lazily acquire the live api. Never called when a gate refuses. */
  readonly getApi: () => Promise<RawReadApi>
  readonly cache: ReolinkDeviceCache | undefined
  /**
   * The `battery` cap's runtime-state slice, or `undefined` when the cap
   * holds nothing for this device. `undefined` means NOT KNOWN — it must
   * never be substituted with the schema's `empty` seed, which reads as a
   * measured 0%.
   */
  readonly batteryState: BatteryStatus | undefined
  readonly logger: IScopedLogger
  readonly now: number
}

function believedState(
  deps: RawReadDeps,
  entry: RawReadCatalogEntry,
): z.infer<typeof BelievedStateSchema> {
  const source = entry.believed
  if (source.kind === 'capRuntimeState') {
    return {
      snapshot: toPlainJson(deps.batteryState),
      source,
      age: capStateAge(deps.batteryState, deps.now),
    }
  }
  const age: SnapshotAge = resolveSnapshotAge(deps.cache, source.snapshotKey, deps.now)
  const snapshot: unknown =
    deps.cache === undefined ? undefined : Reflect.get(deps.cache, source.snapshotKey)
  return { snapshot: toPlainJson(snapshot), source, age }
}

/** Force a lib response to plain JSON: drops functions/undefined/prototypes,
 *  guarantees the payload is serializable across the tRPC boundary. */
function toPlainJson(value: unknown): unknown {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value)) as unknown
}

/**
 * Execute one raw read. Order matters:
 *   1. sleep gate (refuse loudly — logging in would BE the wake);
 *   2. login;
 *   3. the allow-listed read;
 * and every outcome — refusal included — carries the believed state so the
 * operator always sees both sides of the comparison.
 */
export async function performRawRead(
  slice: RawReadSlice,
  deps: RawReadDeps,
): Promise<RawReadResult> {
  const entry = RAW_READ_CATALOG[slice]
  const believed = believedState(deps, entry)
  // The gate protects the CAMERA's radio, not the process. A read the
  // parent hub answers on its own socket never reaches the sleeping
  // channel — refusing it would hide the only battery reading that still
  // moves while a hub child sleeps. A standalone camera has no such
  // shortcut: its own login IS the wake, so the exemption needs both.
  if (entry.needs === 'ptz' && !deps.hasPtz) {
    // Refused before the sleep gate and before `getApi`: this one needs no
    // radio to answer, because the answer is about the hardware.
    deps.logger.info('reolink raw read refused — the camera has no PTZ head', {
      tags: { deviceId: deps.deviceId },
      meta: { slice },
    })
    return {
      ok: false,
      deviceId: deps.deviceId,
      slice,
      reason: 'unsupported',
      message:
        `This camera has no pan/tilt/zoom head, so it has no focus motor and no "${slice}" to ` +
        'read — the Reolink app does not ask it either. Nothing is wrong with the camera.',
      believed,
    }
  }
  const servedWithoutTouchingCamera = deps.hubChild && entry.servedByParentHub === true
  if (deps.sleeping && !servedWithoutTouchingCamera) {
    deps.logger.info('reolink raw read refused — battery cam is sleeping', {
      tags: { deviceId: deps.deviceId },
      meta: { slice },
    })
    return {
      ok: false,
      deviceId: deps.deviceId,
      slice,
      reason: 'sleeping',
      message: deps.hubChild
        ? `Battery camera is asleep and the "${slice}" read is addressed to the camera channel, which would wake it — refused. The believed state below is what CamStack currently serves. (The "battery" slice is answered by the parent hub and stays readable while the camera sleeps.)`
        : 'Battery camera is asleep — a raw read would wake it, so it is refused. The believed state below is what CamStack currently serves.',
      believed,
    }
  }
  let api: RawReadApi
  try {
    api = await deps.getApi()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    deps.logger.info('reolink raw read login failed', {
      tags: { deviceId: deps.deviceId },
      meta: { slice, error: message },
    })
    return { ok: false, deviceId: deps.deviceId, slice, reason: 'login-failed', message, believed }
  }
  try {
    const payload = await entry.invoke(api, deps.channel, { hubChild: deps.hubChild })
    deps.logger.info('reolink raw read served', {
      tags: { deviceId: deps.deviceId },
      meta: {
        slice,
        command: entry.command,
        // Says whether the camera's radio was involved — the difference
        // between a free read and one that cost a wake.
        viaParentHub: servedWithoutTouchingCamera,
        cameraWasSleeping: deps.sleeping,
      },
    })
    return {
      ok: true,
      deviceId: deps.deviceId,
      slice,
      command: entry.command,
      readAt: deps.now,
      camera: toPlainJson(payload),
      believed,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    deps.logger.info('reolink raw read failed', {
      tags: { deviceId: deps.deviceId },
      meta: { slice, command: entry.command, error: message },
    })
    return { ok: false, deviceId: deps.deviceId, slice, reason: 'read-failed', message, believed }
  }
}
