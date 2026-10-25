import { randomUUID } from 'node:crypto'
import type { FrameRef, FrameViewSpec, MaterializedFrameView } from '@camstack/types'
import { resolveFrameViewGeometry } from './frame-view-geometry.js'
import { isSessionDecodeReadGone } from './session-decode-read-gone.js'
import type { FrameImage } from './video-frame-generator.js'

export type FrameReleaseReason = 'success' | 'error' | 'drop' | 'detach' | 'eviction'

/**
 * Why a reference holds a frame (D656).
 *
 * `consumer` — somebody is going to READ it while its worker lives: the owner
 * reference the pump takes at {@link LocalFrameRegistry.register} and hands to
 * the runner (queued, in flight), and every short lease a reader takes to
 * resolve a view. `retention` — the frame is PARKED for a read that may come
 * later (the on-demand JPEG fallback a detection leaves behind), so the frame
 * is worth keeping while the worker lives and is not worth keeping the worker
 * for. A session drain waits on the first kind only.
 */
export type FrameHolder = 'consumer' | 'retention'
export type FrameViewResolution =
  | ({ readonly kind: 'view' } & MaterializedFrameView)
  | { readonly kind: 'miss'; readonly reason: 'foreign-registry' | 'stale-ref' }

interface RegistryEntry {
  readonly ref: FrameRef
  readonly image: FrameImage
  readonly estimatedBytes: number
  refs: number
  /** The part of {@link refs} held by a {@link FrameHolder} `consumer`. */
  consumerRefs: number
  releaseNativeOnClose: boolean
}

export interface LocalFrameRegistryOptions {
  readonly registryId?: string
  readonly maxFrames?: number
  readonly maxBytes?: number
}

export interface LocalFrameLease {
  resolve(spec: FrameViewSpec): Promise<FrameViewResolution>
  release(reason: FrameReleaseReason): void
}

const DEFAULT_MAX_FRAMES = 24
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024

function estimateFrameBytes(image: FrameImage): number {
  return image.width * image.height * (image.format === 'gray' ? 1 : 3)
}

function releasesNative(reason: FrameReleaseReason): boolean {
  return reason !== 'success'
}

/**
 * Bounded process-local registry. A serialized ref from another process misses
 * by registry id; an evicted id never aliases a newer frame. View resolution
 * is lease-only ({@link acquire} → {@link LocalFrameLease.resolve}) so an
 * in-flight `toBuffer()` is covered by `refs > 1` and cannot be LRU-evicted.
 */
export class LocalFrameRegistry {
  readonly registryId: string
  private readonly maxFrames: number
  private readonly maxBytes: number
  private readonly entries = new Map<string, RegistryEntry>()
  private bytes = 0
  private releaseCount = 0
  private evictionCount = 0
  private staleMissCount = 0

  constructor(options: LocalFrameRegistryOptions = {}) {
    this.registryId = options.registryId ?? `${process.pid}-${randomUUID()}`
    this.maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  }

  get size(): number {
    return this.entries.size
  }

  get estimatedBytes(): number {
    return this.bytes
  }

  getStats(): {
    readonly residentFrames: number
    readonly residentRefs: number
    readonly residentBytes: number
    readonly releases: number
    readonly evictions: number
    readonly staleMisses: number
  } {
    let residentRefs = 0
    for (const entry of this.entries.values()) residentRefs += entry.refs
    return {
      residentFrames: this.entries.size,
      residentRefs,
      residentBytes: this.bytes,
      releases: this.releaseCount,
      evictions: this.evictionCount,
      staleMisses: this.staleMissCount,
    }
  }

  register(
    image: FrameImage,
    metadata: { readonly timestamp: number; readonly capturedAt?: number },
  ): FrameRef | null {
    const estimatedBytes = estimateFrameBytes(image)
    if (this.maxFrames < 1 || estimatedBytes > this.maxBytes) {
      image.close()
      image.releaseNativeLease?.()
      return null
    }
    const ref: FrameRef = {
      registryId: this.registryId,
      id: randomUUID(),
      width: image.width,
      height: image.height,
      format: image.format,
      timestamp: metadata.timestamp,
      ...(metadata.capturedAt !== undefined ? { capturedAt: metadata.capturedAt } : {}),
    }
    this.entries.set(ref.id, {
      ref,
      image,
      estimatedBytes,
      refs: 1,
      consumerRefs: 1,
      releaseNativeOnClose: false,
    })
    this.bytes += estimatedBytes
    this.evictToBounds()
    return this.entries.has(ref.id) ? ref : null
  }

  /**
   * Take a lease on `ref`. `holder` says why (D656): a reader that resolves a
   * view now is a `consumer` (the default); a lease PARKED for a read that may
   * come later is `retention`, and does not keep a draining worker alive.
   */
  acquire(ref: FrameRef, holder: FrameHolder = 'consumer'): LocalFrameLease | null {
    if (ref.registryId === this.registryId && !this.entries.has(ref.id)) this.staleMissCount += 1
    const entry = this.getEntry(ref)
    if (!entry) return null
    entry.refs += 1
    if (holder === 'consumer') this.addConsumer(entry)
    this.touch(entry)
    let released = false
    return {
      resolve: (spec) => this.resolveFromLease(entry, spec),
      release: (reason) => {
        if (released) return
        released = true
        this.releaseRef(ref, reason, holder)
      },
    }
  }

  /** Release the OWNER reference {@link register} took — a consumer reference. */
  release(ref: FrameRef, reason: FrameReleaseReason): void {
    this.releaseRef(ref, reason, 'consumer')
  }

  private releaseRef(ref: FrameRef, reason: FrameReleaseReason, holder: FrameHolder): void {
    const entry = this.getEntry(ref)
    if (!entry) return
    this.releaseCount += 1
    if (releasesNative(reason)) entry.releaseNativeOnClose = true
    entry.refs = Math.max(0, entry.refs - 1)
    if (entry.refs === 0) {
      this.drop(entry)
      return
    }
    if (holder === 'consumer') this.removeConsumer(entry)
  }

  /**
   * The frame's source learns whether a consumer still holds it, on each
   * transition only: the last consumer letting go of a frame that stays
   * PARKED, and a consumer coming back to one. A drop needs no signal — the
   * image is closed.
   */
  private addConsumer(entry: RegistryEntry): void {
    entry.consumerRefs += 1
    if (entry.consumerRefs === 1) entry.image.setPendingConsumer?.(true)
  }

  private removeConsumer(entry: RegistryEntry): void {
    if (entry.consumerRefs === 0) return
    entry.consumerRefs -= 1
    if (entry.consumerRefs === 0) entry.image.setPendingConsumer?.(false)
  }

  clear(reason: FrameReleaseReason = 'detach'): void {
    for (const entry of [...this.entries.values()]) {
      if (releasesNative(reason)) entry.releaseNativeOnClose = true
      this.drop(entry)
    }
  }

  private getEntry(ref: FrameRef): RegistryEntry | null {
    if (ref.registryId !== this.registryId) return null
    return this.entries.get(ref.id) ?? null
  }

  private touch(entry: RegistryEntry): void {
    this.entries.delete(entry.ref.id)
    this.entries.set(entry.ref.id, entry)
  }

  /**
   * Materialize a view for a live lease only. Public callers must go through
   * {@link acquire} so `refs > 1` covers the whole `toBuffer()` window.
   */
  private async resolveFromLease(
    entry: RegistryEntry,
    spec: FrameViewSpec,
  ): Promise<FrameViewResolution> {
    if (!this.entries.has(entry.ref.id)) return { kind: 'miss', reason: 'stale-ref' }
    this.touch(entry)
    const geometry = resolveFrameViewGeometry(entry.image.width, entry.image.height, spec)
    try {
      const data = await entry.image.toBuffer({
        crop: geometry.sourceCrop,
        resize: geometry.output,
        format: spec.format,
      })
      return {
        kind: 'view',
        data,
        width: geometry.output.width,
        height: geometry.output.height,
        format: spec.format,
        geometry,
      }
    } catch (err: unknown) {
      // D656: a named refusal after teardown is a miss, never a worker fault
      // that surfaces as `runInference failed` (live Mac bursts: frameId 1–8
      // at session end → `worker already exited`).
      if (isSessionDecodeReadGone(err)) return { kind: 'miss', reason: 'stale-ref' }
      throw err
    }
  }

  /** Oldest owner-only / queued entry (`refs === 1`). Consumer leases (`refs > 1`) stay. */
  private findOwnerOnlyVictim(): RegistryEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.refs <= 1) return entry
    }
    return undefined
  }

  private evictToBounds(): void {
    while (this.entries.size > this.maxFrames || this.bytes > this.maxBytes) {
      const victim = this.findOwnerOnlyVictim()
      if (!victim) break
      victim.releaseNativeOnClose = true
      this.evictionCount += 1
      this.drop(victim)
    }
  }

  private drop(entry: RegistryEntry): void {
    if (!this.entries.delete(entry.ref.id)) return
    this.bytes = Math.max(0, this.bytes - entry.estimatedBytes)
    entry.image.close()
    if (entry.releaseNativeOnClose) entry.image.releaseNativeLease?.()
  }
}

/** Shared only by addons in the same grouped runner process. */
export const localFrameRegistry = new LocalFrameRegistry({
  maxFrames: DEFAULT_MAX_FRAMES,
  maxBytes: DEFAULT_MAX_BYTES,
})
