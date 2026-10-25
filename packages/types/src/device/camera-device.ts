import type { StreamQuality } from '../interfaces/device-capabilities/camera.js'
import type { IDevice } from './device.js'
import type { DeviceType } from './device-type.js'

export interface StreamSourceEntry {
  readonly id: string
  readonly label: string
  readonly protocol: 'rtsp' | 'rtmp' | 'annexb' | 'http-mjpeg' | 'webrtc' | 'custom'
  /** Stream URL — required for rtsp, rtmp, http-mjpeg. Not used for annexb/custom. */
  readonly url?: string
  /**
   * Stream metadata — optional. If omitted, the stream-broker will probe
   * the stream (via ffprobe) on first registration to discover resolution/fps/codec.
   * Providers that already know the metadata (e.g. ONVIF profiles) should provide it
   * to avoid the probe delay.
   */
  readonly resolution?: { readonly width: number; readonly height: number }
  readonly fps?: number
  readonly bitrate?: number
  readonly codec?: string
  /** Hint: suggested quality profile. Stream-broker may override after probing. */
  readonly profileHint?: StreamQuality
  /**
   * Pre-built SDP. Drivers that publish a `pull-rfc4571` source can
   * derive a synthetic SDP from device-side metadata (e.g. Reolink
   * `getStreamMetadata` cmd_id 56 — `videoEncType` + audio config) so
   * the broker's `metadata.sdp` is populated WITHOUT first opening an
   * upstream streaming session. SPS/PPS are intentionally omitted —
   * the lib's `Rfc4571Muxer.sendCachedVideoConfigToClient` primes
   * downstream consumers from in-band keyframe NAL units.
   *
   * Drivers that need full SDP (with parameter sets) still open a real
   * streaming session at publish time — the field stays optional.
   */
  readonly sdp?: string
}

/**
 * Camera device interface — extends IDevice with stream source exposure.
 * Every camera MUST implement getStreamSources() to tell the stream-broker
 * how to consume its video feeds. The broker will probe streams that lack
 * metadata (resolution/fps) and assign quality profiles automatically.
 */
export interface ICameraDevice extends IDevice {
  readonly type: typeof DeviceType.Camera
  getStreamSources(): Promise<readonly StreamSourceEntry[]>
}
