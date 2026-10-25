/**
 * Per-camera object-detection state the Alexa side owns (R4, D779), in this
 * addon's per-device store (`<addonId>:addon-devices`, key
 * {@link VISION_STATE_KEY}):
 *
 *  - `classes` — what the user last chose in the Alexa app
 *    (`SetObjectDetectionClasses`). Absent = never told = every declared class.
 *  - `index` — eventIdentifier → track, for `ReportData` BY_IDENTIFIER. Ids are
 *    derived from the track (`vision-ids.ts`), so the index only has to answer
 *    the reverse direction; bounded to the newest {@link MAX_INDEX} entries.
 *  - `hidden` — events `DeleteData` removed. Hidden from Alexa ONLY: deleting
 *    CamStack footage is not something a voice assistant may do. Bounded.
 *
 * Reads are cached per camera; writes are serialized per camera (one
 * read-modify-write at a time), the same shape as `DetectionClassSource`.
 */
import { z } from 'zod'
import { SMART_VISION_CLASSES, type SmartVisionClass } from '../endpoints/builder.js'

export const VISION_STATE_KEY = 'alexaVision'
export const MAX_INDEX = 300
export const MAX_HIDDEN = 1000

const IndexEntrySchema = z.object({
  /** eventIdentifier */
  e: z.string(),
  /** trackId */
  t: z.string(),
  /** imageNetClass */
  c: z.enum(SMART_VISION_CLASSES),
  /** ms epoch of the detection */
  at: z.number(),
})
export type VisionIndexEntry = z.infer<typeof IndexEntrySchema>

const VisionStateSchema = z.object({
  classes: z.array(z.enum(SMART_VISION_CLASSES)).optional(),
  index: z.array(IndexEntrySchema).default([]),
  hidden: z.array(z.string()).default([]),
})
export type VisionState = z.infer<typeof VisionStateSchema>

const EMPTY: VisionState = { index: [], hidden: [] }

export interface VisionStateDeps {
  readonly read: (deviceId: number) => Promise<Readonly<Record<string, unknown>>>
  readonly write: (deviceId: number, patch: Record<string, unknown>) => Promise<void>
}

export function parseVisionState(store: Readonly<Record<string, unknown>>): VisionState {
  const parsed = VisionStateSchema.safeParse(store[VISION_STATE_KEY])
  return parsed.success ? parsed.data : EMPTY
}

export class VisionStateStore {
  private readonly cache = new Map<number, VisionState>()
  private readonly chains = new Map<number, Promise<void>>()

  constructor(private readonly deps: VisionStateDeps) {}

  async get(deviceId: number): Promise<VisionState> {
    const cached = this.cache.get(deviceId)
    if (cached !== undefined) return cached
    const state = parseVisionState(await this.deps.read(deviceId))
    this.cache.set(deviceId, state)
    return state
  }

  /** The user's class choice from the Alexa app. */
  setClasses(deviceId: number, classes: readonly SmartVisionClass[]): Promise<void> {
    return this.update(deviceId, (s) => ({ ...s, classes: [...classes] }))
  }

  /** Record events Alexa was (or is about to be) told about. Known ids are
   *  left alone, so re-reading the history costs no write. */
  async remember(deviceId: number, entries: readonly VisionIndexEntry[]): Promise<void> {
    const known = new Set((await this.get(deviceId)).index.map((e) => e.e))
    const fresh = entries.filter((e) => !known.has(e.e))
    if (fresh.length === 0) return
    await this.update(deviceId, (s) => {
      const merged = [...s.index.filter((e) => !fresh.some((f) => f.e === e.e)), ...fresh]
      merged.sort((a, b) => a.at - b.at)
      return { ...s, index: merged.slice(-MAX_INDEX) }
    })
  }

  async lookup(deviceId: number, eventIdentifier: string): Promise<VisionIndexEntry | null> {
    return (await this.get(deviceId)).index.find((e) => e.e === eventIdentifier) ?? null
  }

  hide(deviceId: number, eventIdentifiers: readonly string[]): Promise<void> {
    return this.update(deviceId, (s) => {
      const hidden = [...s.hidden.filter((h) => !eventIdentifiers.includes(h)), ...eventIdentifiers]
      return { ...s, hidden: hidden.slice(-MAX_HIDDEN) }
    })
  }

  /** Forget the cached copy (tests; a store written behind our back). */
  invalidate(deviceId: number): void {
    this.cache.delete(deviceId)
  }

  private update(deviceId: number, fn: (prev: VisionState) => VisionState): Promise<void> {
    const prev = this.chains.get(deviceId) ?? Promise.resolve()
    const run = prev.then(async () => {
      const next = fn(await this.get(deviceId))
      await this.deps.write(deviceId, { [VISION_STATE_KEY]: next })
      this.cache.set(deviceId, next)
    })
    this.chains.set(
      deviceId,
      run.catch(() => undefined),
    )
    return run
  }
}

/**
 * The classes a camera reports to Alexa: the ones it declares (`person`, plus
 * `package` where the pipeline produces it) that the user has not turned off
 * in the Alexa app.
 */
export function reportableVisionClasses(
  declared: readonly SmartVisionClass[],
  state: VisionState,
): readonly SmartVisionClass[] {
  const chosen = state.classes
  return declared.filter((c) => chosen === undefined || chosen.includes(c))
}
