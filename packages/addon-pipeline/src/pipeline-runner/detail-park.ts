/**
 * Detail-state PARK — what survives a SOFT camera detach so the detail plane
 * can keep serving a track that outlives its on-motion session.
 *
 * ## The fault this removes
 *
 * An on-motion session closes (`motion_cleared`, or the D261 stillness test
 * ends the hold) and the runner soft-detaches the camera. Post-analysis tracks
 * close only 30 s after `lastSeen`, so the detail dispatcher's 1 s tick keeps
 * dispatching `runDetailSubtree` for still-live tracks — correctly pinned to
 * the frame handle's node (verified 5000/5000 over 12 h) — and every dispatch
 * was refused with `camera is not attached` because
 * `resolveDetailChildSteps` read `this.attached` alone. ~600–900 refusals/h
 * fleet-wide, 70% within 5 s of the detach; the net effect was that person
 * tracks appearing near the end of a session were never embedded.
 *
 * ## What the park is, and is deliberately NOT
 *
 * A soft detach parks the attach config's STEP TREE (and elected device key)
 * for {@link DETAIL_PARK_GRACE_MS}. Pixels are NOT parked here, and since D453
 * the decode worker is not parked either — a detach releases it, because a held
 * worker went on decoding at full source rate for the whole window. So what the
 * ladder resolves against after a soft detach is the retained ≤640 store, on
 * its own window; the worker's subject tiles die with the worker. This is NOT a lease-TTL
 * inflation (rejected in [D73](../../../../docs/decisions/adr-0073.md)): no
 * frame is held one millisecond longer, only the step-tree lookup outlives the
 * session, bounded by the same 30 s the post-analysis track store uses
 * (`track-store.ts` `ttlMs`).
 *
 * A HARD detach (attach-replace, decode died twice, shutdown) purges the park
 * immediately — in each of those cases the config is wrong or the process is
 * going away.
 *
 * ## The typed refusal
 *
 * Past the grace (or with nothing parked) the refusal crosses the wire as an
 * ERROR whose message carries {@link DETAIL_NOT_ATTACHED_MARKER}. It cannot be
 * a field on the result: the cap output schema
 * (`pipeline-runner.cap.ts` → `z.object({ details }).nullable()`) is parsed on
 * the hub route and Zod strips unknown keys, so a new field would need a
 * `@camstack/types` + codegen + server-train change to survive. The marker has
 * a TWIN in `addon-post-analysis/src/pipeline-analytics/detail-refusal.ts`
 * (addons never import each other) — keep the two identical.
 */
import type { PipelineStepInputOutput } from '@camstack/types'

/**
 * How long a soft-detached camera's detail step tree stays resolvable.
 * Aligned to the post-analysis durable-track TTL (30 s since `lastSeen`) —
 * the dispatcher stops asking once the track closes, so a longer park serves
 * nobody and a shorter one re-opens the refusal window this exists to close.
 */
export const DETAIL_PARK_GRACE_MS = 30_000

/**
 * The wire marker for the typed not-attached refusal. Twin constant in
 * `addon-post-analysis/src/pipeline-analytics/detail-refusal.ts` — keep in sync.
 */
export const DETAIL_NOT_ATTACHED_MARKER = 'runDetailSubtree-refused:not-attached'

/** What a soft detach parks: the attach config's detail-relevant slice. */
export interface ParkedDetailState {
  /** The attach config's step tree (`RunnerCameraConfig.steps`). */
  readonly steps: readonly PipelineStepInputOutput[] | undefined
  /** The camera's elected inference device (`RunnerCameraConfig.deviceKey`). */
  readonly deviceKey: string | undefined
  /** Local `Date.now()` at the soft detach — anchors the grace window. */
  readonly parkedAt: number
}

/** A park entry plus its self-expiry timer. */
export interface ParkedDetailEntry {
  readonly state: ParkedDetailState
  readonly timer: ReturnType<typeof setTimeout>
}

/** Is this park still within its grace window at `nowMs`? */
export function isParkedDetailFresh(parked: ParkedDetailState, nowMs: number): boolean {
  return nowMs - parked.parkedAt <= DETAIL_PARK_GRACE_MS
}

/**
 * The error the cap method throws for a not-attached dispatch. The dispatcher
 * recognises the marker and goes straight to its bounded give-up instead of
 * burning the full-frame and crop fallback RPCs, both structurally doomed by
 * the same missing session.
 */
export function buildDetailNotAttachedError(deviceId: number): Error {
  return new Error(
    `${DETAIL_NOT_ATTACHED_MARKER} — camera ${deviceId} is not attached and no detail state is parked within the grace window`,
  )
}

/**
 * The wire marker for the typed handle-expired refusal (D688): the frame handle
 * a detail dispatch named is past the native lease age bound, so every later
 * ask for it is refused too. Twin constant in
 * `addon-post-analysis/src/pipeline-analytics/detail-refusal.ts` — keep in sync.
 * An error rather than a result field for the same reason as
 * {@link DETAIL_NOT_ATTACHED_MARKER}: the cap output schema strips unknown keys.
 */
export const DETAIL_HANDLE_EXPIRED_MARKER = 'runDetailSubtree-refused:handle-expired'

/**
 * The error the cap method throws when the dispatch's only pixel source was a
 * frame handle the lease registry refused as expired. The dispatcher recognises
 * the marker, retires the handle for that track and falls back to its parked
 * frame — it never names the same handle again.
 */
export function buildDetailHandleExpiredError(deviceId: number, handleAgeMs: number | null): Error {
  return new Error(
    `${DETAIL_HANDLE_EXPIRED_MARKER} — camera ${deviceId}: the frame handle is past the native lease age bound (age ${handleAgeMs ?? 'unknown'} ms)`,
  )
}
