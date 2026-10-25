import type { RtpPacketClass } from './rtp-depacketizer.js'

/** What one source RTP packet is, judged at ACCESS-UNIT level. */
export interface RtpPacketAuFlags {
  /** First packet of an access unit (new RTP timestamp, or the previous packet carried the marker). */
  readonly auStart: boolean
  /**
   * The packet belongs to a keyframe access unit — true for every packet from
   * the first parameter set or IDR fragment to the end of the picture, prefix
   * SEI and middle FU fragments included.
   */
  readonly keyframeAu: boolean
  /** The first packet of this keyframe access unit that revealed it as one — once per picture. */
  readonly keyframeAuStart: boolean
  /**
   * The first packet of this access unit carrying PICTURE content (a slice, a
   * prefix SEI) rather than a parameter set — once per picture, which is what
   * the broker counts as one input frame when no access unit is assembled. A
   * parameter-set-only run (SPS/PPS stamped with the previous timestamp) is not
   * a picture and never starts one.
   */
  readonly pictureStart: boolean
  /** The packet carries a parameter set. */
  readonly parameterSet: boolean
}

/**
 * Tracks access-unit membership across the source RTP packets of ONE stream.
 *
 * The RTSP restreamer forwards source RTP untouched and must know, per
 * packet, whether it is part of a keyframe picture: that is what its keyframe
 * cache collects and what a backlog-latched session resumes on. The
 * depacketizer can only say so about a NAL that COMPLETED, so the fragments of
 * a fragmented IDR before the last one, and a prefix SEI between the parameter
 * sets and the slice, were reported as plain packets: the cache latch closed
 * on them and re-opened on the final fragment, and a backlogged session
 * counted every IRAP slice as a missed keyframe. Here a packet is classified
 * by what it carries ({@link RtpPacketClass}) and the verdict is carried
 * across the whole picture, bounded by the RTP timestamp and marker bit.
 *
 * A parameter-set-only run is not a picture: a camera that stamps SPS/PPS
 * with the previous timestamp still announces ONE keyframe, so the keyframe
 * verdict carries over into the slice that follows instead of starting twice.
 */
export class RtpAccessUnitTracker {
  private timestamp = -1
  private previousMarker = true
  private keyframeAu = false
  /** The picture in progress has received something other than a parameter set. */
  private pictureSeen = false

  classify(packet: RtpPacketClass): RtpPacketAuFlags {
    const auStart = this.previousMarker || packet.timestamp !== this.timestamp
    if (auStart && this.pictureSeen) {
      this.keyframeAu = false
    }
    if (auStart) this.pictureSeen = false
    this.timestamp = packet.timestamp
    this.previousMarker = packet.marker

    const keyframeContent = packet.keyframe || packet.parameterSet
    const keyframeAuStart = keyframeContent && !this.keyframeAu
    if (keyframeContent) this.keyframeAu = true
    const pictureStart = !packet.parameterSet && !this.pictureSeen
    if (!packet.parameterSet) this.pictureSeen = true

    return {
      auStart,
      keyframeAu: this.keyframeAu,
      keyframeAuStart,
      pictureStart,
      parameterSet: packet.parameterSet,
    }
  }

  /** A redial re-bases the clock; nothing carries over. */
  reset(): void {
    this.timestamp = -1
    this.previousMarker = true
    this.keyframeAu = false
    this.pictureSeen = false
  }
}
