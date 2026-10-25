import type { DecodedFrame, FrameHandle, FrameRef, FrameResult } from '@camstack/types'
import type {
  FrameReleaseReason,
  LocalFrameRegistry,
} from '../session-decode/local-frame-registry.js'
import { createOnDemandJpegFallback } from '../session-decode/on-demand-jpeg-fallback.js'
import { createRetainedContentFallback } from '../session-decode/retained-content-fallback.js'
import { RetainedFrameStore } from '../session-decode/retained-frame-store.js'
import { FrameLazyTelemetry } from './frame-lazy-metrics.js'

export const CAMSTACK_CONTINUOUS_RETAIN = 'CAMSTACK_CONTINUOUS_RETAIN'

export function isContinuousRetainEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return env[CAMSTACK_CONTINUOUS_RETAIN] === '1'
}

export function shouldRetainDetectionFrame(input: {
  readonly admitted: boolean
  readonly hasDetection: boolean
  readonly continuousRetain: boolean
}): boolean {
  if (!input.admitted) return false
  if (input.continuousRetain) return true
  return input.hasDetection
}

export type NotificationMediaChannel = 'detection-retention' | 'camera-snapshot' | 'recorded-still'

/**
 * Detection-retention is the only channel that requires a detection. Camera
 * snapshots and recorded stills are direct pulls and stay available without one.
 */
export function canRecoverNotificationMedia(input: {
  readonly channel: NotificationMediaChannel
  readonly hasDetection: boolean
  readonly handleAvailable: boolean
}): boolean {
  if (input.channel !== 'detection-retention') return true
  return input.hasDetection && input.handleAvailable
}

export type OnDemandCropSource = 'native' | 'tile' | 'recorded-still' | 'fallback-jpeg' | 'miss'

export function resolveOnDemandCropSource(input: {
  readonly nativeHit: boolean
  readonly tileHit: boolean
  readonly recordedStillHit: boolean
}): OnDemandCropSource {
  if (input.nativeHit) return 'native'
  if (input.tileHit) return 'tile'
  if (input.recordedStillHit) return 'recorded-still'
  return 'fallback-jpeg'
}

/**
 * The ONE place the cross-node crop wire format is decided (D462).
 *
 * `jpeg` arrives as the bytes the encoder produced. Whether they leave as
 * those bytes or as a base64 string is not this function's preference — it is
 * the CALLER'S declaration, `acceptBytes`, and an absent declaration means the
 * old wire. A pre-D462 consumer does `Buffer.from(reply.jpeg, 'base64')`, so
 * reading a missing flag as consent would hand it a `Uint8Array` to parse as
 * base64 and it would decode to garbage rather than fail.
 *
 * Base64 cost ~400 MB/min of hub-main relay traffic and, on the decoded half
 * of that, a multi-megabyte string in old space per call.
 */
export function encodeCrossNodeCrop(input: {
  readonly jpeg?: Uint8Array
  readonly bytes?: Uint8Array
  readonly acceptBytes?: boolean
  readonly frameRef?: unknown
}): { readonly jpeg?: string; readonly jpegBytes?: Uint8Array } | null {
  if (!input.jpeg || input.jpeg.byteLength === 0) return null
  if (input.acceptBytes === true) return { jpegBytes: input.jpeg }
  return { jpeg: Buffer.from(input.jpeg).toString('base64') }
}

function handleKey(handle: Pick<FrameHandle, 'shmId' | 'slot' | 'seq'>): string {
  return `${handle.shmId}#${handle.slot}#${handle.seq}`
}

export type OnDemandMediaRequest =
  | {
      readonly kind: 'full-frame'
      readonly nativeHit?: {
        readonly bytes: Uint8Array
        readonly width: number
        readonly height: number
      }
      readonly tileHit?: {
        readonly bytes: Uint8Array
        readonly width: number
        readonly height: number
        readonly jpeg?: boolean
      }
      readonly recordedStillHit?: {
        readonly jpeg: Uint8Array
        readonly width: number
        readonly height: number
      }
    }
  | {
      readonly kind: 'crop'
      readonly nativeHit?: {
        readonly bytes: Uint8Array
        readonly width: number
        readonly height: number
      }
      readonly tileHit?: {
        readonly bytes: Uint8Array
        readonly width: number
        readonly height: number
        readonly jpeg?: boolean
      }
      readonly recordedStillHit?: {
        readonly jpeg: Uint8Array
        readonly width: number
        readonly height: number
      }
    }

export type OnDemandMediaResult = {
  readonly tier: OnDemandCropSource
  readonly bytes?: Uint8Array
  readonly jpeg?: Uint8Array
  readonly width?: number
  readonly height?: number
}

export interface OnDemandRetentionSessionOptions {
  readonly store: RetainedFrameStore
  readonly registry: LocalFrameRegistry
  readonly telemetry: FrameLazyTelemetry
  readonly nodeId: string
  readonly continuousRetain: boolean
}

interface PendingAdmission {
  readonly deviceId: number
  readonly ref?: FrameRef
}

/**
 * Pending occupancy exists only admission → inference result. A detection
 * transfers to {@link RetainedFrameStore} (authoritative late-media owner).
 * No-detection leaves zero state. Store eviction owns fallback cleanup.
 */
export class OnDemandRetentionSession {
  private readonly store: RetainedFrameStore
  private readonly registry: LocalFrameRegistry
  private readonly telemetry: FrameLazyTelemetry
  private readonly continuousRetain: boolean
  private readonly pending = new Map<string, PendingAdmission>()

  constructor(options: OnDemandRetentionSessionOptions) {
    this.store = options.store
    this.registry = options.registry
    this.telemetry = options.telemetry
    this.continuousRetain = options.continuousRetain
  }

  get pendingSize(): number {
    return this.pending.size
  }

  hasPending(handle: Pick<FrameHandle, 'shmId' | 'slot' | 'seq'>): boolean {
    return this.pending.has(handleKey(handle))
  }

  admitFrame(deviceId: number, frame: DecodedFrame): FrameHandle | undefined {
    if (this.continuousRetain) {
      const fallback = frame.frameRef
        ? createRetainedContentFallback(this.registry, frame.frameRef)
        : undefined
      const handle = this.store.write(deviceId, frame, fallback) ?? undefined
      if (handle) this.pending.set(handleKey(handle), { deviceId, ref: frame.frameRef })
      this.refreshResident()
      return handle
    }
    const handle = this.store.allocateHandle(deviceId, frame) ?? undefined
    if (!handle) return undefined
    this.pending.set(handleKey(handle), { deviceId, ref: frame.frameRef })
    this.telemetry.noteAvoidedWrite(deviceId)
    this.refreshResident()
    return handle
  }

  noteFrame(input: {
    readonly deviceId: number
    readonly decoded: boolean
    readonly admitted: boolean
    readonly droppedPixelFree: boolean
  }): void {
    if (input.decoded) this.telemetry.noteDecoded(input.deviceId)
    if (input.admitted) this.telemetry.noteAdmitted(input.deviceId)
    if (input.droppedPixelFree) this.telemetry.noteDroppedPixelFree(input.deviceId)
  }

  noteInferenceResult(
    deviceId: number,
    handle: FrameHandle | undefined,
    result: FrameResult,
  ): void {
    if (!handle) return
    const key = handleKey(handle)
    const pending = this.pending.get(key)
    this.forgetPending(key)
    const hasDetection = (result.detections?.length ?? 0) > 0
    if (
      !shouldRetainDetectionFrame({
        admitted: true,
        hasDetection,
        continuousRetain: this.continuousRetain,
      })
    ) {
      this.refreshResident()
      return
    }
    if (this.continuousRetain) {
      this.refreshResident()
      return
    }
    if (!pending?.ref) {
      this.refreshResident()
      return
    }
    const fallback = createOnDemandJpegFallback(this.registry, pending.ref)
    this.store.rememberOnDemand(deviceId, handle, fallback)
    this.refreshResident()
  }

  async requestMedia(
    handle: FrameHandle,
    request: OnDemandMediaRequest,
  ): Promise<OnDemandMediaResult> {
    const deviceId =
      this.store.getDeviceId(handle) ?? this.pending.get(handleKey(handle))?.deviceId ?? 0
    const kind = request.kind === 'full-frame' ? 'full-frame' : 'crop'
    this.telemetry.noteOnDemandRequest({ deviceId, kind })

    if (request.nativeHit) {
      this.telemetry.noteHit('native', deviceId)
      return {
        tier: 'native',
        bytes: request.nativeHit.bytes,
        width: request.nativeHit.width,
        height: request.nativeHit.height,
      }
    }
    this.telemetry.noteMiss('native', deviceId)
    if (request.tileHit) {
      this.telemetry.noteHit('tile', deviceId)
      return {
        tier: 'tile',
        bytes: request.tileHit.bytes,
        jpeg: request.tileHit.jpeg ? request.tileHit.bytes : undefined,
        width: request.tileHit.width,
        height: request.tileHit.height,
      }
    }
    this.telemetry.noteMiss('tile', deviceId)
    if (request.recordedStillHit) {
      return {
        tier: 'recorded-still',
        jpeg: request.recordedStillHit.jpeg,
        width: request.recordedStillHit.width,
        height: request.recordedStillHit.height,
      }
    }

    if (!this.continuousRetain && !this.store.has(handle)) {
      this.telemetry.noteMiss('fallback', deviceId)
      return { tier: 'miss' }
    }

    const view = await this.store.ensureContent(handle)
    if (view && view.data.byteLength > 0) {
      this.telemetry.noteHit('fallback', deviceId)
      this.refreshResident()
      if (view.format === 'jpeg') {
        return { tier: 'fallback-jpeg', jpeg: view.data, width: view.width, height: view.height }
      }
      return { tier: 'fallback-jpeg', bytes: view.data, width: view.width, height: view.height }
    }
    this.telemetry.noteMiss('fallback', deviceId)
    this.telemetry.noteStale(deviceId)
    return { tier: 'miss' }
  }

  /**
   * Pending cleanup. Success never invalidates a store entry already
   * transferred for late pull. Drop/error/detach drop the store only when the
   * handle was still pending (not yet transferred). Eviction owns transferred
   * fallback cleanup.
   */
  release(handle: FrameHandle, reason: FrameReleaseReason): void {
    const key = handleKey(handle)
    const pending = this.pending.get(key)
    this.forgetPending(key)
    if (reason !== 'success' && pending) this.store.drop(handle)
    this.telemetry.noteRelease(pending?.deviceId ?? this.store.getDeviceId(handle))
    this.refreshResident()
  }

  forgetDevice(deviceId: number): void {
    for (const [key, pending] of [...this.pending]) {
      if (pending.deviceId !== deviceId) continue
      this.pending.delete(key)
    }
    this.telemetry.forgetCamera(deviceId)
    this.refreshResident()
  }

  syncResident(): void {
    this.refreshResident()
  }

  private forgetPending(key: string): void {
    this.pending.delete(key)
  }

  private refreshResident(): void {
    const byDevice = new Map<number, { refs: number; bytes: number }>()
    for (const pending of this.pending.values()) {
      const cur = byDevice.get(pending.deviceId) ?? { refs: 0, bytes: 0 }
      cur.refs += 1
      byDevice.set(pending.deviceId, cur)
    }
    for (const stats of this.store.deviceStats()) {
      const cur = byDevice.get(stats.deviceId) ?? { refs: 0, bytes: 0 }
      cur.refs += stats.entries
      cur.bytes += stats.bytes
      byDevice.set(stats.deviceId, cur)
    }
    this.telemetry.setResident({
      refs: this.pending.size + this.store.size,
      bytes: this.registry.estimatedBytes + this.store.retainedBytes,
    })
    this.telemetry.zeroAbsentResidents(new Set(byDevice.keys()))
    for (const [deviceId, stats] of byDevice) {
      this.telemetry.setCameraResident(deviceId, stats)
    }
  }
}
