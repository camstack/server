import type { DepacketizedNal } from '../rtsp/rtp-depacketizer.js'

/**
 * One Annex-B access unit assembled from the depacketizer's NALs.
 *
 * `annexB` is the depacketizer's own buffer when the picture arrived as a
 * single NAL (zero-copy, the common case), else one concatenation of every NAL
 * of the picture — parameter sets first, then the slices in arrival order.
 */
export interface AssembledAccessUnit {
  readonly annexB: Buffer
  /** RTP timestamp of the picture (90 kHz clock). */
  readonly timestamp: number
  /** The access unit contains an IDR / IRAP slice, or opens with parameter sets. */
  readonly keyframe: boolean
}

export type AccessUnitCallback = (accessUnit: AssembledAccessUnit) => void

/**
 * Groups depacketized NALs into ACCESS UNITS — one per picture.
 *
 * The broker's `EncodedPacket` is one access unit, and every consumer judges it
 * that way: `keyframe` gates where a clip ring widens to, where a late joiner
 * can start, how the pre-roll window is cut; the stats count it as one picture
 * and time the GOP from one `keyframe` to the next. A multi-slice camera (a
 * Hikvision G2 main stream is 3 slices per picture) used to hand each slice —
 * and each prefix SEI — down as its own "frame": 75 input fps on a 25 fps
 * camera, an 8–34 ms "GOP", a clip ring that widened to the LAST IRAP slice
 * (a third of the picture, without its parameter sets), and a prefix SEI that
 * inherited the welded VPS/SPS/PPS instead of the IDR.
 *
 * Boundary rule (RFC 3550 / 6184 / 7798): the RTP marker bit closes the
 * picture it ends — flushed on the spot, so a single-slice stream pays no
 * latency — and a timestamp change closes the one before it, for cameras that
 * never set the marker. Parameter sets are held and welded onto the picture
 * that follows them, so a keyframe access unit is self-contained
 * (VPS/SPS/PPS + IDR) exactly as before; a prefix SEI stays inside its
 * picture and is never a frame of its own.
 */
export class AccessUnitAssembler {
  private readonly onAccessUnit: AccessUnitCallback

  /** Parameter sets seen since the last picture closed; welded onto the next one. */
  private pendingParamNals: Buffer[] = []
  /** NALs of the picture in progress (parameter sets first when welded). */
  private pictureNals: Buffer[] = []
  private pictureTimestamp = 0
  private pictureKeyframe = false

  constructor(onAccessUnit: AccessUnitCallback) {
    this.onAccessUnit = onAccessUnit
  }

  push(depacketized: DepacketizedNal): void {
    const { annexB, keyframe, parameterSet, timestamp, marker } = depacketized

    // A new timestamp closes the picture in progress, whatever arrives next —
    // the marker-less camera's only boundary.
    if (this.pictureNals.length > 0 && timestamp !== this.pictureTimestamp) {
      this.flush()
    }

    if (parameterSet) {
      // Held, never a picture of its own: the IDR that follows carries them.
      // Whether the camera stamps them with the IDR's timestamp or the
      // previous one makes no difference here.
      this.pendingParamNals.push(annexB)
      return
    }

    if (this.pictureNals.length === 0) {
      this.pictureTimestamp = timestamp
      this.pictureKeyframe = false
    }

    if (this.pendingParamNals.length > 0) {
      // Parameter sets open a keyframe access unit (a stream of non-IDR
      // I-frames announces them the same way), ahead of the slice they
      // describe.
      for (const paramNal of this.pendingParamNals) this.pictureNals.push(paramNal)
      this.pendingParamNals = []
      this.pictureKeyframe = true
    }

    this.pictureNals.push(annexB)
    if (keyframe) this.pictureKeyframe = true

    if (marker) this.flush()
  }

  /**
   * Emit the picture in progress, if any. Called on the marker bit, on a
   * timestamp change, and by the broker when the stream stops or redials so
   * the last picture of a marker-less stream is not lost.
   */
  flush(): void {
    if (this.pictureNals.length === 0) return
    const nals = this.pictureNals
    const timestamp = this.pictureTimestamp
    const keyframe = this.pictureKeyframe
    this.pictureNals = []
    this.pictureKeyframe = false

    // One NAL — the depacketizer's buffer, verbatim. Several — one concat;
    // the long-lived rings detach what they retain from the pool themselves
    // (`owned-buffer.ts`), so the short-lived ingest copy stays pooled.
    const annexB = nals.length === 1 ? nals[0]! : Buffer.concat(nals)
    this.onAccessUnit({ annexB, timestamp, keyframe })
  }

  /** Drop everything held — a redial re-bases the clock, nothing carries over. */
  reset(): void {
    this.pendingParamNals = []
    this.pictureNals = []
    this.pictureTimestamp = 0
    this.pictureKeyframe = false
  }
}
