/** The five `track_review_*` MCP tools. Only `track_review_apply` and `track_review_backfill_origin` write. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ApplyPlanSchema, applyPlan } from './apply.js'
import {
  clampHours,
  collectTracks,
  MAX_TRACKS,
  MAX_WALK_MS,
  type CollectedTracks,
} from './collect.js'
import { backfillOrigins } from './backfill.js'
import { clampImageBytes, fetchTrackFrame } from './frame.js'
import type { ReviewHub } from './hub-api.js'
import { buildPlan, VerdictSchema } from './plan.js'
import { DEFAULT_TRIAGE_OPTIONS, triageTracks, type TriageOptions } from './triage.js'
import { loadTrainingMembership } from './training.js'

export interface TrackReviewDeps {
  readonly getHub: () => ReviewHub
  readonly now: () => number
  readonly random: () => number
}

type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
interface ToolReply {
  [key: string]: unknown
  content: ToolContent[]
  isError?: boolean
}

const MAX_SUSPECTS_CAP = 100
const MAX_CONTROL_CAP = 50

function json(value: unknown): ToolContent {
  return { type: 'text', text: JSON.stringify(value, null, 2) }
}

/** A failure the model can read. The message never carries a credential. */
async function guarded(run: () => Promise<ToolReply>): Promise<ToolReply> {
  try {
    return await run()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `error: ${message}` }],
      isError: true,
    }
  }
}

/** First thing the reader sees when the window was not walked whole. */
function truncationNotice(c: CollectedTracks, hours: number): string | undefined {
  if (!c.truncated) return undefined
  const why =
    c.truncatedBy === 'max-wall-time'
      ? `the ${MAX_WALK_MS / 1000} s walk time ran out`
      : `the ${MAX_TRACKS} track bound was reached`
  return `WARNING: PARTIAL RESULT. The ${hours} h window was NOT fully read: ${why} after ${c.tracks.length} tracks / ${c.pages} pages (${c.camerasComplete} of ${c.cameras} cameras complete). Cameras were read newest-first in turn, so the unread part is the OLDEST tracks. The ranking below covers only what was read; narrow hours or deviceIds to cover the rest.`
}

function clampInt(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback
  return Math.min(Math.floor(value), max)
}

export function registerTrackReviewTools(server: McpServer, deps: TrackReviewDeps): void {
  server.tool(
    'track_review_triage',
    'READ-ONLY. Rank recent video tracks by how likely their class is wrong (label/class mismatch, weak score, confusable label, very short, static…; each row carries cameraName and inTraining, and suspects already in the retrain corpus are skipped unless excludeInTraining:false). few-observations is NOT evaluated here (slim rows carry no positions; see signalsNotEvaluated). Also returns a random control sample of non-suspects for the miss-rate check. Pages the hub one camera at a time, up to 20000 tracks or 60 s; when a bound hits, the first text block says the result is PARTIAL (oldest tracks unread).',
    {
      hours: z.number().optional().describe('window length, default 72, capped at 336'),
      deviceIds: z.array(z.number().int()).optional(),
      classes: z.array(z.string()).optional().describe('restrict to these track classes'),
      maxSuspects: z.number().int().optional().describe(`default 40, max ${MAX_SUSPECTS_CAP}`),
      controlSize: z.number().int().optional().describe(`default 15, max ${MAX_CONTROL_CAP}`),
      suspectLabels: z.array(z.string()).optional().describe('sub-labels to treat as confusable'),
      minScore: z.number().optional().describe('suspect threshold, default 3'),
      excludeInTraining: z
        .boolean()
        .optional()
        .describe(
          'default true: skip suspects that already have a frame in the retrain corpus (counted as skippedInTraining); false keeps them, still marked inTraining',
        ),
    },
    (args) =>
      guarded(async () => {
        const options: TriageOptions = {
          ...DEFAULT_TRIAGE_OPTIONS,
          ...(args.suspectLabels !== undefined
            ? { suspectLabels: args.suspectLabels.map((l) => l.toLowerCase()) }
            : {}),
          ...(args.minScore !== undefined ? { minScore: args.minScore } : {}),
        }
        const collected = await collectTracks(deps.getHub(), {
          hours: clampHours(args.hours),
          now: deps.now(),
          ...(args.deviceIds !== undefined ? { deviceIds: args.deviceIds } : {}),
          ...(args.classes !== undefined ? { classes: args.classes } : {}),
        })
        const excludeInTraining = args.excludeInTraining !== false
        const training = await loadTrainingMembership(deps.getHub())
        const result = triageTracks(
          collected.tracks,
          options,
          {
            maxSuspects: clampInt(args.maxSuspects, 40, MAX_SUSPECTS_CAP),
            controlSize: clampInt(args.controlSize, 15, MAX_CONTROL_CAP),
          },
          deps.random,
          { cameraNames: collected.cameraNames, training, excludeInTraining },
        )
        const notice = truncationNotice(collected, clampHours(args.hours))
        return {
          content: [
            ...(notice !== undefined ? [{ type: 'text' as const, text: notice }] : []),
            json({
              window: {
                hours: clampHours(args.hours),
                cameras: collected.cameras,
              },
              fetched: {
                tracks: collected.tracks.length,
                pages: collected.pages,
                truncated: collected.truncated,
                ...(collected.truncatedBy !== undefined
                  ? { truncatedBy: collected.truncatedBy }
                  : {}),
                camerasComplete: collected.camerasComplete,
              },
              ...result,
            }),
          ],
        }
      }),
  )

  server.tool(
    'track_review_frame',
    'READ-ONLY. The best clean frame for one track (returned as an image, size-bounded) plus its features and trajectory envelope, so the reviewer can judge the class by eye. A whole-scene frame is preferred; if only the thumbnail crop fits, imageSpace is "crop", the envelope is withheld (its coordinates are full-frame and do not map onto a crop) and a WARNING says so.',
    {
      deviceId: z.number().int(),
      trackId: z.string(),
      maxBytes: z.number().optional().describe('image size cap, default 1.5 MB, max 4 MB'),
    },
    (args) =>
      guarded(async () => {
        const frame = await fetchTrackFrame(
          deps.getHub(),
          args.deviceId,
          args.trackId,
          clampImageBytes(args.maxBytes),
        )
        const { image, ...rest } = frame
        const content: ToolContent[] = [
          ...(frame.warning !== undefined
            ? [{ type: 'text' as const, text: `WARNING: ${frame.warning}` }]
            : []),
          json(rest),
        ]
        if (image !== undefined) {
          content.push({
            type: 'image',
            data: image.base64,
            mimeType: image.mimeType,
          })
        }
        return { content }
      }),
  )

  server.tool(
    'track_review_plan',
    'LOCAL, NO HUB CALL. Turn verdicts (correct | wrong-class | false-positive | pipeline-bug | unsure) into the exact write plan: per track the steps, the subjects to box and whether the frame is marked complete. Show it to the operator before track_review_apply.',
    {
      verdicts: z.array(VerdictSchema).max(500),
      collectionName: z
        .string()
        .optional()
        .describe('carried in the plan so track_review_apply needs no separate argument'),
    },
    (args) =>
      guarded(async () => ({
        content: [json(buildPlan(args.verdicts, args.collectionName))],
      })),
  )

  server.tool(
    'track_review_apply',
    'WRITES to the hub (needs an admin token). Executes a plan from track_review_plan: flags tracks for training, copies a frame, saves the corrected annotations, optionally marks frames complete, adds them to the named collection. Refuses without confirm:true. Idempotent; never replaces existing annotations unless overwrite:true. Returns a per-track log and the corpus KPI before/after.',
    {
      plan: ApplyPlanSchema,
      collectionName: z
        .string()
        .optional()
        .describe(
          'created if it does not exist; wins over plan.collectionName; one of the two is required',
        ),
      confirm: z.boolean().describe('must be true — the operator has seen the plan'),
      overwrite: z.boolean().optional(),
    },
    (args) =>
      guarded(async () => {
        const result = await applyPlan(deps.getHub(), args.plan, {
          confirm: args.confirm,
          collectionName: args.collectionName,
          overwrite: args.overwrite === true,
        })
        return {
          content: [json(result)],
          ...(result.refused !== undefined ? { isError: true } : {}),
        }
      }),
  )

  server.tool(
    'track_review_backfill_origin',
    "DRY-RUN BY DEFAULT; WRITES (admin token) only with confirm:true. For annotations saved before origins existed, reconstruct each row's origin by EXACT rectangle match against the pipeline box the hub re-derives for its frame, so the review can tell an accepted box from an edited one. Name a collection or give frameIds (it never walks the whole corpus). Returns, per frame, the rows that would get an origin, the rows that stay unmatched (and so approximate), and rows that already have one. Writes only the origin column — ids, creation time and export stamps survive — and never overwrites an existing origin.",
    {
      collectionName: z.string().optional().describe('backfill every frame of this collection'),
      frameIds: z.array(z.string()).max(500).optional().describe('or these frames'),
      confirm: z.boolean().optional().describe('must be true to write; absent = dry-run'),
    },
    (args) =>
      guarded(async () => {
        const result = await backfillOrigins(deps.getHub(), {
          confirm: args.confirm === true,
          ...(args.collectionName !== undefined ? { collectionName: args.collectionName } : {}),
          ...(args.frameIds !== undefined ? { frameIds: args.frameIds } : {}),
        })
        return {
          content: [json(result)],
          ...(result.refused !== undefined ? { isError: true } : {}),
        }
      }),
  )
}
