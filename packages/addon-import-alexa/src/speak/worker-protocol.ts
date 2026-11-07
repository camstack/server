/** Line-delimited JSON the long-lived Python worker speaks. One object per line. */
import { z } from 'zod'
import { ALEXA_REGIONS, SPEAK_MODES } from './constants.js'

export const EchoDeviceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  family: z.string(),
  online: z.boolean(),
  kind: z.enum(['device', 'group']),
  dnd: z.boolean(),
  deviceType: z.string(),
  /** The room the account files the device under, when Amazon names one. */
  room: z.string().optional(),
  /** Serials of the speaker groups this device belongs to (Amazon's `parentClusters`); absent when none. */
  parentClusters: z.array(z.string()).optional(),
})
export type EchoDevice = z.infer<typeof EchoDeviceSchema>

export const LoginStatusSchema = z.enum(['ok', 'failed'])
export type LoginStatus = z.infer<typeof LoginStatusSchema>

export const SessionStatusSchema = z.object({
  loggedIn: z.boolean(),
  ageSec: z.number().int().nonnegative(),
  lastSuccessAt: z.number().int().nullable(),
})
export type SessionStatus = z.infer<typeof SessionStatusSchema>

export const TargetDeliverySchema = z.object({
  targetId: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
})
export type TargetDelivery = z.infer<typeof TargetDeliverySchema>

const WorkerOkSchema = z.object({
  id: z.string(),
  ok: z.literal(true),
  result: z.unknown().optional(),
})

const WorkerErrSchema = z.object({
  id: z.string(),
  ok: z.literal(false),
  error: z.string(),
  /** A typed reason the worker names; `rate-limited` is Amazon's 429. */
  code: z.string().optional(),
})

export const WorkerLineSchema = z.union([WorkerOkSchema, WorkerErrSchema])
export type WorkerLine = z.infer<typeof WorkerLineSchema>

/**
 * Unsolicited lines: the worker's push channel (Amazon's HTTP/2 stream). They carry no
 * `id`. Only the event name and the Echo's serial cross the pipe; the addon re-reads
 * the Echo, so nothing Amazon put in a payload is trusted or forwarded.
 */
export const WorkerPushChannelSchema = z.object({
  push: z.literal('channel'),
  state: z.enum(['up', 'down']),
  reason: z.string().default(''),
  /** How long until the worker opens the channel again; 0 when it is up. */
  retryInMs: z.number().int().nonnegative().default(0),
})
export type WorkerPushChannel = z.infer<typeof WorkerPushChannelSchema>

export const WorkerPushEventSchema = z.object({
  push: z.literal('event'),
  command: z.string().min(1),
  /** The Echo the event is about; null when Amazon named none. */
  serial: z.string().min(1).nullable(),
})
export type WorkerPushEvent = z.infer<typeof WorkerPushEventSchema>

export const WorkerPushSchema = z.discriminatedUnion('push', [
  WorkerPushChannelSchema,
  WorkerPushEventSchema,
])
export type WorkerPush = z.infer<typeof WorkerPushSchema>

/** Push events that change what an Echo's slice shows: the addon reads that Echo once. */
export const PUSH_READ_COMMANDS: ReadonlySet<string> = new Set([
  'PUSH_AUDIO_PLAYER_STATE',
  'PUSH_MEDIA_CHANGE',
  'PUSH_VOLUME_CHANGE',
  'PUSH_DOPPLER_CONNECTION_CHANGE',
])

/**
 * Push events Amazon sends that the slice does not need: progress ticks every few
 * seconds while playing (the position is derived from `positionUpdatedAt`), and the
 * notification / equalizer changes touch nothing the media-player shows.
 */
export const PUSH_IGNORED_COMMANDS: ReadonlySet<string> = new Set([
  'PUSH_MEDIA_PROGRESS_CHANGE',
  'PUSH_NOTIFICATION_CHANGE',
  'PUSH_EQUALIZER_STATE_CHANGE',
])

export const RATE_LIMITED_CODE = 'rate-limited'

/** Amazon answered 429. Never an empty answer: the caller backs off and keeps what it had. */
export class RateLimitedError extends Error {
  readonly code = RATE_LIMITED_CODE
  constructor(message: string) {
    super(message)
    this.name = 'RateLimitedError'
  }
}

/** Amazon's shuffle and repeat are booleans: there is no repeat-one command. */
export const NP_COMMANDS = [
  'play',
  'pause',
  'next',
  'previous',
  'shuffle-on',
  'shuffle-off',
  'repeat-on',
  'repeat-off',
] as const
export type NpCommand = (typeof NP_COMMANDS)[number]

export type WorkerRequest =
  | {
      /**
       * Sign in as the broker's Amazon account. `refreshTokenPath` names an
       * owner-only file with the broker's refresh token ('' when the broker has
       * none, so only the stored `sessionPath` jar can be tried).
       */
      readonly op: 'login_broker'
      readonly label: string
      readonly refreshTokenPath: string
      readonly deviceAppName: string
      readonly domain: string
      readonly sessionPath: string
      readonly region: (typeof ALEXA_REGIONS)[number]
    }
  | { readonly op: 'devices' }
  | {
      readonly op: 'speak' | 'announce'
      readonly targets: readonly string[]
      readonly text: string
    }
  | { readonly op: 'session_status' }
  | {
      readonly op: 'player_state'
      readonly serial: string
      readonly deviceType: string
    }
  | {
      readonly op: 'np_command'
      readonly serial: string
      readonly command: NpCommand
    }
  | {
      readonly op: 'set_volume'
      readonly serial: string
      readonly level: number
    }
  | { readonly op: 'dnd_state' }
  | { readonly op: 'device_volumes' }
  | {
      readonly op: 'set_dnd'
      readonly serial: string
      readonly enabled: boolean
    }

export function requestLine(id: string, request: WorkerRequest): string {
  return `${JSON.stringify({ id, ...request })}\n`
}

export interface LoginStartResult {
  readonly status: LoginStatus
  readonly error?: string
}

export function parseLoginResult(result: unknown): LoginStartResult {
  const parsed = z
    .object({ status: LoginStatusSchema, error: z.string().optional() })
    .safeParse(result)
  if (!parsed.success)
    return { status: 'failed', error: 'worker returned an unexpected login result' }
  return parsed.data
}

export function parseDevices(result: unknown): readonly EchoDevice[] {
  const parsed = z.object({ devices: z.array(EchoDeviceSchema) }).safeParse(result)
  if (!parsed.success) throw new Error('worker returned an unexpected device list')
  return parsed.data.devices
}

export function parseDeliveries(result: unknown): readonly TargetDelivery[] {
  const parsed = z.object({ outcomes: z.array(TargetDeliverySchema) }).safeParse(result)
  if (!parsed.success) throw new Error('worker returned an unexpected delivery list')
  return parsed.data.outcomes
}

export function parseSessionStatus(result: unknown): SessionStatus {
  const parsed = SessionStatusSchema.safeParse(result)
  if (!parsed.success) throw new Error('worker returned an unexpected session status')
  return parsed.data
}

/**
 * A reading Amazon sent in a shape we did not expect is a reading we do not have
 * (null), never a reason to discard the rest of the player: one odd field used to
 * fail the whole read and the Echo kept showing nothing.
 */
const text = z.string().nullish().catch(null)
const flag = z.boolean().nullish().catch(null)
const count = z.number().nullish().catch(null)

/**
 * The raw `playerInfo` of `/api/np/player`. Amazon omits what it does not know,
 * so every field is nullable; the mapping to the media-player cap turns a missing
 * value into null, never into 0 (D393). Every block and every leaf is read on its
 * own: a block of the wrong type is null, the others still count.
 */
export const PlayerInfoSchema = z.object({
  state: text,
  volume: z.object({ volume: count, muted: flag }).nullish().catch(null),
  infoText: z.object({ title: text, subText1: text, subText2: text }).nullish().catch(null),
  mainArt: z.object({ url: text }).nullish().catch(null),
  progress: z.object({ mediaLength: count, mediaProgress: count }).nullish().catch(null),
  provider: z.object({ providerName: text, providerDisplayName: text }).nullish().catch(null),
  transport: z.object({ shuffle: text, repeat: text }).nullish().catch(null),
})
export type PlayerInfo = z.infer<typeof PlayerInfoSchema>

/** The playback states Amazon is known to send. */
const KNOWN_PLAYER_STATES: ReadonlySet<string> = new Set(['PLAYING', 'PAUSED', 'BUFFERING', 'IDLE'])

/**
 * A lenient read must not turn garbage into a healthy idle player: when Amazon sent a
 * state we do not recognise (or of the wrong type) and not one block survived, the read
 * is a failure, exactly as before the leniency. A body that says nothing (`{}`, null
 * state) stays an idle player.
 */
export function parsePlayerState(result: unknown): PlayerInfo {
  const parsed = z.object({ playerInfo: PlayerInfoSchema.nullish() }).safeParse(result)
  if (!parsed.success) throw new Error('worker returned an unexpected player state')
  const info = parsed.data.playerInfo ?? {}
  const raw = z.object({ playerInfo: z.object({ state: z.unknown() }).nullish() }).safeParse(result)
  const rawState = raw.success ? raw.data.playerInfo?.state : undefined
  const saidSomething = rawState !== undefined && rawState !== null
  const knownState = typeof info.state === 'string' && KNOWN_PLAYER_STATES.has(info.state)
  const noBlock = [
    info.volume,
    info.infoText,
    info.mainArt,
    info.progress,
    info.provider,
    info.transport,
  ].every((block) => block === null || block === undefined)
  if (saidSomething && !knownState && noBlock) {
    throw new Error('worker returned an unreadable player state')
  }
  return info
}

export const DndEntrySchema = z.object({
  serial: z.string().min(1),
  enabled: z.boolean(),
})

export function parseDndState(result: unknown): ReadonlyMap<string, boolean> {
  const parsed = z.object({ devices: z.array(DndEntrySchema) }).safeParse(result)
  if (!parsed.success) throw new Error('worker returned an unexpected Do Not Disturb list')
  return new Map(parsed.data.devices.map((entry) => [entry.serial, entry.enabled]))
}

export const DeviceVolumeEntrySchema = z.object({
  serial: z.string().min(1),
  volume: z.number().finite().optional(),
  muted: z.boolean().optional(),
})

/** One device's speaker reading from the account's volume list; a field Amazon left out is absent. */
export interface DeviceVolume {
  readonly volume: number | null
  readonly muted: boolean | null
}

export function parseDeviceVolumes(result: unknown): ReadonlyMap<string, DeviceVolume> {
  const parsed = z.object({ devices: z.array(DeviceVolumeEntrySchema) }).safeParse(result)
  if (!parsed.success) throw new Error('worker returned an unexpected device volume list')
  return new Map(
    parsed.data.devices.map((entry) => [
      entry.serial,
      { volume: entry.volume ?? null, muted: entry.muted ?? null },
    ]),
  )
}

export function isSpeakOp(mode: (typeof SPEAK_MODES)[number]): 'speak' | 'announce' {
  return mode === 'announce' ? 'announce' : 'speak'
}
