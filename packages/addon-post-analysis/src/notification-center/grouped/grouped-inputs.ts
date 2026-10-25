/**
 * The in-process inputs a grouped notification window (D692) receives from the tracker,
 * beside the object events and track closes the NC already hears. Every one of them is a
 * direct call on the pipeline-analytics process — never the event bus (D8): a dropped
 * promotion would silently cost a name in a one-shot message.
 */
import type { NcSubjectLabel } from '../rule-engine.js'

/**
 * A track's label CHANGED on an ACTIVE track: the track accepted a candidate
 * (`TrackStore.applyLabelCandidate` said `write`) or a tier was taken back
 * (`TrackStore.clearLabel`, the D665 retraction). The label is the track's projected
 * label AFTER the change — a cleared tier is simply absent.
 */
export interface NcTrackLabelChanged {
  readonly deviceId: number
  readonly trackId: string
  readonly change: 'accepted' | 'cleared'
  readonly label: NcSubjectLabel
}

/** Two tracks were fused by the L2 linker (D683): `absorbedId` now lives on as `survivorId`. */
export interface NcTracksFused {
  readonly deviceId: number
  readonly survivorId: string
  readonly absorbedId: string
}

/** What a not-yet-final member is waiting for (D692 §4). */
export type NcRecognitionAwaiting = 'face' | 'face-unseen' | 'plate'

/**
 * Whether a member has nothing left to wait for (D692 §4). `unknown` is PENDING — a read
 * that could not answer changes nothing in the direction that destroys work (D49, D393):
 * a wrong "final" would close a window before the name could arrive, a wrong "pending"
 * costs at most `groupingSec` of latency.
 */
export type NcRecognitionOutlook =
  | { readonly final: true }
  | { readonly final: false; readonly awaiting: NcRecognitionAwaiting }
  | { readonly final: false; readonly awaiting: 'unknown'; readonly reason: string }

/** The question the NC asks the recognisers, synchronously and in-process. */
export interface NcRecognitionOutlookQuery {
  readonly deviceId: number
  readonly trackId: string
  readonly className: string
  /** The member's current recognition kind, if any (identity / plate ⇒ final). */
  readonly labelKind?: 'identity' | 'plate'
  /**
   * The EVENT/FRAME clock (ms), never `Date.now()` on a replay: the recogniser's first face
   * is a frame timestamp, and the face-settle cap is measured against it.
   */
  readonly now: number
}
