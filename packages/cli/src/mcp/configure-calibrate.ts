/**
 * `configure_calibrate_camera` (read) and `configure_calibrate_apply` (gated).
 *
 * The read tool answers "why does this camera notify about shadows / miss the
 * courier": the recent tracks and their score distribution per class, the
 * current motion and detection settings, the zones and the pipeline's own
 * health numbers, then proposes changes that can actually be applied.
 *
 * Apply goes through the device's own `applyDeviceSettingsPatch` — the same
 * path the device page's settings use — and only for the two caps that carry
 * per-camera tuning (`motionDetection`, `pipelineOrchestrator`). A key is
 * checked against the LIVE contribution descriptor first (exists, right type,
 * within its bounds), so a typo or an out-of-range number is refused here with
 * the reason, not half-applied.
 *
 * The confidence floors (`minConfidence*`) are deliberately not applicable
 * here: they are per accelerator and node, not per camera (D927). The read tool
 * names them as advice, in text.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { text, type DryRunOutcome, type GatedToolSpec, type HubClient } from '@camstack/develop'
import { z } from 'zod'
import { ConfirmTokenSchema, adminGated, type AdminGatedResult } from './configure-common.js'
import { readZones, type ZoneRef } from './configure-hub-reads.js'
import type { McpContext, ToolTextResult } from './context.js'
import { readQuery, withHub, type NoSessionResult } from './ops-hub.js'

export const CALIBRATE_APPLY_TOOL = 'configure_calibrate_apply'

const WINDOW_MS = 24 * 3_600_000
const TRACK_LIMIT = 60
const MIN_SAMPLE = 5
const WEAK_SCORE = 0.6
const FP_RATIO = 0.3
const FPS_BEHIND = 0.7
const MIN_AREA_STEP = 1.5

export const CalibrateCapSchema = z.enum(['motionDetection', 'pipelineOrchestrator'])
export type CalibrateCap = z.infer<typeof CalibrateCapSchema>

/** What the metrics are, said once so the caller can quote it. */
export const METRICS_NOTE =
  'Measured with the Tracks list (pipelineAnalytics.listRecentTracks: per-class top score, how long and whether the subject moved) and the pipeline health (pipelineOrchestrator.getCameraMetrics: actual vs configured fps, dropped frames). The offline precision/recall of Benchmark and Model Studio needs labelled footage and is not reachable from here — run those in the admin UI for a labelled comparison.'

// ---------------------------------------------------------------------------
// reads

const PositionSchema = z.looseObject({ score: z.number().optional() })
const TrackSchema = z.looseObject({
  trackId: z.union([z.string(), z.number()]).optional(),
  className: z.string().optional(),
  firstSeen: z.number().optional(),
  lastSeen: z.number().optional(),
  moved: z.boolean().optional(),
  observations: z.number().optional(),
  positions: z.array(PositionSchema).optional(),
  zonesVisited: z.array(z.string()).optional(),
})
const TracksPageSchema = z.looseObject({ tracks: z.array(TrackSchema) })

const MetricsSchema = z.looseObject({
  detectionMode: z.string().nullish(),
  configuredFps: z.number().nullish(),
  actualFps: z.number().nullish(),
  queueDepth: z.number().nullish(),
  avgInferenceTimeMs: z.number().nullish(),
  droppedFrames: z.number().nullish(),
  phase: z.string().nullish(),
})

const FieldSchema = z.looseObject({
  key: z.string().optional(),
  type: z.string(),
  label: z.string().optional(),
  value: z.unknown().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  options: z.array(z.looseObject({ value: z.unknown() })).optional(),
})
const ContributionSchema = z
  .looseObject({
    sections: z.array(z.looseObject({ id: z.string(), fields: z.array(FieldSchema) })),
  })
  .nullable()

export interface SettingField {
  readonly key: string
  readonly type: string
  readonly label: string
  readonly value: unknown
  readonly min?: number
  readonly max?: number
  readonly options?: readonly unknown[]
}

function fieldsOf(contribution: z.infer<typeof ContributionSchema>): readonly SettingField[] {
  if (contribution === null) return []
  const out: SettingField[] = []
  for (const section of contribution.sections) {
    for (const f of section.fields) {
      if (f.key === undefined) continue
      out.push({
        key: f.key,
        type: f.type,
        label: f.label ?? f.key,
        value: f.value,
        ...(f.min !== undefined ? { min: f.min } : {}),
        ...(f.max !== undefined ? { max: f.max } : {}),
        ...(f.options !== undefined ? { options: f.options.map((o) => o.value) } : {}),
      })
    }
  }
  return out
}

async function readSettings(
  client: HubClient,
  cap: CalibrateCap,
  deviceId: number,
): Promise<
  | { readonly ok: true; readonly fields: readonly SettingField[] }
  | { readonly ok: false; readonly reason: string }
> {
  const read = await readQuery(
    client,
    `${cap}.getDeviceSettingsContribution`,
    { deviceId },
    ContributionSchema,
  )
  if (!read.ok) return read
  return { ok: true, fields: fieldsOf(read.value) }
}

// ---------------------------------------------------------------------------
// analysis (pure)

export interface ClassScores {
  readonly className: string
  readonly tracks: number
  readonly weak: number
  readonly stationary: number
  readonly buckets: {
    readonly below50: number
    readonly from50to65: number
    readonly from65to80: number
    readonly from80: number
  }
  readonly medianTopScore: number | null
}

type Track = z.infer<typeof TrackSchema>

function topScore(t: Track): number | null {
  const scores = (t.positions ?? []).map((p) => p.score).filter((s): s is number => s !== undefined)
  return scores.length === 0 ? null : Math.max(...scores)
}

export function scoreDistribution(tracks: readonly Track[]): readonly ClassScores[] {
  const byClass = new Map<string, Track[]>()
  for (const t of tracks) {
    const key = t.className ?? 'unknown'
    byClass.set(key, [...(byClass.get(key) ?? []), t])
  }
  return [...byClass.entries()]
    .map(([className, rows]): ClassScores => {
      const tops = rows
        .map(topScore)
        .filter((s): s is number => s !== null)
        .toSorted((a, b) => a - b)
      const count = (pred: (s: number) => boolean): number => tops.filter(pred).length
      const mid = Math.floor(tops.length / 2)
      const median =
        tops.length === 0
          ? null
          : tops.length % 2 === 1
            ? (tops[mid] ?? null)
            : ((tops[mid - 1] ?? 0) + (tops[mid] ?? 0)) / 2
      return {
        className,
        tracks: rows.length,
        weak: count((s) => s < WEAK_SCORE),
        stationary: rows.filter((r) => r.moved === false).length,
        buckets: {
          below50: count((s) => s < 0.5),
          from50to65: count((s) => s >= 0.5 && s < 0.65),
          from65to80: count((s) => s >= 0.65 && s < 0.8),
          from80: count((s) => s >= 0.8),
        },
        medianTopScore: median === null ? null : Math.round(median * 100) / 100,
      }
    })
    .toSorted((a, b) => b.tracks - a.tracks)
}

export interface Proposal {
  readonly cap: CalibrateCap
  readonly key: string
  readonly from: unknown
  readonly to: number | string | boolean
  readonly reason: string
}

export interface Finding {
  readonly finding: string
  readonly evidence: string
}

export interface Analysis {
  readonly findings: readonly Finding[]
  readonly advice: readonly string[]
  readonly proposals: readonly Proposal[]
}

export interface AnalysisInput {
  readonly classes: readonly ClassScores[]
  readonly metrics: z.infer<typeof MetricsSchema> | null
  readonly motion: readonly SettingField[]
  readonly pipeline: readonly SettingField[]
}

function numberField(
  fields: readonly SettingField[],
  key: string,
): { readonly value: number; readonly max?: number } | null {
  const f = fields.find((x) => x.key === key)
  if (f === undefined || typeof f.value !== 'number') return null
  return { value: f.value, ...(f.max !== undefined ? { max: f.max } : {}) }
}

export function analyse(input: AnalysisInput): Analysis {
  const findings: Finding[] = []
  const advice: string[] = []
  const proposals: Proposal[] = []

  let noisy = 0
  for (const c of input.classes) {
    if (c.tracks < MIN_SAMPLE) continue
    const ratio = c.weak / c.tracks
    if (ratio >= FP_RATIO) {
      noisy += c.weak
      findings.push({
        finding: `likely false positives on "${c.className}"`,
        evidence: `${c.weak} of ${c.tracks} tracks never passed score ${WEAK_SCORE} (median top score ${c.medianTopScore ?? 'n/a'})`,
      })
      advice.push(
        `Raise the ${c.className} confidence floor on the accelerator that serves this camera (Settings > Object detection). It is per accelerator and node, not per camera, so it is not changed from here.`,
      )
    }
    const stillRatio = c.stationary / c.tracks
    if (stillRatio >= 0.5) {
      findings.push({
        finding: `mostly motionless "${c.className}" tracks`,
        evidence: `${c.stationary} of ${c.tracks} tracks never moved: a parked object, a shadow or a poster`,
      })
    }
  }

  const minArea = numberField(input.motion, 'minArea')
  if (noisy >= MIN_SAMPLE && minArea !== null) {
    if (minArea.value > 0) {
      const raised = Math.round(minArea.value * MIN_AREA_STEP)
      const to = minArea.max !== undefined ? Math.min(raised, minArea.max) : raised
      if (to > minArea.value) {
        proposals.push({
          cap: 'motionDetection',
          key: 'minArea',
          from: minArea.value,
          to,
          reason:
            'weak, short tracks usually start as small motion blobs; a larger minimum area drops them before the detector runs',
        })
      }
    } else {
      advice.push(
        'minArea is 0 on this camera, so the merged-subject rule (a fraction of the view) judges motion. Set a positive minArea to use a fixed pixel bar instead, or draw a zone around the noisy area.',
      )
    }
  }

  const m = input.metrics
  if (m !== null && m !== undefined) {
    const configured = m.configuredFps ?? null
    const actual = m.actualFps ?? null
    if (
      configured !== null &&
      actual !== null &&
      configured > 0 &&
      actual < configured * FPS_BEHIND
    ) {
      findings.push({
        finding: 'the pipeline is not keeping up',
        evidence: `actual ${actual} fps against ${configured} configured${m.droppedFrames ? `, ${m.droppedFrames} frames dropped` : ''}`,
      })
      advice.push(
        'Possible missed detections: frames are being skipped. Check the accelerator load (ops_accelerators) before lowering any threshold.',
      )
    }
  }
  if (input.classes.length === 0) {
    findings.push({
      finding: 'no tracks in the window',
      evidence: 'nothing to calibrate on yet; a quiet camera or a window too short to say',
    })
  }
  return { findings, advice, proposals }
}

// ---------------------------------------------------------------------------
// the read tool

const MotionZoneStatusSchema = z.looseObject({
  grid: z.array(z.array(z.unknown())).optional(),
  mask: z.array(z.unknown()).optional(),
})

export interface CalibrationReport {
  readonly status: 'ok'
  readonly deviceId: number
  readonly windowHours: number
  readonly tracksRead: number
  readonly scoreDistributionPerClass: readonly ClassScores[]
  readonly pipeline: z.infer<typeof MetricsSchema> | null
  readonly current: {
    readonly motion: readonly unknown[]
    readonly detection: readonly unknown[]
    readonly zones: readonly string[]
    readonly motionMaskCellsDrawn: number | null
  }
  readonly findings: readonly Finding[]
  readonly advice: readonly string[]
  readonly proposals: readonly Proposal[]
  readonly metrics: string
  readonly next: string
  readonly unavailable: Readonly<Record<string, string>>
}

export async function calibrateCamera(
  ctx: McpContext,
  args: { readonly deviceId: number },
): Promise<CalibrationReport | NoSessionResult> {
  return withHub(ctx, async ({ client }) => {
    const now = Date.now()
    const unavailable: Record<string, string> = {}
    const [tracks, metrics, motion, pipeline, zones, motionZones] = await Promise.all([
      readQuery(
        client,
        'pipelineAnalytics.listRecentTracks',
        {
          deviceIds: [args.deviceId],
          since: now - WINDOW_MS,
          until: now,
          limit: TRACK_LIMIT,
        },
        TracksPageSchema,
      ),
      readQuery(
        client,
        'pipelineOrchestrator.getCameraMetrics',
        { deviceId: args.deviceId },
        MetricsSchema.nullable(),
      ),
      readSettings(client, 'motionDetection', args.deviceId),
      readSettings(client, 'pipelineOrchestrator', args.deviceId),
      readZones(client, args.deviceId),
      readQuery(
        client,
        'motionZones.getStatus',
        { deviceId: args.deviceId },
        MotionZoneStatusSchema.nullable(),
      ),
    ])
    if (!tracks.ok) unavailable['tracks'] = tracks.reason
    if (!metrics.ok) unavailable['metrics'] = metrics.reason
    if (!motion.ok) unavailable['motionSettings'] = motion.reason
    if (!pipeline.ok) unavailable['pipelineSettings'] = pipeline.reason
    if (!zones.ok) unavailable['zones'] = zones.reason
    const classes = tracks.ok ? scoreDistribution(tracks.value.tracks) : []
    const motionFields = motion.ok ? motion.fields : []
    const pipelineFields = pipeline.ok ? pipeline.fields : []
    const analysis = analyse({
      classes,
      metrics: metrics.ok ? metrics.value : null,
      motion: motionFields,
      pipeline: pipelineFields,
    })
    const zoneList: readonly ZoneRef[] = zones.ok ? zones.value : []
    const grid = motionZones.ok ? motionZones.value?.grid : undefined
    const maskedCells = grid ? grid.flat().filter((c) => Boolean(c)).length : null
    return {
      status: 'ok',
      deviceId: args.deviceId,
      windowHours: WINDOW_MS / 3_600_000,
      tracksRead: tracks.ok ? tracks.value.tracks.length : 0,
      scoreDistributionPerClass: classes,
      pipeline: metrics.ok ? metrics.value : null,
      current: {
        motion: motionFields.map((f) => ({
          key: f.key,
          label: f.label,
          value: f.value,
          ...(f.min !== undefined ? { min: f.min } : {}),
          ...(f.max !== undefined ? { max: f.max } : {}),
        })),
        detection: pipelineFields.map((f) => ({
          key: f.key,
          label: f.label,
          value: f.value,
        })),
        zones: zoneList.map((zn) => zn.name),
        motionMaskCellsDrawn: maskedCells,
      },
      findings: analysis.findings,
      advice: analysis.advice,
      proposals: analysis.proposals,
      metrics: METRICS_NOTE,
      next:
        analysis.proposals.length > 0
          ? `Apply a proposal with ${CALIBRATE_APPLY_TOOL} { deviceId, cap, patch: { <key>: <to> } }; it previews first.`
          : 'No settings change is proposed from this evidence.',
      unavailable,
    }
  })
}

// ---------------------------------------------------------------------------
// apply

export interface CalibrateApplyArgs {
  readonly deviceId: number
  readonly cap: CalibrateCap
  readonly patch: Readonly<Record<string, number | string | boolean>>
}

const FLOOR_KEY = /^minConfidence/i

interface KeyCheck {
  readonly problems: readonly string[]
  readonly changes: readonly {
    readonly key: string
    readonly before: unknown
    readonly after: unknown
  }[]
}

export function checkPatch(
  fields: readonly SettingField[],
  patch: CalibrateApplyArgs['patch'],
): KeyCheck {
  const problems: string[] = []
  const changes: { key: string; before: unknown; after: unknown }[] = []
  for (const [key, after] of Object.entries(patch)) {
    if (FLOOR_KEY.test(key)) {
      problems.push(
        `${key}: confidence floors are per accelerator and node, not per camera (D927) — change it in Settings > Object detection`,
      )
      continue
    }
    const field = fields.find((f) => f.key === key)
    if (field === undefined) {
      problems.push(
        `${key}: this camera has no such setting (it has: ${fields.map((f) => f.key).join(', ') || 'none'})`,
      )
      continue
    }
    if (field.type === 'number' || field.type === 'slider') {
      if (typeof after !== 'number') problems.push(`${key}: a number is expected`)
      else if (field.min !== undefined && after < field.min)
        problems.push(`${key}: ${after} is below the minimum ${field.min}`)
      else if (field.max !== undefined && after > field.max)
        problems.push(`${key}: ${after} is above the maximum ${field.max}`)
    } else if (field.type === 'boolean') {
      if (typeof after !== 'boolean') problems.push(`${key}: true or false is expected`)
    } else if (field.type === 'select') {
      if (field.options !== undefined && !field.options.includes(after)) {
        problems.push(`${key}: one of ${field.options.map(String).join(', ')} is expected`)
      }
    } else {
      problems.push(`${key}: a ${field.type} setting is not changed by calibration`)
    }
    changes.push({ key, before: field.value, after })
  }
  return { problems, changes }
}

export function calibrateApplySpec(client: HubClient): GatedToolSpec<CalibrateApplyArgs> {
  return {
    tool: CALIBRATE_APPLY_TOOL,
    async dryRun(args): Promise<DryRunOutcome> {
      if (Object.keys(args.patch).length === 0) {
        return {
          confirmable: false,
          describe: { problem: 'the patch is empty' },
        }
      }
      const settings = await readSettings(client, args.cap, args.deviceId)
      if (!settings.ok) return { confirmable: false, describe: { problem: settings.reason } }
      if (settings.fields.length === 0) {
        return {
          confirmable: false,
          describe: {
            problem: `device ${args.deviceId} has no ${args.cap} settings`,
          },
        }
      }
      const checked = checkPatch(settings.fields, args.patch)
      if (checked.problems.length > 0) {
        return {
          confirmable: false,
          describe: { problem: checked.problems.join('; ') },
        }
      }
      const unchanged = checked.changes.filter((c) => c.before === c.after)
      if (unchanged.length === checked.changes.length) {
        return {
          confirmable: false,
          describe: { problem: 'every value is already set' },
        }
      }
      return {
        confirmable: true,
        describe: {
          action: 'change camera detection settings',
          deviceId: args.deviceId,
          through: `${args.cap}.applyDeviceSettingsPatch`,
          changes: checked.changes,
          effect: 'takes effect on the next frames; nothing is restarted',
          measureAfter: `Run configure_calibrate_camera again after a few hours and compare. ${METRICS_NOTE}`,
        },
      }
    },
    async execute(args) {
      await client.call('POST', `${args.cap}.applyDeviceSettingsPatch`, {
        deviceId: args.deviceId,
        patch: args.patch,
      })
      return {
        applied: args.patch,
        measureAfter: `Run configure_calibrate_camera again after a few hours and compare. ${METRICS_NOTE}`,
      }
    },
  }
}

export async function calibrateApply(
  ctx: McpContext,
  args: CalibrateApplyArgs,
  confirmToken: string | undefined,
): Promise<AdminGatedResult> {
  return adminGated(ctx, calibrateApplySpec, args, confirmToken)
}

const GATE_HOW =
  'Two steps: call without confirm_token for a preview (before/after per key) and a one-shot token, then call again with the SAME arguments and that token. Needs an admin `camstack login` session.'

export function registerCalibrateTools(server: McpServer, ctx: McpContext): void {
  server.tool(
    'configure_calibrate_camera',
    'Read-only calibration report for one camera: recent tracks and their top-score distribution per class, likely false-positive and missed patterns, the current motion and detection settings, zones and pipeline health, and the changes it proposes. Writes nothing.',
    { deviceId: z.number().int().nonnegative() },
    async ({ deviceId }): Promise<ToolTextResult> => text(await calibrateCamera(ctx, { deviceId })),
  )
  server.tool(
    CALIBRATE_APPLY_TOOL,
    `Change per-camera motion or detection settings through the device's own settings path (motionDetection or pipelineOrchestrator). Keys are checked against the live settings first; confidence floors are not per camera and are refused. ${GATE_HOW}`,
    {
      deviceId: z.number().int().nonnegative(),
      cap: CalibrateCapSchema,
      patch: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
      confirm_token: ConfirmTokenSchema,
    },
    async ({ deviceId, cap, patch, confirm_token }): Promise<ToolTextResult> =>
      text(await calibrateApply(ctx, { deviceId, cap, patch }, confirm_token)),
  )
}
