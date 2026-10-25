/**
 * Recognises the runner's TYPED `not-attached` refusal from a
 * `pipelineRunner.runDetailSubtree` call.
 *
 * The refusal crosses the wire as an ERROR whose message carries a marker,
 * not as a result field: the cap output schema
 * (`@camstack/types` `pipeline-runner.cap.ts` → `z.object({ details
 * }).nullable()`) is parsed on the hub route and Zod strips unknown keys, so a
 * refusal field cannot survive without a types + codegen + server-train
 * change. Error messages DO survive the route (tRPC carries `error.message`;
 * see `cap-route-error-formatter.ts`).
 *
 * The marker constant is a TWIN of
 * `addon-pipeline/src/pipeline-runner/detail-park.ts`
 * `DETAIL_NOT_ATTACHED_MARKER` — addons never import each other (`ctx.api` is
 * the only cross-addon layer), so the value is duplicated here the same way
 * `composeDetailSteps` mirrors the pipeline catalog's chain. Keep the two
 * identical.
 *
 * Why the dispatcher cares: this refusal is about the camera's SESSION state
 * (the on-motion session closed and the runner's detail park grace has
 * lapsed), not about one frame — so the full-frame and crop fallback rungs are
 * structurally doomed and must be skipped, feeding the scheduler's bounded
 * give-up directly.
 */
export const DETAIL_NOT_ATTACHED_MARKER = 'runDetailSubtree-refused:not-attached'

/** Best-effort message extraction across transport error shapes. */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (typeof err === 'object' && err !== null) {
    const message: unknown = Reflect.get(err, 'message')
    if (typeof message === 'string') return message
  }
  return ''
}

/** Did this `runDetailSubtree` error carry the runner's not-attached marker? */
export function isDetailNotAttachedRefusal(err: unknown): boolean {
  return messageOf(err).includes(DETAIL_NOT_ATTACHED_MARKER)
}

/**
 * The runner's TYPED handle-expired refusal (D688): the frame handle a dispatch
 * named is past the native lease age bound, and the registry will refuse it on
 * every later ask. TWIN of `addon-pipeline/src/pipeline-runner/detail-park.ts`
 * `DETAIL_HANDLE_EXPIRED_MARKER` — keep the two identical.
 *
 * Why the dispatcher cares: unlike not-attached this is about ONE handle, not
 * the session — the parked frame still serves — but the handle itself is
 * finished. Naming it again (next tick, or through the native-strict crop rung)
 * can only be refused again; on the live fleet that was ~7 refusals per handle.
 */
export const DETAIL_HANDLE_EXPIRED_MARKER = 'runDetailSubtree-refused:handle-expired'

/** Did this `runDetailSubtree` error carry the runner's handle-expired marker? */
export function isDetailHandleExpiredRefusal(err: unknown): boolean {
  return messageOf(err).includes(DETAIL_HANDLE_EXPIRED_MARKER)
}
