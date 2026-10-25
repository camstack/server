/**
 * A decode-worker fork carries NO configuration (D453).
 *
 * Until D453 `forkDecodeWorker` spread a set of `*_SETTING` env vars into the
 * child, because the child resolved its native-lease knobs at module load. Two
 * things came of that, and both are what this pins the inverse of:
 *
 * - a child was bound to the knobs it was BORN with, so a worker could never be
 *   forked before the camera it would serve was known;
 * - resolving the knobs needed the Zod schemas, which dragged the whole
 *   `@camstack/types` index into the child bundle — measured on the hub,
 *   ~170 ms and ~100 MB of heap on every single fork.
 *
 * The knobs now travel on `start` (`WorkerRequest.lease`, covered by
 * `session-lease-on-start.spec.ts`). What is left here is the fork itself: a
 * neutral spawn that still inherits the environment node-av resolution depends
 * on, and still speaks advanced serialization.
 */

import type { ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const forkMock = vi.fn()

vi.mock('node:child_process', () => ({
  fork: (...args: unknown[]): unknown => forkMock(...args),
}))

/** The minimal ChildProcess surface `wrapChild` touches. */
function fakeChild(): ChildProcess {
  const child = {
    connected: true,
    on: vi.fn(),
    send: vi.fn(),
    kill: vi.fn(),
  }
  // The wrapper only calls on/send/kill/connected — a structural fake suffices.
  return child as unknown as ChildProcess
}

const { forkDecodeWorker } = await import('../fork-decode-worker.js')

const SOURCE = { restreamUrl: 'rtsp://x/y', deviceId: 101, codec: 'h264' }

/** The `options` argument of the recorded `fork` call. */
function forkOptions(): Record<string, unknown> {
  const call = forkMock.mock.calls[0]
  expect(call).toBeDefined()
  const options = call?.[2]
  expect(typeof options).toBe('object')
  return { ...Object(options) }
}

function forkEnv(): Record<string, string | undefined> {
  return { ...Object(forkOptions()['env']) }
}

describe('forkDecodeWorker — a neutral spawn', () => {
  beforeEach(() => {
    forkMock.mockReset()
    forkMock.mockReturnValue(fakeChild())
  })

  it('writes no lease configuration into the child environment', () => {
    forkDecodeWorker(SOURCE)
    const env = forkEnv()
    const configured = Object.keys(env).filter((name) => name.endsWith('_SETTING'))
    expect(configured).toEqual([])
  })

  it('takes no configuration argument at all — the signature is (source, deps)', () => {
    // Not a type assertion: `length` is the runtime arity, and a third
    // parameter reappearing here would mean a knob had crept back onto the
    // spawn, which is the thing a pre-forked worker cannot survive. `deps` is
    // accounting only (cost claim, live-worker set — D666), never config.
    expect(forkDecodeWorker.length).toBe(2)
  })

  it('preserves the inherited environment (node-av resolution depends on it)', () => {
    process.env['CAMSTACK_FORK_ENV_PROBE'] = 'kept'
    try {
      forkDecodeWorker(SOURCE)
      expect(forkEnv()['CAMSTACK_FORK_ENV_PROBE']).toBe('kept')
    } finally {
      delete process.env['CAMSTACK_FORK_ENV_PROBE']
    }
  })

  it('keeps advanced serialization — the buffer reply must stay a real Uint8Array', () => {
    forkDecodeWorker(SOURCE)
    expect(forkOptions()['serialization']).toBe('advanced')
  })
})
