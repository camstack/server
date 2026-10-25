import type { IScopedLogger, TerminalSessionInfo } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { type TerminalCameraApi, TerminalCameraRelay } from '../terminal-camera-relay.js'
import {
  renderTerminalJpeg,
  TERMINAL_CAMERA_COLS,
  TERMINAL_CAMERA_ROWS,
} from '../terminal-frame-renderer.js'
import { createXtermScreen } from '../xterm-screen.js'

const logger: IScopedLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
  withTags: () => logger,
}

function sessionInfo(): TerminalSessionInfo {
  return {
    sessionId: 'camera-session',
    profileId: 'monitor',
    label: 'System Monitor',
    cols: 120,
    rows: 40,
    startedAt: 1,
  }
}

describe('TerminalCameraRelay', () => {
  it('serves a remote terminal session as an MJPEG stream and closes it on dispose', async () => {
    const closeSession = vi.fn(async () => {})
    const api: TerminalCameraApi = {
      listProfiles: async () => [{ profileId: 'monitor', label: 'System Monitor' }],
      openSession: async () => sessionInfo(),
      pullOutput: async () => ({
        cursor: 1,
        reset: true,
        snapshot: 'CPU 12%\r\nMemory 42%',
        events: [],
      }),
      closeSession,
    }
    const relay = new TerminalCameraRelay(api, logger)
    await relay.start()
    const controller = new AbortController()
    const response = await fetch(relay.streamUrl('instance-a', 'agent-a', 'monitor'), {
      signal: controller.signal,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('multipart/x-mixed-replace')

    const reader = response.body!.getReader()
    let bytes = Buffer.alloc(0)
    while (bytes.length < 1024) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes = Buffer.concat([bytes, Buffer.from(chunk.value)])
    }
    controller.abort()

    expect(bytes.includes(Buffer.from('Content-Type: image/jpeg'))).toBe(true)
    expect(bytes.indexOf(Buffer.from([0xff, 0xd8]))).toBeGreaterThan(0)
    await relay.dispose()
    expect(closeSession).toHaveBeenCalledWith('agent-a', 'camera-session')
  })

  it('renders fresh JPEG snapshots with isolated short-lived sessions per instance', async () => {
    const closeSession = vi.fn(async () => {})
    const openSession = vi.fn(async () => sessionInfo())
    let pulls = 0
    const pullOutput = vi.fn(async () => {
      pulls += 1
      return pulls % 2 === 1
        ? {
            cursor: 1,
            reset: true,
            snapshot: 'CPU 12%\r\nMemory 42%',
            events: [],
          }
        : { cursor: 1, reset: false, events: [] }
    })
    const api: TerminalCameraApi = {
      listProfiles: async () => [{ profileId: 'monitor', label: 'System Monitor' }],
      openSession,
      pullOutput,
      closeSession,
    }
    const relay = new TerminalCameraRelay(api, logger)
    await relay.start()

    const jpeg = await relay.snapshot('instance-a', 'agent-a', 'monitor')
    const nextJpeg = await relay.snapshot('instance-b', 'agent-a', 'monitor')

    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(nextJpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(openSession).toHaveBeenCalledTimes(2)
    // Each snapshot performs the startup pull plus one settle pull that comes
    // back quiet before rendering.
    expect(pullOutput).toHaveBeenCalledTimes(4)
    expect(pullOutput).toHaveBeenNthCalledWith(1, 'agent-a', {
      sessionId: 'camera-session',
      afterSeq: 0,
      waitMs: 1_500,
      waitForOutput: true,
    })
    expect(pullOutput).toHaveBeenNthCalledWith(2, 'agent-a', {
      sessionId: 'camera-session',
      afterSeq: 1,
      waitMs: 300,
      waitForOutput: true,
    })
    expect(closeSession).toHaveBeenCalledTimes(2)
    expect(closeSession).toHaveBeenNthCalledWith(1, 'agent-a', 'camera-session')
    await relay.dispose()
  })

  it('keeps pulling a fresh session until output settles before rendering the snapshot', async () => {
    const closeSession = vi.fn(async () => {})
    // The startup pull wakes on the FIRST output event — typically the
    // program's clear-screen, before it has painted anything. The relay must
    // keep draining until the stream goes quiet, or it renders an empty frame.
    const batches = [
      { cursor: 1, reset: true, snapshot: '[2J[H', events: [] },
      {
        cursor: 2,
        reset: false,
        events: [{ seq: 2, kind: 'data' as const, data: 'CPU 99%' }],
      },
      { cursor: 2, reset: false, events: [] },
    ]
    let call = 0
    const pullOutput = vi.fn(async () => batches[Math.min(call++, batches.length - 1)]!)
    const api: TerminalCameraApi = {
      listProfiles: async () => [{ profileId: 'monitor', label: 'System Monitor' }],
      openSession: async () => sessionInfo(),
      pullOutput,
      closeSession,
    }
    const relay = new TerminalCameraRelay(api, logger)
    await relay.start()

    const jpeg = await relay.snapshot('instance-a', 'agent-a', 'monitor')

    const screen = createXtermScreen(TERMINAL_CAMERA_COLS, TERMINAL_CAMERA_ROWS)
    screen.write('[2J[H')
    screen.write('CPU 99%')
    await screen.flush()
    const expected = await renderTerminalJpeg(screen.styledLines())
    screen.dispose()

    expect(pullOutput).toHaveBeenCalledTimes(3)
    // Pixel-identical frames need fontconfig; the CI runner's container often
    // has none (terminal-frame-renderer.spec.ts owns glyph fidelity). Here the
    // contract is settle-then-render: three pulls, one JPEG, one close.
    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(expected.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(closeSession).toHaveBeenCalledTimes(1)
    await relay.dispose()
  })

  it('stops settling when the session exits during the drain', async () => {
    const closeSession = vi.fn(async () => {})
    const batches = [
      { cursor: 1, reset: true, snapshot: 'READY', events: [] },
      {
        cursor: 2,
        reset: false,
        events: [{ seq: 2, kind: 'exit' as const, exitCode: 1 }],
      },
    ]
    let call = 0
    const pullOutput = vi.fn(async () => batches[Math.min(call++, batches.length - 1)]!)
    const api: TerminalCameraApi = {
      listProfiles: async () => [{ profileId: 'monitor', label: 'System Monitor' }],
      openSession: async () => sessionInfo(),
      pullOutput,
      closeSession,
    }
    const relay = new TerminalCameraRelay(api, logger)
    await relay.start()

    const jpeg = await relay.snapshot('instance-a', 'agent-a', 'monitor')

    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(pullOutput).toHaveBeenCalledTimes(2)
    await relay.dispose()
  })

  it('closes a session after a pull failure before a later snapshot opens another', async () => {
    let opened = 0
    let pulls = 0
    const closeSession = vi.fn(async () => {})
    const api: TerminalCameraApi = {
      listProfiles: async () => [{ profileId: 'monitor', label: 'System Monitor' }],
      openSession: async () => ({
        ...sessionInfo(),
        sessionId: `camera-session-${String(++opened)}`,
      }),
      pullOutput: async () => {
        pulls += 1
        if (pulls === 1) throw new Error('transient terminal RPC failure')
        return {
          cursor: 1,
          reset: true,
          snapshot: 'READY',
          events: [],
        }
      },
      closeSession,
    }
    const relay = new TerminalCameraRelay(api, logger)
    await relay.start()

    await expect(relay.snapshot('instance-a', 'agent-a', 'monitor')).rejects.toThrow(
      'transient terminal RPC failure',
    )
    expect(closeSession).toHaveBeenCalledWith('agent-a', 'camera-session-1')

    const jpeg = await relay.snapshot('instance-a', 'agent-a', 'monitor')
    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(opened).toBe(2)
    expect(closeSession).toHaveBeenCalledWith('agent-a', 'camera-session-2')
    await relay.dispose()
  })

  it('retries a transient close failure without opening a replacement session', async () => {
    const openSession = vi.fn(async () => sessionInfo())
    let closeAttempts = 0
    const closeSession = vi.fn(async () => {
      closeAttempts += 1
      if (closeAttempts === 1) throw new Error('temporary close RPC failure')
    })
    const api: TerminalCameraApi = {
      listProfiles: async () => [{ profileId: 'monitor', label: 'System Monitor' }],
      openSession,
      pullOutput: async () => ({
        cursor: 1,
        reset: true,
        snapshot: 'READY',
        events: [],
      }),
      closeSession,
    }
    const relay = new TerminalCameraRelay(api, logger)
    await relay.start()

    const jpeg = await relay.snapshot('instance-a', 'agent-a', 'monitor')

    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(closeSession).toHaveBeenCalledTimes(2)
    expect(openSession).toHaveBeenCalledOnce()
    await relay.dispose()
  })

  it('closes a session that resolves after closeInstance races its open RPC', async () => {
    let resolveOpen!: (session: TerminalSessionInfo) => void
    const openSession = vi.fn(
      () =>
        new Promise<TerminalSessionInfo>((resolve) => {
          resolveOpen = resolve
        }),
    )
    const closeSession = vi.fn(async () => {})
    const api: TerminalCameraApi = {
      listProfiles: async () => [{ profileId: 'monitor', label: 'System Monitor' }],
      openSession,
      pullOutput: async () => ({
        cursor: 1,
        reset: true,
        snapshot: 'READY',
        events: [],
      }),
      closeSession,
    }
    const relay = new TerminalCameraRelay(api, logger)
    await relay.start()

    const snapshot = relay.snapshot('instance-a', 'agent-a', 'monitor')
    await Promise.resolve()
    const closing = relay.closeInstance('instance-a')
    resolveOpen({ ...sessionInfo(), sessionId: 'late-session' })

    await expect(snapshot).rejects.toThrow(/closed while opening/)
    await closing
    expect(openSession).toHaveBeenCalledOnce()
    expect(closeSession).toHaveBeenCalledWith('agent-a', 'late-session')
    await relay.dispose()
  })

  it('finalizes a close when a pending open rejects, allowing a later open', async () => {
    let rejectOpen!: (error: Error) => void
    const openSession = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<TerminalSessionInfo>((_resolve, reject) => {
            rejectOpen = reject
          }),
      )
      .mockImplementationOnce(async () => sessionInfo())
    const closeSession = vi.fn(async () => {})
    const api: TerminalCameraApi = {
      listProfiles: async () => [{ profileId: 'monitor', label: 'System Monitor' }],
      openSession,
      pullOutput: async () => ({
        cursor: 1,
        reset: true,
        snapshot: 'READY',
        events: [],
      }),
      closeSession,
    }
    const relay = new TerminalCameraRelay(api, logger)
    await relay.start()

    const pendingSnapshot = relay.snapshot('instance-a', 'agent-a', 'monitor')
    await Promise.resolve()
    const closing = relay.closeInstance('instance-a')
    rejectOpen(new Error('open RPC failed'))

    await expect(pendingSnapshot).rejects.toThrow('open RPC failed')
    await closing
    expect(closeSession).not.toHaveBeenCalled()

    const jpeg = await relay.snapshot('instance-a', 'agent-a', 'monitor')
    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(openSession).toHaveBeenCalledTimes(2)
    expect(closeSession).toHaveBeenCalledWith('agent-a', 'camera-session')
    await relay.dispose()
  })

  /**
   * The path the STREAM BROKER actually takes when it stops pulling.
   *
   * A terminal camera is a `pull-http` broker source: the broker's ffmpeg
   * source reader is the relay's only HTTP client. When the broker suspends
   * for want of demand it destroys that reader, the socket closes, and the
   * ONLY thing that must then reclaim the PTY is `serve()`'s finally →
   * `clients` hits 0 → `scheduleIdleClose` (30 s) → `closeState` →
   * `api.closeSession`, which is `TerminalSessionManager.close` →
   * `session.pty.kill()`.
   *
   * Every other close test here drives `dispose()` or `closeInstance()` —
   * an addon-shutdown / camera-withdrawn path the broker never takes. Without
   * this scenario "the relay tears down when the broker lets go" is an
   * unverified claim, and the whole point of making `pull-http` lazy-dial is
   * that this chain runs.
   */
  it('closes the session (killing the PTY) 30 s after its only HTTP client — the broker — disconnects', async () => {
    const closeSession = vi.fn(async () => {})
    const api: TerminalCameraApi = {
      listProfiles: async () => [{ profileId: 'monitor', label: 'System Monitor' }],
      openSession: async () => sessionInfo(),
      pullOutput: async () => ({
        cursor: 1,
        reset: true,
        snapshot: 'CPU 12%',
        events: [],
      }),
      closeSession,
    }
    // Fake time for the WHOLE scenario so both the relay's frame-pacing
    // timeout and its 30 s idle timer are fast-forwardable; `shouldAdvanceTime`
    // keeps the real clock driving the real HTTP socket underneath.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const relay = new TerminalCameraRelay(api, logger)
    try {
      await relay.start()

      const controller = new AbortController()
      const response = await fetch(relay.streamUrl('instance-a', 'agent-a', 'monitor'), {
        signal: controller.signal,
      })
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      await reader.read()

      // The broker goes away (ffmpeg reader destroyed → socket closed). No
      // dispose(), no closeInstance() — only the disconnect.
      controller.abort()
      expect(closeSession).not.toHaveBeenCalled()

      for (let i = 0; i < 40 && closeSession.mock.calls.length === 0; i += 1) {
        await vi.advanceTimersByTimeAsync(2_000)
      }

      expect(closeSession).toHaveBeenCalledWith('agent-a', 'camera-session')
      await relay.dispose()
      // The disconnect alone reclaimed it — dispose had nothing left to close.
      expect(closeSession).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
