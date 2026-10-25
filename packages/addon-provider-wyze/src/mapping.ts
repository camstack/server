/**
 * Pure mapping helpers — cloud descriptor → camstack config, codec name
 * normalisation, motion-event decoding, resolution/bitrate selection.
 * Kept side-effect free so they are exhaustively unit-testable without
 * the lib, the kernel, or a live camera.
 */

import type { WyzeCamera, WyzeEvent } from '@apocaliss92/wyze-bridge-js'
import { WYZE_BITRATE, WYZE_FRAME_SIZE } from './constants.js'
import type { WyzeBitrate, WyzeCameraConfig, WyzeResolution } from './schema.js'

/** The lib's `WyzeRfc4571Server.videoType` discriminant. */
export type WyzeVideoType = 'H264' | 'H265'

/** Canonical camstack codec name from the lib's `videoType`. */
export function codecFromVideoType(videoType: WyzeVideoType): 'h264' | 'h265' {
  return videoType === 'H265' ? 'h265' : 'h264'
}

/** Map the resolution knob to the lib's `frameSize` arg. */
export function frameSizeFor(resolution: WyzeResolution): number {
  switch (resolution) {
    case 'fhd':
      return WYZE_FRAME_SIZE.fhd
    case 'hd':
      return WYZE_FRAME_SIZE.hd
    case 'low':
      return WYZE_FRAME_SIZE.low
    case 'qhd':
      return WYZE_FRAME_SIZE.qhd
  }
}

/** Map the bitrate knob to the lib's `bitrate` arg. */
export function bitrateFor(bitrate: WyzeBitrate): number {
  return bitrate === 'sd' ? WYZE_BITRATE.sd : WYZE_BITRATE.max
}

/**
 * The provider-stable id used both as the device stableId discriminator
 * and the device-meta row key. MAC is globally unique + durable across
 * firmware updates and DHCP renewals — the natural key. Sanitised to a
 * flat slug so DB inspection + log scans stay readable.
 */
export function stableIdForMac(mac: string): string {
  const clean = mac.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
  return `mac-${clean}`
}

/**
 * Reduce a cloud `WyzeCamera` blob to the persisted camera config. Pure:
 * `resolution` / `bitrate` / `motionSource` carry their schema defaults
 * here (the device config schema re-applies them on parse).
 *
 * `integrationId` stamps the owning account so the camera resolves its
 * per-account cloud client from the registry. Defaults to `''` (legacy
 * single-global-credentials cameras) when not supplied by the adopt path.
 */
export function cameraConfigFromCloud(cam: WyzeCamera, integrationId = ''): WyzeCameraConfig {
  return {
    integrationId,
    mac: cam.mac,
    p2pId: cam.p2pId,
    enr: cam.enr,
    ip: cam.ip,
    productModel: cam.productModel,
    dtls: cam.dtls,
    firmwareVer: cam.firmwareVer,
    resolution: 'fhd',
    bitrate: 'max',
    motionSource: 'cloud',
  }
}

/**
 * A discovered Wyze camera is adoptable only when it carries the local
 * P2P parameters the DTLS client needs. The cloud already filters out
 * gwell (cloud-only) cams (no `ip`), but guard against partial blobs.
 */
export function isAdoptableCamera(cam: WyzeCamera): boolean {
  return Boolean(cam.mac && cam.p2pId && cam.enr && cam.ip && cam.productModel)
}

/**
 * Decode a batch of cloud events into the most-recent motion observation
 * for ONE camera. Returns `null` when no `motion` alarm is present.
 * Pure — the caller decides whether the timestamp is newer than the last
 * one it acted on.
 *
 * `aiTags` (person/vehicle/pet/package) are surfaced for free so a
 * downstream consumer can enrich the motion signal.
 */
export interface MotionObservation {
  readonly timestamp: number
  readonly aiTags: readonly string[]
  readonly eventId: string
}

export function latestMotionEvent(
  events: readonly WyzeEvent[],
  mac: string,
): MotionObservation | null {
  let best: MotionObservation | null = null
  for (const ev of events) {
    if (ev.deviceMac !== mac) continue
    if (ev.alarmType !== 'motion') continue
    if (best === null || ev.timestamp > best.timestamp) {
      best = { timestamp: ev.timestamp, aiTags: ev.aiTags, eventId: ev.eventId }
    }
  }
  return best
}

/**
 * The newest image thumbnail URL for a camera across a batch of events.
 * Used as the cloud-thumbnail snapshot fallback when no live P2P session
 * exists. Returns `null` when no image file is present.
 */
export function latestThumbnailUrl(events: readonly WyzeEvent[], mac: string): string | null {
  let bestTs = -1
  let bestUrl: string | null = null
  for (const ev of events) {
    if (ev.deviceMac !== mac) continue
    for (const f of ev.files) {
      if (f.type !== 'image' || !f.url) continue
      if (ev.timestamp > bestTs) {
        bestTs = ev.timestamp
        bestUrl = f.url
      }
    }
  }
  return bestUrl
}
