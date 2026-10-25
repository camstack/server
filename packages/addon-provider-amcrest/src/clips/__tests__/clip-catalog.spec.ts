/**
 * The `mediaFileFind` walk, against a fake camera that reproduces every trap
 * the real one was measured to have.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'

import type { AmcrestRpc2Client, AmcrestRpc2Result } from '../amcrest-rpc2-client.js'
import { CLIP_CONTROL_WINDOW, readClipRows } from '../clip-catalog.js'
import type { AmcrestCameraClock } from '../clip-clock.js'
import { CLIP_FIND_PAGE_SIZE } from '../clip-search.js'

const CLOCK: AmcrestCameraClock = { offsetMs: 2 * 60 * 60_000, readAtMs: 0 }
const DEVICE_ID = 3836

/** The refusal this camera gives for an empty window AND for a malformed
 *  search — byte-identical, measured four ways. */
const AMBIGUOUS_REFUSAL: AmcrestRpc2Result = {
  kind: 'refused',
  error: { code: 285_409_284, message: '' },
  params: {},
  session: null,
}

function row(startWall: string, endWall: string, length: number): Record<string, unknown> {
  return {
    Channel: 0,
    StartTime: startWall,
    EndTime: endWall,
    Duration: 74,
    Length: length,
    FilePath: `/mnt/sd/2026-09-23/001/dav/10/${startWall.slice(11).replace(/:/g, '.')}.mp4`,
    Events: ['VideoMotion'],
    Flags: ['Event'],
    Summary: { TrafficCar: { PlateNumber: ' ', Speed: 60 } },
  }
}

interface CatalogLogSpy {
  readonly logger: IScopedLogger
  readonly info: ReturnType<typeof vi.fn>
  readonly warn: ReturnType<typeof vi.fn>
}

function makeLogger(): CatalogLogSpy {
  const info = vi.fn()
  const warn = vi.fn()
  const logger = {
    info,
    warn,
    debug: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  } as unknown as IScopedLogger
  return { logger, info, warn }
}

interface FakeCameraOptions {
  /** Which `findFile` conditions succeed, keyed by `StartTime`. */
  readonly startsThatSucceed: readonly string[]
  readonly pages?: readonly (readonly Record<string, unknown>[])[]
}

interface FakeCamera {
  readonly rpc: AmcrestRpc2Client
  readonly calls: string[]
  readonly released: number[]
}

function fakeCamera(options: FakeCameraOptions): FakeCamera {
  const calls: string[] = []
  const released: number[] = []
  const pages = options.pages ?? []
  let handle = 100
  let pageAt = 0
  const rpc = {
    call: async (
      method: string,
      params: Readonly<Record<string, unknown>> | null,
      object?: number,
    ): Promise<AmcrestRpc2Result> => {
      calls.push(method)
      if (method === 'mediaFileFind.factory.create') {
        handle += 1
        return { kind: 'ok', params: {}, session: 's', result: handle }
      }
      if (method === 'mediaFileFind.findFile') {
        const condition = (params ?? {})['condition']
        const start =
          typeof condition === 'object' && condition !== null
            ? String((condition as Record<string, unknown>)['StartTime'])
            : ''
        if (!options.startsThatSucceed.includes(start)) return AMBIGUOUS_REFUSAL
        pageAt = 0
        return { kind: 'ok', params: {}, session: 's', result: true }
      }
      if (method === 'mediaFileFind.findNextFile') {
        const page = pages[pageAt] ?? []
        pageAt += 1
        return {
          kind: 'ok',
          params: { found: page.length, infos: page },
          session: 's',
          result: true,
        }
      }
      if (method === 'mediaFileFind.close' || method === 'mediaFileFind.destroy') {
        if (object !== undefined) released.push(object)
        return { kind: 'ok', params: {}, session: 's', result: true }
      }
      return AMBIGUOUS_REFUSAL
    },
    logout: async (): Promise<void> => {},
    reset: (): void => {},
  } as unknown as AmcrestRpc2Client
  return { rpc, calls, released }
}

const WINDOW = {
  channel: 0,
  sinceMs: Date.UTC(2026, 8, 23, 8, 0, 0),
  untilMs: Date.UTC(2026, 8, 23, 9, 0, 0),
  clock: CLOCK,
} as const

describe('readClipRows', () => {
  it('walks pages until `found < count` and never calls getCount', async () => {
    const full = Array.from({ length: CLIP_FIND_PAGE_SIZE }, (_unused, index) => {
      const minute = String(Math.floor(index / 2)).padStart(2, '0')
      const second = String((index % 2) * 30).padStart(2, '0')
      return row(
        `2026-09-23 10:${minute}:${second}`,
        `2026-09-23 10:${minute}:${String((index % 2) * 30 + 10).padStart(2, '0')}`,
        1000,
      )
    })
    const camera = fakeCamera({
      startsThatSucceed: ['2026-09-23 10:00:00'],
      pages: [full, [row('2026-09-23 11:00:00', '2026-09-23 11:00:30', 2000)]],
    })
    const { logger } = makeLogger()
    const outcome = await readClipRows({ rpc: camera.rpc, logger, deviceId: DEVICE_ID }, WINDOW)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.rows).toHaveLength(CLIP_FIND_PAGE_SIZE + 1)
    expect(outcome.pages).toBe(2)
    // `getCount` answers `{"count":0,"result":true}` on a find object that
    // then enumerates rows. It is never called.
    expect(camera.calls).not.toContain('mediaFileFind.getCount')
  })

  it('releases the find object with close AND destroy, never factory.destroy', async () => {
    const camera = fakeCamera({
      startsThatSucceed: ['2026-09-23 10:00:00'],
      pages: [[row('2026-09-23 10:23:27', '2026-09-23 10:24:41', 56_242_806)]],
    })
    const { logger } = makeLogger()
    await readClipRows({ rpc: camera.rpc, logger, deviceId: DEVICE_ID }, WINDOW)
    expect(camera.calls).toContain('mediaFileFind.close')
    expect(camera.calls).toContain('mediaFileFind.destroy')
    // `factory.destroy` is `Method not found!` on this firmware.
    expect(camera.calls).not.toContain('mediaFileFind.factory.destroy')
    expect(camera.released).toHaveLength(2)
  })

  it('releases the find object even when the search REFUSES', async () => {
    const camera = fakeCamera({ startsThatSucceed: [CLIP_CONTROL_WINDOW.start] })
    const { logger } = makeLogger()
    await readClipRows({ rpc: camera.rpc, logger, deviceId: DEVICE_ID }, WINDOW)
    // Two lifecycles — the asked window and the control — and both released.
    expect(camera.released).toHaveLength(4)
  })

  it('calls an EMPTY WINDOW empty, proved against the control search', async () => {
    // The refusal for "nothing matched" is byte-identical to the one for a
    // malformed search. Gating on `findFile` alone would report every quiet
    // Tuesday as `unreachable`.
    const camera = fakeCamera({ startsThatSucceed: [CLIP_CONTROL_WINDOW.start] })
    const { logger, info } = makeLogger()
    const outcome = await readClipRows({ rpc: camera.rpc, logger, deviceId: DEVICE_ID }, WINDOW)
    expect(outcome).toEqual({ kind: 'empty-window' })
    expect(info).toHaveBeenCalled()
  })

  it('calls it index-empty when the control search refuses too', async () => {
    const camera = fakeCamera({ startsThatSucceed: [] })
    const { logger } = makeLogger()
    const outcome = await readClipRows({ rpc: camera.rpc, logger, deviceId: DEVICE_ID }, WINDOW)
    expect(outcome.kind).toBe('index-empty')
    if (outcome.kind !== 'index-empty') return
    // It names BOTH windows it asked for — the only honest thing to report.
    expect(outcome.detail).toContain('2026-09-23 10:00:00')
    expect(outcome.detail).toContain(CLIP_CONTROL_WINDOW.start)
    expect(outcome.detail).toContain('285409284')
  })

  it('does not run the control search when the asked window ANSWERED', async () => {
    const camera = fakeCamera({
      startsThatSucceed: ['2026-09-23 10:00:00'],
      pages: [[row('2026-09-23 10:23:27', '2026-09-23 10:24:41', 56_242_806)]],
    })
    const { logger } = makeLogger()
    await readClipRows({ rpc: camera.rpc, logger, deviceId: DEVICE_ID }, WINDOW)
    expect(camera.calls.filter((call) => call === 'mediaFileFind.findFile')).toHaveLength(1)
  })

  it('NEVER enumerates after a findFile that failed', async () => {
    // `findNextFile` answers `{"result":true,"found":0}` after a failed
    // `findFile` — an authoritative-looking "no clips" from a search that
    // never ran.
    const camera = fakeCamera({
      startsThatSucceed: [CLIP_CONTROL_WINDOW.start],
      pages: [[row('2026-09-23 10:23:27', '2026-09-23 10:24:41', 1)]],
    })
    const { logger } = makeLogger()
    const outcome = await readClipRows({ rpc: camera.rpc, logger, deviceId: DEVICE_ID }, WINDOW)
    expect(outcome.kind).toBe('empty-window')
    expect(camera.calls).not.toContain('mediaFileFind.findNextFile')
  })

  it('reports a transport failure as unreachable, not as an empty window', async () => {
    const rpc = {
      call: async (): Promise<AmcrestRpc2Result> => ({
        kind: 'unreachable',
        detail: 'connect ECONNREFUSED',
      }),
    } as unknown as AmcrestRpc2Client
    const { logger } = makeLogger()
    const outcome = await readClipRows({ rpc, logger, deviceId: DEVICE_ID }, WINDOW)
    expect(outcome.kind).toBe('unreachable')
  })

  it('counts and reports the rows it could not read', async () => {
    const camera = fakeCamera({
      startsThatSucceed: ['2026-09-23 10:00:00'],
      pages: [
        [
          row('2026-09-23 10:23:27', '2026-09-23 10:24:41', 56_242_806),
          // A JPEG row shape: zero-length window.
          { ...row('2026-09-23 10:25:15', '2026-09-23 10:25:15', 263_821), Duration: 0 },
        ],
      ],
    })
    const { logger, warn } = makeLogger()
    const outcome = await readClipRows({ rpc: camera.rpc, logger, deviceId: DEVICE_ID }, WINDOW)
    if (outcome.kind !== 'ok') throw new Error('expected ok')
    expect(outcome.rows).toHaveLength(1)
    expect(outcome.rejectedCount).toBe(1)
    expect(outcome.rejected).toEqual({ 'not-a-window': 1 })
    // A branch that drops work says so (D391).
    expect(warn).toHaveBeenCalled()
  })

  it('sends the window as the CAMERA’s wall clock', async () => {
    const seen: string[] = []
    const rpc = {
      call: async (
        method: string,
        params: Readonly<Record<string, unknown>> | null,
      ): Promise<AmcrestRpc2Result> => {
        if (method === 'mediaFileFind.factory.create') {
          return { kind: 'ok', params: {}, session: 's', result: 7 }
        }
        if (method === 'mediaFileFind.findFile') {
          const condition = (params ?? {})['condition'] as Record<string, unknown>
          seen.push(String(condition['StartTime']), String(condition['EndTime']))
          return AMBIGUOUS_REFUSAL
        }
        return { kind: 'ok', params: {}, session: 's', result: true }
      },
    } as unknown as AmcrestRpc2Client
    const { logger } = makeLogger()
    await readClipRows({ rpc, logger, deviceId: DEVICE_ID }, WINDOW)
    // 08:00 UTC is 10:00 on a camera at +2. A UTC window would return the
    // wrong footage rather than an error.
    expect(seen[0]).toBe('2026-09-23 10:00:00')
    expect(seen[1]).toBe('2026-09-23 11:00:00')
  })
})
