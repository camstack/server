/**
 * `setup_streams` (read) and `configure_setup_streams` (write): per camera the
 * native profiles (resolution, codec, fps) and the derived streams, which
 * profile slot serves what, the live numbers of each slot (fps, bitrate, IDR
 * interval, subscribers), and a proposal for slots that have no source.
 *
 * Changing a slot restarts that camera's detection (the orchestrator rewires
 * on `onProfileSlotsChanged`), and the dry run says so. A slot number the hub
 * did not answer is `null`, never 0.
 */
import {
  BrokerStatsSchema,
  CameraStreamSchema,
  CamProfileSchema,
  ProfileSlotSchema,
  RecordingConfigSchema,
  type CamProfile,
  type CameraStream,
  type ProfileSlot,
} from '@camstack/types'
import { type DryRunOutcome, type GatedToolSpec, type HubClient } from '@camstack/develop'
import { z } from 'zod'
import { adminGated, type AdminGatedResult } from './configure-common.js'
import type { McpContext } from './context.js'
import { cap, readQuery, withHub, type NoSessionResult, type Read } from './ops-hub.js'
import {
  readCameraRows,
  readCameraStatuses,
  type CameraRow,
  type CameraStatusSlice,
} from './setup-camera-reads.js'
import { CAMERA_LIMIT, mapLimit, proposalId, READ_CONCURRENCY } from './setup-assist-common.js'

export interface StreamStats {
  readonly status: string
  readonly inputFps: number
  readonly bitrateKbps: number
  readonly idrIntervalMs: number
  readonly encodedSubscribers: number
  readonly rtspClients: number
  readonly uptimeMs: number
}

export interface StreamView {
  readonly camStreamId: string
  readonly kind: string
  readonly codec: string | null
  readonly resolution: { readonly width: number; readonly height: number } | null
  readonly fps: number | null
  readonly label: string | null
  /** `null`: the broker stats could not be read — unknown, never 0. */
  readonly stats: StreamStats | null
}

export interface SlotView {
  readonly profile: CamProfile
  readonly status: string
  readonly sourceCamStreamId: string | null
  readonly resolution: { readonly width: number; readonly height: number } | null
  readonly codec: string | null
  readonly error: string | null
  readonly stats: StreamStats | null
}

export interface CameraStreamsView {
  readonly deviceId: number
  readonly name: string
  readonly native: readonly StreamView[]
  readonly derived: readonly StreamView[]
  readonly slots: readonly SlotView[]
  /** Profiles the recorder stores; `null` when the recording config was not read. */
  readonly recordingProfiles: readonly string[] | null
  readonly detection: {
    readonly nodeId: string
    readonly engine: string
    readonly configuredFps: number
    readonly actualFps: number
  } | null
  readonly unavailable: { readonly [part: string]: string }
}

export interface SlotChange {
  readonly deviceId: number
  readonly profile: CamProfile
  /** `null` unassigns the slot. */
  readonly camStreamId: string | null
}

export interface StreamsProposal {
  readonly id: string
  readonly changes: readonly (SlotChange & { readonly reason: string })[]
  readonly notes: readonly string[]
}

export interface SetupStreamsResult {
  readonly status: 'ok'
  readonly cameras: readonly CameraStreamsView[]
  readonly camerasTruncated: number
  readonly proposal: StreamsProposal
  readonly unavailable: { readonly [part: string]: string }
}

const pixels = (s: StreamView): number =>
  s.resolution ? s.resolution.width * s.resolution.height : 0

export const SLOW_IDR_MS = 2500

export function statsOf(parsed: z.infer<typeof BrokerStatsSchema>): StreamStats {
  return {
    status: parsed.status,
    inputFps: parsed.inputFps,
    bitrateKbps: parsed.bitrateKbps,
    idrIntervalMs: parsed.idrIntervalMs,
    encodedSubscribers: parsed.encodedSubscribers,
    rtspClients: parsed.rtspClients,
    uptimeMs: parsed.uptimeMs,
  }
}

export function readBrokerStats(client: HubClient, brokerId: string): Promise<Read<StreamStats>> {
  return readQuery(client, 'streamBroker.getBrokerStats', { brokerId }, BrokerStatsSchema).then(
    (read): Read<StreamStats> => (read.ok ? { ok: true, value: statsOf(read.value) } : read),
  )
}

const streamViewOf = (s: CameraStream, stats: StreamStats | null): StreamView => ({
  camStreamId: s.camStreamId,
  kind: s.kind,
  codec: s.codec ?? null,
  resolution: s.resolution ? { width: s.resolution.width, height: s.resolution.height } : null,
  fps: s.fps ?? null,
  label: s.label ?? null,
  stats,
})

/** One camera's streams and slots, with the live stats of each. Never throws. */
export async function cameraStreamsView(
  client: HubClient,
  cam: CameraRow,
  streams: readonly CameraStream[],
  slots: readonly ProfileSlot[],
  status: CameraStatusSlice | undefined,
): Promise<CameraStreamsView> {
  const unavailable: { [part: string]: string } = {}
  const mine = streams.filter((s) => s.deviceId === cam.id)
  const mySlots = slots.filter((s) => s.deviceId === cam.id)
  const streamStats = await Promise.all(
    mine.map(async (s): Promise<[string, StreamStats | null]> => {
      const read = await readBrokerStats(client, `${String(cam.id)}/${s.camStreamId}`)
      if (!read.ok) unavailable[`stats:${s.camStreamId}`] = read.reason
      return [s.camStreamId, read.ok ? read.value : null]
    }),
  )
  const slotStats = await Promise.all(
    mySlots.map(async (s): Promise<[string, StreamStats | null]> => {
      if (s.sourceCamStreamId === null) return [s.profile, null]
      const read = await readBrokerStats(client, s.brokerId)
      if (!read.ok) unavailable[`stats:${s.profile}`] = read.reason
      return [s.profile, read.ok ? read.value : null]
    }),
  )
  const statsMap = new Map(streamStats)
  const slotMap = new Map(slotStats)
  const recording = await readQuery(
    client,
    'recordingArchive.getDeviceConfig',
    { deviceId: cam.id },
    RecordingConfigSchema,
  )
  if (!recording.ok) unavailable['recording'] = recording.reason
  const detection = status?.detection ?? null
  return {
    deviceId: cam.id,
    name: cam.name,
    native: mine
      .filter((s) => s.kind !== 'derived')
      .map((s) => streamViewOf(s, statsMap.get(s.camStreamId) ?? null)),
    derived: mine
      .filter((s) => s.kind === 'derived')
      .map((s) => streamViewOf(s, statsMap.get(s.camStreamId) ?? null)),
    slots: mySlots.map((s) => ({
      profile: s.profile,
      status: s.status,
      sourceCamStreamId: s.sourceCamStreamId,
      resolution: s.resolution ? { width: s.resolution.width, height: s.resolution.height } : null,
      codec: s.codec ?? null,
      error: s.errorMessage ?? null,
      stats: slotMap.get(s.profile) ?? null,
    })),
    recordingProfiles: recording.ok ? (recording.value.profiles ?? null) : null,
    detection: detection
      ? {
          nodeId: detection.nodeId,
          engine: `${detection.engine.backend}:${detection.engine.device}`,
          configuredFps: detection.configuredFps,
          actualFps: detection.actualFps,
        }
      : null,
    unavailable,
  }
}

/** Pure: unassigned slots get the biggest (high) and smallest (low) native stream. */
export function proposeStreams(cameras: readonly CameraStreamsView[]): StreamsProposal {
  const changes: (SlotChange & { reason: string })[] = []
  const notes: string[] = []
  for (const cam of cameras) {
    const natives = [...cam.native].toSorted((a, b) => pixels(b) - pixels(a))
    const first = natives[0]
    const last = natives.at(-1)
    const slotOf = (p: CamProfile): SlotView | undefined => cam.slots.find((s) => s.profile === p)
    if (first && (slotOf('high') === undefined || slotOf('high')?.sourceCamStreamId === null)) {
      changes.push({
        deviceId: cam.deviceId,
        profile: 'high',
        camStreamId: first.camStreamId,
        reason: `${cam.name}: high has no source; ${first.camStreamId} is the largest native stream`,
      })
    }
    if (
      last &&
      last !== first &&
      (slotOf('low') === undefined || slotOf('low')?.sourceCamStreamId === null)
    ) {
      changes.push({
        deviceId: cam.deviceId,
        profile: 'low',
        camStreamId: last.camStreamId,
        reason: `${cam.name}: low has no source; ${last.camStreamId} is the smallest native stream`,
      })
    }
    for (const slot of cam.slots) {
      if (slot.status === 'error') {
        notes.push(
          `${cam.name} (${String(cam.deviceId)}) ${slot.profile}: ${slot.error ?? 'error'}`,
        )
      }
      if (slot.stats !== null && slot.stats.idrIntervalMs > SLOW_IDR_MS) {
        notes.push(
          `${cam.name} (${String(cam.deviceId)}) ${slot.profile}: IDR every ${(slot.stats.idrIntervalMs / 1000).toFixed(1)} s — slow to join and to recover from loss`,
        )
      }
    }
    for (const d of cam.derived) {
      if (d.stats !== null && d.stats.idrIntervalMs > 0 && d.stats.idrIntervalMs < 1500) {
        notes.push(
          `${cam.name} (${String(cam.deviceId)}) ${d.camStreamId}: IDR every ${(d.stats.idrIntervalMs / 1000).toFixed(1)} s on an encoded stream; debug_report shows its restarts`,
        )
      }
    }
    if (cam.detection === null) {
      notes.push(`${cam.name} (${String(cam.deviceId)}): no detection session`)
    }
  }
  notes.push(
    'No capability names the stream detection reads; the detection node, engine and fps above are what the orchestrator reports.',
  )
  const body = { changes, notes }
  return { id: proposalId(body), changes, notes }
}

export async function setupStreams(
  ctx: McpContext,
  args: { readonly deviceId?: number } = {},
): Promise<SetupStreamsResult | NoSessionResult> {
  return withHub(ctx, async ({ client }): Promise<SetupStreamsResult> => {
    const unavailable: { [part: string]: string } = {}
    const [camerasRead, streams, slots, statuses] = await Promise.all([
      readCameraRows(client),
      readQuery(
        client,
        'streamBroker.listAllCameraStreams',
        undefined,
        z.array(CameraStreamSchema),
      ),
      readQuery(client, 'streamBroker.listAllProfileSlots', undefined, z.array(ProfileSlotSchema)),
      readCameraStatuses(client),
    ])
    if (!camerasRead.ok) unavailable['cameras'] = camerasRead.reason
    if (!streams.ok) unavailable['streams'] = streams.reason
    if (!slots.ok) unavailable['slots'] = slots.reason
    if (!statuses.ok) unavailable['status'] = statuses.reason
    if (!camerasRead.ok || !streams.ok || !slots.ok) {
      return {
        status: 'ok',
        cameras: [],
        camerasTruncated: 0,
        proposal: { id: proposalId({ unknown: true }), changes: [], notes: ['streams unknown'] },
        unavailable,
      }
    }
    const wanted = camerasRead.value.filter(
      (c) => !c.disabled && (args.deviceId === undefined || c.id === args.deviceId),
    )
    const capped = cap(wanted, CAMERA_LIMIT)
    const cameras = await mapLimit(capped.items, READ_CONCURRENCY, (cam) =>
      cameraStreamsView(
        client,
        cam,
        streams.value,
        slots.value,
        statuses.ok ? statuses.value.get(cam.id) : undefined,
      ),
    )
    return {
      status: 'ok',
      cameras,
      camerasTruncated: capped.truncated,
      proposal: proposeStreams(cameras),
      unavailable,
    }
  })
}

// ---------------------------------------------------------------------------
// configure_setup_streams

export const SETUP_STREAMS_TOOL = 'configure_setup_streams'
export const MAX_SLOT_CHANGES = 20

export const SlotChangeSchema = z.object({
  deviceId: z.number().int().nonnegative(),
  profile: CamProfileSchema,
  camStreamId: z.string().min(1).nullable(),
})

export interface SetupStreamsArgs {
  readonly changes: readonly SlotChange[]
}

export function setupStreamsSpec(client: HubClient): GatedToolSpec<SetupStreamsArgs> {
  return {
    tool: SETUP_STREAMS_TOOL,
    async dryRun(args): Promise<DryRunOutcome> {
      const [streams, slots] = await Promise.all([
        readQuery(
          client,
          'streamBroker.listAllCameraStreams',
          undefined,
          z.array(CameraStreamSchema),
        ),
        readQuery(
          client,
          'streamBroker.listAllProfileSlots',
          undefined,
          z.array(ProfileSlotSchema),
        ),
      ])
      if (!streams.ok || !slots.ok) {
        const reason = !streams.ok ? streams.reason : !slots.ok ? slots.reason : 'unknown'
        return { confirmable: false, describe: { problem: reason } }
      }
      const diff: { [k: string]: unknown }[] = []
      const problems: string[] = []
      for (const c of args.changes) {
        const slot = slots.value.find((s) => s.deviceId === c.deviceId && s.profile === c.profile)
        const from = slot?.sourceCamStreamId ?? null
        if (c.camStreamId !== null) {
          const known = streams.value.some(
            (s) => s.deviceId === c.deviceId && s.camStreamId === c.camStreamId,
          )
          if (!known) {
            problems.push(`${String(c.deviceId)}: stream ${c.camStreamId} is not published`)
            continue
          }
        }
        if (from === c.camStreamId) {
          problems.push(`${String(c.deviceId)}/${c.profile}: already ${from ?? 'unassigned'}`)
          continue
        }
        diff.push({ deviceId: c.deviceId, profile: c.profile, from, to: c.camStreamId })
      }
      return {
        confirmable: problems.length === 0 && diff.length > 0,
        describe: {
          action: 'assign camera profile slots',
          diff,
          warning:
            "Each slot change makes the pipeline orchestrator restart that camera's detection (onProfileSlotsChanged).",
          ...(problems.length > 0 ? { problems } : {}),
        },
      }
    },
    async execute(args) {
      const done: string[] = []
      for (const c of args.changes) {
        if (c.camStreamId === null) {
          await client.call('POST', 'streamBroker.unassignProfile', {
            deviceId: c.deviceId,
            profile: c.profile,
          })
        } else {
          await client.call('POST', 'streamBroker.assignProfile', {
            deviceId: c.deviceId,
            profile: c.profile,
            camStreamId: c.camStreamId,
          })
        }
        done.push(`${String(c.deviceId)}/${c.profile}`)
      }
      return { changed: done }
    },
  }
}

export function setupStreamsApply(
  ctx: McpContext,
  args: SetupStreamsArgs,
  confirmToken: string | undefined,
): Promise<AdminGatedResult> {
  return adminGated(ctx, setupStreamsSpec, args, confirmToken)
}
