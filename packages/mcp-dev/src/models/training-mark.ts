/**
 * `training_frame_mark` (#451) — put recording stills into a retrain
 * collection, through the EXISTING retrain API, and say what the detector made
 * of each.
 *
 * Marking is a cluster mutation, so it goes through the gate: the dry run names
 * the collection, the instants and whether each is on a recording; the confirmed
 * call runs `addRetrainFrameFromRecording` per instant (the dataset copies the
 * native frame, the same moment twice is one copy) and, when a zone is given,
 * the package assist `proposeRetrainAnnotations` on each new frame. The assist
 * returns DRAFTS only (D790): nothing is boxed or accepted until the operator
 * confirms in Training Frames — this tool never calls `saveRetrainAnnotations`.
 *
 * The zone is NORMALISED [0,1]. A pixel zone silently returns zero proposals
 * (the 2026-11-06 case on camera 615), so a zone outside [0,1] is refused here.
 */
import { runGated, toToolOutput, type GatedResult, type MutationGate } from '@camstack/develop'
import { z } from 'zod'
import type { OpsHub, OpsMutator } from '../ops/hub.js'
import { judgeCoverage, mergeIntervals, readRecording } from '../ops/timeline-audit.js'
import { parseWire } from '../ops/wire.js'

const MAX_INSTANTS = 10

const ZoneSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().gt(0).max(1),
    h: z.number().gt(0).max(1),
  })
  .refine((z0) => z0.x + z0.w <= 1.0001 && z0.y + z0.h <= 1.0001, {
    message: 'zone must lie inside the frame: x+w and y+h are at most 1 (normalised, not pixels)',
  })

export const TrainingMarkArgsSchema = z.object({
  deviceId: z.number().int(),
  /** An existing collection: its id or its name (case-insensitive). */
  collection: z.string().min(1).max(200),
  epochMs: z.array(z.number().int().nonnegative()).min(1).max(MAX_INSTANTS),
  /** Normalised [0,1] rectangle the package assist looks in. Omit to only add the stills. */
  zone: ZoneSchema.optional(),
})
export type TrainingMarkArgs = z.infer<typeof TrainingMarkArgsSchema>

const CollectionsSchema = z.array(z.looseObject({ id: z.string(), name: z.string() }))

const AddResultSchema = z.discriminatedUnion('kind', [
  z.looseObject({
    kind: z.literal('added'),
    reused: z.boolean(),
    frame: z.looseObject({ frameId: z.string() }),
  }),
  z.looseObject({ kind: z.literal('refused'), reason: z.string(), detail: z.string().optional() }),
])

const AssistResultSchema = z.discriminatedUnion('kind', [
  z.looseObject({
    kind: z.literal('proposed'),
    minScore: z.number(),
    belowThreshold: z.number(),
    proposals: z.array(
      z.looseObject({
        assistScore: z.number().optional(),
        macroClass: z.string().optional(),
        bbox: z.looseObject({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
      }),
    ),
  }),
  z.looseObject({ kind: z.literal('refused'), reason: z.string(), detail: z.string().optional() }),
])

const COLLECTIONS_PATH = 'pipelineAnalytics.listRetrainCollections'
export const ADD_FRAME_PATH = 'pipelineAnalytics.addRetrainFrameFromRecording'
export const ASSIST_PATH = 'pipelineAnalytics.proposeRetrainAnnotations'

export interface TrainingMarkDeps {
  readonly gate: MutationGate
  readonly hub: () => OpsHub
  readonly mutator: () => OpsMutator
}

/** The verdict an assist answer supports: what the detector made of the zone. */
export function assistVerdict(
  answer: z.infer<typeof AssistResultSchema>,
): 'detector-proposes' | 'below-threshold' | 'model-miss' | 'assist-refused' {
  if (answer.kind === 'refused') return 'assist-refused'
  if (answer.proposals.length > 0) return 'detector-proposes'
  return answer.belowThreshold > 0 ? 'below-threshold' : 'model-miss'
}

export function trainingFrameMark(
  deps: TrainingMarkDeps,
  args: TrainingMarkArgs,
  confirmToken: string | undefined,
): Promise<GatedResult> {
  return runGated(
    deps.gate,
    {
      tool: 'training_frame_mark',
      dryRun: async (a: TrainingMarkArgs) => {
        const collections = parseWire(
          CollectionsSchema,
          await deps.hub().query(COLLECTIONS_PATH, {}),
          COLLECTIONS_PATH,
        )
        const found = findCollection(collections, a.collection)
        if (found === undefined) {
          return {
            confirmable: false,
            describe: {
              problem: `no retrain collection "${a.collection}". Create it in Training (Frames); this tool only adds to an existing one.`,
              collections: collections.slice(0, 30).map((c) => c.name),
            },
          }
        }
        const from = Math.min(...a.epochMs) - 60_000
        const to = Math.max(...a.epochMs) + 60_000
        const recording = await readRecording(deps.hub(), a.deviceId, from, to)
        const instants = a.epochMs.map((epochMs) => ({
          epochMs,
          at: new Date(epochMs).toISOString(),
          onRecording: recording.ok
            ? judgeCoverage(
                { start: epochMs, end: epochMs + 1_000 },
                mergeIntervals(recording.ranges),
              ).covered
            : null,
        }))
        return {
          confirmable: !recording.ok || instants.some((i) => i.onRecording !== false),
          describe: toToolOutput({
            collection: { id: found.id, name: found.name },
            deviceId: a.deviceId,
            instants,
            recording: recording.ok ? 'read' : `unknown: ${recording.reason}`,
            wouldCall: [ADD_FRAME_PATH, ...(a.zone ? [ASSIST_PATH] : [])],
            effect:
              'copies one native still per instant into the dataset' +
              (a.zone
                ? ', then runs the package assist in the zone (drafts only; nothing is saved as an annotation)'
                : ' (no zone: no assist run)'),
            zone: a.zone ?? null,
          }),
        }
      },
      execute: async (a: TrainingMarkArgs) => {
        const collections = parseWire(
          CollectionsSchema,
          await deps.hub().query(COLLECTIONS_PATH, {}),
          COLLECTIONS_PATH,
        )
        const found = findCollection(collections, a.collection)
        if (found === undefined) throw new Error(`collection "${a.collection}" disappeared`)
        const frames: Record<string, unknown>[] = []
        for (const epochMs of a.epochMs) {
          const added = parseWire(
            AddResultSchema,
            await deps.mutator().mutate(ADD_FRAME_PATH, {
              collectionId: found.id,
              deviceId: a.deviceId,
              epochMs,
            }),
            ADD_FRAME_PATH,
          )
          if (added.kind === 'refused') {
            frames.push({ epochMs, added: false, reason: added.reason, detail: added.detail })
            continue
          }
          if (a.zone === undefined) {
            frames.push({
              epochMs,
              added: true,
              reused: added.reused,
              frameId: added.frame.frameId,
            })
            continue
          }
          const assist = parseWire(
            AssistResultSchema,
            await deps.mutator().mutate(ASSIST_PATH, {
              deviceId: a.deviceId,
              frameId: added.frame.frameId,
              subject: { kind: 'package', zone: a.zone },
            }),
            ASSIST_PATH,
          )
          frames.push({
            epochMs,
            added: true,
            reused: added.reused,
            frameId: added.frame.frameId,
            verdict: assistVerdict(assist),
            assist:
              assist.kind === 'proposed'
                ? {
                    minScore: assist.minScore,
                    belowThreshold: assist.belowThreshold,
                    proposals: assist.proposals.slice(0, 5).map((p) => ({
                      score: p.assistScore ?? null,
                      macroClass: p.macroClass ?? null,
                      bbox: p.bbox,
                    })),
                  }
                : { refused: assist.reason, detail: assist.detail },
          })
        }
        return toToolOutput({
          collection: { id: found.id, name: found.name },
          frames,
          next: 'Open the frames in Training (Frames) to box and confirm; the assist returned drafts only. "model-miss" = nothing in the zone at the assist threshold or below; "below-threshold" = a detection exists under the threshold.',
        })
      },
    },
    args,
    confirmToken,
  )
}

function findCollection(
  collections: readonly { id: string; name: string }[],
  key: string,
): { id: string; name: string } | undefined {
  const lower = key.toLowerCase()
  return (
    collections.find((c) => c.id === key) ?? collections.find((c) => c.name.toLowerCase() === lower)
  )
}
