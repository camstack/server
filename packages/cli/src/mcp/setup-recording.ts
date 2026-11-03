/**
 * `setup_recording` (read) and `configure_setup_recording` (write): per-camera
 * recording bands and retention, what each camera records now, and a proposal.
 *
 * A camera whose config could not be read has `config: null` and a reason in
 * `unavailable`; it is never reported as "not recording". A camera the
 * operator switched off (`disabled`) is never proposed a schedule (D62).
 */
import { RecordingConfigSchema, deriveRecordingMode, type RecordingConfig } from '@camstack/types'
import { type DryRunOutcome, type GatedToolSpec, type HubClient } from '@camstack/develop'
import { z } from 'zod'
import { adminGated, type AdminGatedResult } from './configure-common.js'
import type { McpContext } from './context.js'
import { readQuery, withHub, type NoSessionResult } from './ops-hub.js'
import { readCameraRows, readCameraStatuses } from './setup-camera-reads.js'
import { CAMERA_LIMIT, mapLimit, proposalId, READ_CONCURRENCY } from './setup-assist-common.js'
import { cap } from './ops-hub.js'

export interface RecordingCameraView {
  readonly deviceId: number
  readonly name: string
  readonly disabled: boolean
  /** `null`: the config could not be read — unknown, not "off". */
  readonly config: {
    readonly mode: string
    readonly enabled: boolean
    readonly profiles: readonly string[] | null
    readonly bands: readonly {
      readonly days: readonly number[]
      readonly start: string
      readonly end: string
      readonly mode: string
    }[]
    readonly retention: { readonly maxAgeDays: number | null; readonly maxSizeGb: number | null }
  } | null
  /** What the camera records now, from the orchestrator; `null` when unread. */
  readonly now: { readonly active: boolean; readonly storageBytes: number } | null
  readonly unavailable: { readonly [part: string]: string }
}

export interface RecordingChange {
  readonly deviceId: number
  readonly config: RecordingConfig
}

export interface RecordingProposal {
  readonly id: string
  readonly changes: readonly {
    readonly deviceId: number
    readonly config: RecordingConfig
    readonly reason: string
  }[]
  readonly notes: readonly string[]
}

export interface SetupRecordingResult {
  readonly status: 'ok'
  readonly cameras: readonly RecordingCameraView[]
  readonly camerasTruncated: number
  readonly proposal: RecordingProposal
  readonly unavailable: { readonly [part: string]: string }
}

export const PROPOSED_RETENTION_DAYS = 14
const EVERY_DAY: readonly number[] = [0, 1, 2, 3, 4, 5, 6]

/** The default schedule offered to a camera that records nothing: every day, on events. */
export function eventsEveryDay(base: RecordingConfig | null): RecordingConfig {
  return {
    ...base,
    enabled: true,
    bands: [{ days: [...EVERY_DAY], start: '00:00', end: '23:59', mode: 'events' }],
    retention: { maxAgeDays: PROPOSED_RETENTION_DAYS, ...base?.retention },
  }
}

export function proposeRecording(cameras: readonly RecordingCameraView[]): RecordingProposal {
  const changes: { deviceId: number; config: RecordingConfig; reason: string }[] = []
  const notes: string[] = []
  for (const cam of cameras) {
    if (cam.disabled) continue
    if (cam.config === null) {
      notes.push(`${cam.name} (${String(cam.deviceId)}): config unknown — no proposal`)
      continue
    }
    if (cam.config.mode === 'off') {
      const parsed = RecordingConfigSchema.safeParse(eventsEveryDay(null))
      if (parsed.success) {
        changes.push({
          deviceId: cam.deviceId,
          config: parsed.data,
          reason: `${cam.name} records nothing: record on events, every day, ${String(PROPOSED_RETENTION_DAYS)} days`,
        })
      }
      continue
    }
    if (cam.config.retention.maxAgeDays === null && cam.config.retention.maxSizeGb === null) {
      notes.push(
        `${cam.name} (${String(cam.deviceId)}): no retention set — footage is bounded only by disk pressure`,
      )
    }
  }
  const body = { changes, notes }
  return { id: proposalId(body), changes, notes }
}

export async function setupRecording(
  ctx: McpContext,
): Promise<SetupRecordingResult | NoSessionResult> {
  return withHub(ctx, async ({ client }): Promise<SetupRecordingResult> => {
    const unavailable: { [part: string]: string } = {}
    const [camerasRead, statuses] = await Promise.all([
      readCameraRows(client),
      readCameraStatuses(client),
    ])
    if (!statuses.ok) unavailable['status'] = statuses.reason
    if (!camerasRead.ok) {
      unavailable['cameras'] = camerasRead.reason
      return {
        status: 'ok',
        cameras: [],
        camerasTruncated: 0,
        proposal: { id: proposalId({ unknown: true }), changes: [], notes: ['cameras unknown'] },
        unavailable,
      }
    }
    const capped = cap(camerasRead.value, CAMERA_LIMIT)
    const cameras = await mapLimit(
      capped.items,
      READ_CONCURRENCY,
      async (cam): Promise<RecordingCameraView> => {
        const read = await readQuery(
          client,
          'recordingArchive.getDeviceConfig',
          { deviceId: cam.id },
          RecordingConfigSchema,
        )
        const status = statuses.ok ? statuses.value.get(cam.id) : undefined
        const rec = status?.recording ?? null
        return {
          deviceId: cam.id,
          name: cam.name,
          disabled: cam.disabled,
          config: read.ok
            ? {
                mode: deriveRecordingMode(read.value),
                enabled: read.value.enabled,
                profiles: read.value.profiles ?? null,
                bands: read.value.bands.map((b) => ({
                  days: b.days,
                  start: b.start,
                  end: b.end,
                  mode: b.mode,
                })),
                retention: {
                  maxAgeDays: read.value.retention?.maxAgeDays ?? null,
                  maxSizeGb: read.value.retention?.maxSizeGb ?? null,
                },
              }
            : null,
          now: rec ? { active: rec.active, storageBytes: rec.storageBytes } : null,
          unavailable: read.ok ? {} : { config: read.reason },
        }
      },
    )
    return {
      status: 'ok',
      cameras,
      camerasTruncated: capped.truncated,
      proposal: proposeRecording(cameras),
      unavailable,
    }
  })
}

// ---------------------------------------------------------------------------
// configure_setup_recording

export const SETUP_RECORDING_TOOL = 'configure_setup_recording'
export const MAX_RECORDING_CHANGES = 20

export interface SetupRecordingArgs {
  readonly changes: readonly { readonly deviceId: number; readonly config: unknown }[]
}

const describeConfig = (config: RecordingConfig): { [k: string]: unknown } => ({
  mode: deriveRecordingMode(config),
  enabled: config.enabled,
  bands: config.bands.length,
  profiles: config.profiles ?? null,
  retention: config.retention ?? null,
})

export function setupRecordingSpec(client: HubClient): GatedToolSpec<SetupRecordingArgs> {
  return {
    tool: SETUP_RECORDING_TOOL,
    async dryRun(args): Promise<DryRunOutcome> {
      const diff: { [k: string]: unknown }[] = []
      const problems: string[] = []
      for (const change of args.changes) {
        const parsed = RecordingConfigSchema.safeParse(change.config)
        if (!parsed.success) {
          const first = parsed.error.issues[0]
          problems.push(
            `${String(change.deviceId)}: invalid config (${first ? `${first.path.join('.')}: ${first.message}` : 'unexpected shape'})`,
          )
          continue
        }
        const current = await readQuery(
          client,
          'recordingArchive.getDeviceConfig',
          { deviceId: change.deviceId },
          RecordingConfigSchema,
        )
        if (!current.ok) {
          problems.push(`${String(change.deviceId)}: current config unreadable (${current.reason})`)
          continue
        }
        diff.push({
          deviceId: change.deviceId,
          from: describeConfig(current.value),
          to: describeConfig(parsed.data),
        })
      }
      return {
        confirmable: problems.length === 0 && diff.length > 0,
        describe: {
          action: 'set recording config',
          diff,
          ...(problems.length > 0 ? { problems } : {}),
        },
      }
    },
    async execute(args) {
      const done: number[] = []
      for (const change of args.changes) {
        const parsed = RecordingConfigSchema.parse(change.config)
        await client.call('POST', 'recordingArchive.setDeviceConfig', {
          deviceId: change.deviceId,
          config: parsed,
        })
        done.push(change.deviceId)
      }
      return { changed: done }
    },
  }
}

export const RecordingChangeInputSchema = z.object({
  deviceId: z.number().int().nonnegative(),
  config: z.record(z.string(), z.unknown()),
})

export function setupRecordingApply(
  ctx: McpContext,
  args: SetupRecordingArgs,
  confirmToken: string | undefined,
): Promise<AdminGatedResult> {
  return adminGated(ctx, setupRecordingSpec, args, confirmToken)
}
