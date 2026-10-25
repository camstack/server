/**
 * Which of OUR object detections a clip window holds — the ONE overlap rule
 * and the ONE label ranking, for every clip source (D923).
 *
 * The recorder's visits (`videoclip-visits.ts`) were the only clips labelled
 * by CamStack's detections; a clip the CAMERA recorded (Hikvision, Reolink,
 * Amcrest onboard storage) carried only what its firmware said, so a person
 * our pipeline saw inside a native clip never showed on it. The rule that
 * attaches an event to a window lives here so the visits and the native rows
 * cannot attach by two slightly different rules.
 *
 * Pure, except {@link withClipEventLabels}, which only composes a provider's
 * own `listClips` with a fetch the provider's addon supplies (`ctx.api` —
 * addons never import each other). It runs in the PROVIDER, never in the cap
 * mount: a mount routes, it does not compose addon output with other state.
 */
import {
  type Clip,
  type IVideoclipsProvider,
  MAX_CLIP_LABELS,
} from '../capabilities/videoclips.cap.js'
import type { IScopedLogger } from '../interfaces/logging.js'
import { EVENT_PAD_MS } from '../interfaces/recording-config.js'

/** A time window a clip covers. */
export interface ClipEventWindow {
  readonly startMs: number
  readonly endMs: number
}

/** The pad an event is widened by before it is tested against a window. */
export interface ClipEventPad {
  readonly preMs: number
  readonly postMs: number
}

/** The two fields of an object event the join reads. */
export interface ClipObjectEvent {
  readonly timestamp: number
  readonly className?: string
}

/**
 * Does an event at `timestamp` belong to `window`? Inside it, or its padded
 * window (`timestamp − preMs … timestamp + postMs`) crosses it.
 */
export function eventOverlapsClipWindow(
  timestamp: number,
  window: ClipEventWindow,
  pad: ClipEventPad,
): boolean {
  if (timestamp >= window.startMs && timestamp <= window.endMs) return true
  const windowStart = timestamp - pad.preMs
  const windowEnd = timestamp + pad.postMs
  return windowStart < window.endMs && windowEnd > window.startMs
}

/**
 * The distinct object classes among `events`, most frequent first, capped at
 * {@link MAX_CLIP_LABELS}. Empty when nothing classified is there — the caller
 * then omits the field rather than carrying an empty array.
 */
export function dominantClipLabels(events: readonly ClipObjectEvent[]): string[] {
  const counts = new Map<string, number>()
  for (const event of events) {
    const name = event.className
    if (typeof name !== 'string' || name.length === 0) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()]
    .toSorted((x, y) => y[1] - x[1])
    .slice(0, MAX_CLIP_LABELS)
    .map(([name]) => name)
}

/** Our labels for one window: the overlapping events, ranked. */
export function clipLabelsForWindow(
  window: ClipEventWindow,
  events: readonly ClipObjectEvent[],
  pad: ClipEventPad,
): string[] {
  return dominantClipLabels(
    events.filter((event) => eventOverlapsClipWindow(event.timestamp, window, pad)),
  )
}

/**
 * A row's labels once ours are joined: the source's own first (it named its
 * own clip, and `nativeTypes` keeps its unmapped words), then ours that it did
 * not already say, capped at {@link MAX_CLIP_LABELS}.
 */
export function mergeClipLabels(
  own: readonly string[] | undefined,
  ours: readonly string[],
): string[] {
  const merged = [...(own ?? [])]
  for (const label of ours) if (!merged.includes(label)) merged.push(label)
  return merged.slice(0, MAX_CLIP_LABELS)
}

/** Backstop on the event read behind one listing; hitting it is logged. */
export const CLIP_LABEL_EVENT_FETCH_LIMIT = 5_000

/** What a provider's addon supplies for the join. */
export interface ClipEventLabelDeps {
  readonly pad: ClipEventPad
  /** Our object events for the device in `[since, until]` — `ctx.api`. */
  fetchObjectEvents(input: {
    readonly deviceId: number
    readonly since: number
    readonly until: number
    readonly limit: number
  }): Promise<readonly ClipObjectEvent[]>
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
}

/**
 * Join our object events onto a listing. A read that FAILS changes nothing
 * (D49): the rows go out as the source listed them, and the line says so.
 */
export async function annotateClipsWithEventLabels(
  deviceId: number,
  clips: readonly Clip[],
  deps: ClipEventLabelDeps,
): Promise<readonly Clip[]> {
  if (clips.length === 0) return clips
  const since = Math.min(...clips.map((clip) => clip.timeRange.startMs)) - deps.pad.postMs
  const until = Math.max(...clips.map((clip) => clip.timeRange.endMs)) + deps.pad.preMs
  let events: readonly ClipObjectEvent[]
  try {
    events = await deps.fetchObjectEvents({
      deviceId,
      since,
      until,
      limit: CLIP_LABEL_EVENT_FETCH_LIMIT,
    })
  } catch (err: unknown) {
    deps.logger.warn('videoclips: our detections could not be read — clips listed without them', {
      tags: { deviceId },
      meta: {
        branch: 'event-labels-unreadable',
        clips: clips.length,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return clips
  }
  if (events.length >= CLIP_LABEL_EVENT_FETCH_LIMIT) {
    deps.logger.info('videoclips: the detection read behind these clips was truncated', {
      tags: { deviceId },
      meta: { branch: 'event-labels-truncated', limit: CLIP_LABEL_EVENT_FETCH_LIMIT, since, until },
    })
  }
  return clips.map((clip) => {
    const ours = clipLabelsForWindow(clip.timeRange, events, deps.pad)
    if (ours.length === 0) return clip
    return { ...clip, labels: mergeClipLabels(clip.labels, ours) }
  })
}

/** The one read the join needs, as an addon's `ctx.api` serves it. */
export interface ClipObjectEventsApi {
  readonly pipelineAnalytics: {
    readonly getObjectEvents: {
      query(input: {
        readonly deviceId: number
        readonly since: number
        readonly until: number
        readonly limit: number
        readonly projection: 'slim'
      }): Promise<readonly ClipObjectEvent[]>
    }
  }
}

/**
 * The join's deps from an addon's own `ctx.api` and logger, with the
 * canonical event pad the recorder's visits use (`EVENT_PAD_MS`) — one place,
 * so every native provider asks the same question.
 */
export function clipEventLabelDepsFromApi(
  api: ClipObjectEventsApi,
  logger: Pick<IScopedLogger, 'info' | 'warn'>,
): ClipEventLabelDeps {
  return {
    pad: EVENT_PAD_MS,
    fetchObjectEvents: ({ deviceId, since, until, limit }) =>
      api.pipelineAnalytics.getObjectEvents.query({
        deviceId,
        since,
        until,
        limit,
        projection: 'slim',
      }),
    logger,
  }
}

/**
 * The provider, with our detections joined onto every listing it answers.
 * Every other method is the provider's own.
 */
export function withClipEventLabels(
  provider: IVideoclipsProvider,
  deps: ClipEventLabelDeps,
): IVideoclipsProvider {
  const listClips: IVideoclipsProvider['listClips'] = async (...args) => {
    const clips = await provider.listClips(...args)
    return annotateClipsWithEventLabels(args[0].deviceId, clips, deps)
  }
  return { ...provider, listClips }
}
