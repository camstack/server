/**
 * The fake decode child and admitting pump the drain specs share (D652, D656):
 * the real pump + coordinator + registry, driven against a scripted child.
 */
import type { IScopedLogger } from '@camstack/types'
import { vi } from 'vitest'
import type { LocalFrameRegistry } from '../local-frame-registry.js'
import type { ForkedChildLike } from '../session-decode-coordinator.js'
import { type NativeCropRequester, startSessionDecodePump } from '../session-decode-pump.js'
import type { DecodedFrame, FrameRef, FrameViewSpec } from '@camstack/types'
import type { WorkerReply, WorkerRequest } from '../worker-protocol.js'
import { testLease } from './test-lease-knobs.js'

/**
 * A fake child that answers each `pull` with the next scripted frame and each
 * `toBuffer` only when the test says so — so a test can hold a read in flight
 * across the teardown, which is precisely the production race.
 */
export function scriptedChild(frames: number): {
  child: ForkedChildLike
  sent: WorkerRequest[]
  kill: ReturnType<typeof vi.fn>
  answerToBuffer(frameId: number): void
  reply(r: WorkerReply): void
  /** A live stream answers the pull that was outstanding at teardown with its next frame. */
  deliverPendingPull(): void
  exit(): void
} {
  const sent: WorkerRequest[] = []
  const messageHandlers: Array<(m: unknown) => void> = []
  const exitHandlers: Array<(m: unknown) => void> = []
  let nextFrameId = 1
  let pullOutstanding = false
  const reply = (r: WorkerReply): void => {
    for (const h of messageHandlers) h(r)
  }
  const kill = vi.fn()
  const child: ForkedChildLike = {
    send: (msg: WorkerRequest) => {
      sent.push(msg)
      if (msg.kind !== 'pull') return
      if (nextFrameId > frames) {
        pullOutstanding = true
        return
      }
      const frameId = nextFrameId++
      queueMicrotask(() =>
        reply({ kind: 'frame', frameId, timestamp: frameId, width: 4, height: 2, format: 'rgb' }),
      )
    },
    on: (ev: 'message' | 'exit', cb: (m: unknown) => void) => {
      if (ev === 'message') messageHandlers.push(cb)
      else exitHandlers.push(cb)
    },
    kill,
  }
  return {
    child,
    sent,
    kill,
    reply,
    answerToBuffer: (frameId: number) =>
      reply({ kind: 'buffer', frameId, bytes: new Uint8Array([frameId]) }),
    deliverPendingPull: () => {
      if (!pullOutstanding) return
      pullOutstanding = false
      const frameId = nextFrameId++
      reply({ kind: 'frame', frameId, timestamp: frameId, width: 4, height: 2, format: 'rgb' })
    },
    exit: () => {
      for (const h of exitHandlers) h({ code: 0, signal: null })
    },
  }
}

export function makeLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

export const source = { restreamUrl: 'rtsp://cam/101', deviceId: 101, codec: 'h264' }
export const VIEW: FrameViewSpec = {
  content: { width: 4, height: 2 },
  fit: 'contain',
  format: 'rgb',
}

/** Start a pump that ADMITS every frame, the way the runner's queue does. */
export function startAdmittingPump(
  fake: ReturnType<typeof scriptedChild>,
  registry: LocalFrameRegistry,
  logger: IScopedLogger,
  onAdmit?: (frame: DecodedFrame, nativeCrop: NativeCropRequester | undefined) => void,
): { admitted: FrameRef[]; teardown: ReturnType<typeof startSessionDecodePump> } {
  const admitted: FrameRef[] = []
  const teardown = startSessionDecodePump({
    fork: () => fake.child,
    lease: testLease,
    hwaccel: () => null,
    logger,
    source,
    opts: { fps: 10, format: 'rgb' },
    frameRegistry: registry,
    onFrameRef: (frame: DecodedFrame, nativeCrop?: NativeCropRequester) => {
      if (frame.frameRef) admitted.push(frame.frameRef)
      onAdmit?.(frame, nativeCrop)
      return true
    },
    onDecodedFrame: () => undefined,
  })
  return { admitted, teardown }
}
