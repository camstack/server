/**
 * Can this system attribute load to a CAMERA? — the answer, per load family,
 * as data rather than as prose.
 *
 * ## Why this is a module and not a paragraph
 *
 * The operator asked for per-camera charts of decode, transcode, recording and
 * detection. The honest answer is not one answer: the five families differ,
 * and the difference is the whole point. A chart that shows a number the
 * system cannot attribute is worse than no chart — on 2026-08-27 a number that
 * merely LOOKED true sent a diagnosis sideways for half a day.
 *
 * So the classification lives here, typed and tested, and the UI renders it.
 * A future change that makes a family measurable changes this table and the
 * surface follows; it cannot drift into showing an estimate dressed as a
 * measurement, because {@link CameraAttribution} has no value slot for one.
 *
 * ## The three classes, and the line between them
 *
 * - `measured` — a number the OS or the owning process reports for THIS
 *   camera. Nothing is apportioned.
 * - `accounted` — no process belongs to the camera, but the system already
 *   counts per-camera work (frames submitted, inference milliseconds). This is
 *   COUNTING, not measuring: it answers "how much of the pool did this camera
 *   ask for", never "how many CPU seconds did this camera cost". Anything
 *   built on it must say so on the chart, not in a footnote.
 * - `unattributable` — neither. It is shown as a SHARED total and named as
 *   shared.
 *
 * ## `wiredToday` is the field that keeps this honest
 *
 * A family can be per-camera **by construction** and still be unreadable.
 * `attribution` says what is POSSIBLE; `wiredToday` says whether it can be
 * read; `missingLink` says what would have to be built. A surface that showed
 * only the first column would promise numbers that do not exist.
 *
 * ## What changed on 2026-08-27, and what did not
 *
 * Until that evening the four per-camera families were all `wiredToday: false`
 * for ONE reason: no pid→deviceId map existed anywhere, so a `ps` row could
 * not be joined back to a camera. The repair is deliberately not that map.
 * Each addon now reports its OWN cost through the `load-contribution`
 * capability — the recorder does not need to be told which camera its ffmpeg
 * serves, it spawned it — so no entity needs global knowledge and no central
 * list has to be edited when a family is added. See
 * `packages/types/src/capabilities/load-contribution.cap.ts`.
 *
 * Detection did NOT change, and the way it did not change is the point: the
 * shared pool now DECLARES that it cannot be attributed
 * (`attribution: 'unattributable'`, `deviceId: null`) instead of leaving an
 * observer to infer it. The renunciation became data. {@link
 * isChartablePerCamera} still refuses it, and {@link CameraLoadAttributionRow}
 * still has no slot for a value — which is what stops an apportioned estimate
 * from ever being dressed as a measurement.
 */

/** How well a load family can be tied to one camera. */
export type CameraAttribution = 'measured' | 'accounted' | 'unattributable'

/** The five load families the operator named. */
export type CameraLoadFamily = 'decode' | 'transcode' | 'recording' | 'detection' | 'streaming'

export interface CameraLoadAttributionRow {
  readonly family: CameraLoadFamily
  readonly attribution: CameraAttribution
  /**
   * The unit of work that exists per camera — a child process, a ring buffer,
   * or (for a shared pool) nothing at all.
   */
  readonly unit: string
  /** Is the camera per unit ONE camera, or does one unit serve many? */
  readonly perCamera: boolean
  /**
   * Can a per-camera number be READ today, without new plumbing? `false` for a
   * family that is per-camera by construction but whose runtime link to a
   * `deviceId` is not recorded anywhere.
   */
  readonly wiredToday: boolean
  /** What is missing when `wiredToday` is false. Empty when it is true. */
  readonly missingLink: string
  /** `file:line` proof. Every claim above is checkable from these. */
  readonly evidence: readonly string[]
}

/**
 * The table. Every row was read out of the source on 2026-08-27; the
 * `evidence` entries are the lines that decide it.
 */
export const CAMERA_LOAD_ATTRIBUTION: readonly CameraLoadAttributionRow[] = [
  {
    family: 'decode',
    attribution: 'measured',
    unit: 'one forked decode-worker child per decode SESSION',
    // Three sessions per camera at most (detect / motion / occupancy), and a
    // session never spans two cameras — so a child is always ONE camera's.
    perCamera: true,
    wiredToday: true,
    missingLink: '',
    // `forkDecodeWorker` used to take `_source` and throw it away — that
    // discard WAS the missing link. It now claims the fork in the runner's
    // `ChildCostRegistry` with `source.deviceId`, and releases on the child's
    // exit, so `pipeline-runner` reports decode cost per camera itself.
    evidence: [
      'packages/addon-pipeline/src/session-decode/fork-decode-worker.ts:118',
      'packages/addon-pipeline/src/session-decode/fork-decode-worker.ts:131',
      'packages/addon-pipeline/src/pipeline-runner/index.ts:2765',
      'packages/types/src/process/child-cost-registry.ts:188',
    ],
  },
  {
    family: 'transcode',
    attribution: 'measured',
    unit: 'one ffmpeg child per (camera, encode plan)',
    // NOT per viewer: the egress sharing key excludes sessionId, so two
    // browsers on one camera at one tier share one child.
    perCamera: true,
    wiredToday: true,
    missingLink: '',
    // The egress manager already held `spec.deviceId`; it now claims each
    // spawn attempt (the hardware→software fallback spawns twice, and each
    // generation is claimed and released separately).
    evidence: [
      'packages/addon-pipeline/src/stream-broker/stream-broker/egress-transcode-manager.ts:960',
      'packages/addon-pipeline/src/stream-broker/stream-broker/transcode-egress.ts:282',
      'packages/addon-pipeline/src/stream-broker/stream-broker/transcode-egress.ts:324',
      'packages/types/src/ffmpeg/sharing-key.ts:139',
    ],
  },
  {
    family: 'recording',
    attribution: 'measured',
    unit: 'one passthrough ffmpeg per (camera, profile)',
    perCamera: true,
    wiredToday: true,
    missingLink: '',
    // `ProcLike` deliberately omitted `pid`, and that omission was the stated
    // blocker. It exposes it now for the opposite purpose: the writer CLAIMS
    // its own child instead of leaving an observer to join a `ps` row.
    evidence: [
      'packages/addon-pipeline/src/recorder/addon/segment-writer.ts:33',
      'packages/addon-pipeline/src/recorder/addon/segment-writer.ts:217',
      'packages/addon-pipeline/src/recorder/addon/segment-writer.ts:279',
      'packages/addon-pipeline/src/recorder/addon/recording-controller.ts:1710',
    ],
  },
  {
    family: 'detection',
    attribution: 'accounted',
    unit: 'a SHARED inference pool per (node, runtime, device) — no per-camera process',
    perCamera: false,
    // The counting already exists and runs; what does NOT exist, and cannot be
    // derived from it, is CPU seconds per camera.
    wiredToday: true,
    missingLink:
      'Nothing is missing for COUNTING — per-camera inference milliseconds, processed/shed frames and bytes-to-pool are already accumulated. What is missing is any basis for CPU seconds: `deviceId` reaches the pool as a diagnostic label and selects nothing, so cost can only ever be apportioned, never measured. Since 2026-08-27 the pool DECLARES this itself, contributing `deviceId: null` + `attribution: unattributable` rather than leaving an observer to infer it — the renunciation is data, and it is still refused by the chart gate.',
    evidence: [
      'packages/addon-pipeline/src/detection-pipeline/provider.ts:540',
      'packages/addon-pipeline/src/detection-pipeline/engine/shared-inference-pool.ts:413',
      'packages/types/src/interfaces/inference-engine.ts:24',
      'packages/addon-pipeline/src/pipeline-runner/timing-sampler.ts:63',
      'packages/addon-pipeline/src/pipeline-runner/runner.ts:353',
      'packages/addon-pipeline/src/pipeline-runner/runner.ts:849',
      'packages/addon-pipeline/src/pipeline-runner/frame-lazy-metrics.ts:100',
    ],
  },
  {
    family: 'streaming',
    attribution: 'measured',
    unit: 'one StreamBroker per `${deviceId}/${camStreamId}`, with an exact RTP ring byte counter',
    perCamera: true,
    // Still FALSE, and the reason is now narrower — which is why the row did
    // not flip with the other three. An ffmpeg-parser source spawns a child
    // per camera and that child IS claimed and reported (role `streaming`).
    // But a NATIVE source has no child at all: its whole streaming cost is
    // in-process ring occupancy, and the counter that measures it is private.
    // Flipping this row would promise a number for every camera while
    // delivering one only for the cameras that happen to need ffmpeg.
    wiredToday: false,
    missingLink:
      'The ffmpeg-backed ingest is now reported per camera, but that is the minority path. `rtpRingBytes` — the exact figure for the in-process case — is maintained on every push and drop and is still private and absent from `getStats()`. The three `EncodedRingBuffer`s track packets and duration and have no byte accumulator at all; the only byte figure they offer is `preRollBudgetBytes`, which is a BUDGET, not an occupancy.',
    evidence: [
      'packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker.ts:2895',
      'packages/addon-pipeline/src/stream-broker/rtsp/ffmpeg-push-reader.ts:189',
      'packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker.ts:494',
      'packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker.ts:498',
      'packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker.ts:2505',
      'packages/addon-pipeline/src/stream-broker/stream-broker/pre-roll.ts:269',
    ],
  },
]

/**
 * May a per-camera CHART be drawn for this family today?
 *
 * The one gate the UI calls. A family is chartable only when it is genuinely
 * measured AND the link to read it exists. `accounted` never passes: a counted
 * share is a legitimate number, but plotting it on an axis labelled with a
 * load makes it look measured, and that is the failure mode this whole module
 * is written against. It belongs in a panel that names it as a share of a
 * shared pool.
 */
export function isChartablePerCamera(row: CameraLoadAttributionRow): boolean {
  return row.attribution === 'measured' && row.wiredToday
}
