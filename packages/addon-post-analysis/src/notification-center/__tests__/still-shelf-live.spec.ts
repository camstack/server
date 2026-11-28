/**
 * A camera-own event still is a LIVE picture (D1070): an awake camera gets one
 * forced capture; the wrapper's cached frame is never the primary picture.
 */
import type { IScopedLogger, LogExtras } from '@dominevo/types'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { NcStillShelf, type NcStillShelfDeps } from '../still-shelf.js'

interface Line {
  readonly level: string
  readonly msg: string
  readonly deviceId: unknown
  readonly meta: Record<string, unknown> | undefined
}

function loggerInto(lines: Line[]): IScopedLogger {
  const at =
    (level: string) =>
    (msg: string, extras?: LogExtras): void => {
      lines.push({ level, msg, deviceId: extras?.tags?.deviceId, meta: extras?.meta })
    }
  const logger: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

async function jpegB64(): Promise<string> {
  const buf = await sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 9, g: 9, b: 9 } },
  })
    .jpeg()
    .toBuffer()
  return buf.toString('base64')
}

async function shelfWith(
  overrides: Partial<NcStillShelfDeps>,
  lines: Line[],
): Promise<NcStillShelf> {
  const b64 = await jpegB64()
  return new NcStillShelf({
    getSnapshot: async () => ({ base64: b64, contentType: 'image/jpeg' }),
    logger: loggerInto(lines),
    now: () => Date.now(),
    ...overrides,
  })
}

const awake = async (): Promise<{ reason: null }> => ({ reason: null })

// Waits for the TERMINAL line of a capture: shipped, gave up, or timed out.
// The intermediate "live capture failed — trying a recent cached frame" warn is
// NOT terminal: stopping there raced the cached-frame path. The vitest timeout
// bounds the wait, so there is no wall-clock deadline to lose under load.
const isTerminal = (l: Line): boolean =>
  l.msg.endsWith('still captured') ||
  l.msg.includes('did not answer') ||
  l.msg.includes('timed out')

async function settled(lines: Line[]): Promise<void> {
  while (!lines.some(isTerminal)) {
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('NcStillShelf — the live still (D1070)', () => {
  it('an awake camera is photographed by ONE forced capture, never the cached read', async () => {
    const calls: boolean[] = []
    const lines: Line[] = []
    const b64 = await jpegB64()
    const shelf = await shelfWith(
      {
        getSnapshotState: awake,
        getSnapshot: async (_id, opts) => {
          calls.push(opts?.force === true)
          return { base64: b64, contentType: 'image/jpeg' }
        },
      },
      lines,
    )
    const owner = shelf.capture(7, 1_000, 'occupancy', 'live')
    await settled(lines)
    expect(calls).toEqual([true])
    expect(shelf.get(owner)?.length ?? 0).toBeGreaterThan(0)
    const line = lines.find((l) => l.msg.endsWith('still captured'))
    expect(line?.deviceId).toBe(7)
    expect(line?.meta).toMatchObject({ live: true })
  })

  it('a camera whose state is not known awake keeps the unforced read', async () => {
    const calls: boolean[] = []
    const lines: Line[] = []
    const b64 = await jpegB64()
    const shelf = await shelfWith(
      {
        getSnapshotState: async () => ({ reason: 'sleeping' }),
        getSnapshot: async (_id, opts) => {
          calls.push(opts?.force === true)
          return { base64: b64, contentType: 'image/jpeg' }
        },
      },
      lines,
    )
    shelf.capture(7, 1_000, 'occupancy', 'live')
    await settled(lines)
    expect(calls).toEqual([false])
  })

  it('live fails, a RECENT cached frame ships and the failure is named', async () => {
    const calls: boolean[] = []
    const lines: Line[] = []
    const b64 = await jpegB64()
    const shelf = await shelfWith(
      {
        getSnapshotState: awake,
        getSnapshot: async (_id, opts) => {
          calls.push(opts?.force === true)
          return opts?.force === true ? null : { base64: b64, contentType: 'image/jpeg' }
        },
        getFrameCapturedAt: async () => new Map([[7, Date.now()]]),
      },
      lines,
    )
    const owner = shelf.capture(7, Date.now(), 'occupancy', 'live')
    await settled(lines)
    expect(calls).toEqual([true, false])
    expect(shelf.get(owner)?.length ?? 0).toBeGreaterThan(0)
    expect(lines.find((l) => l.msg.endsWith('still captured'))?.meta).toMatchObject({
      liveFailure: 'empty',
    })
  })

  it('live fails and the cached frame is OLD → text-only, the reason on the warn', async () => {
    const lines: Line[] = []
    const b64 = await jpegB64()
    const shelf = await shelfWith(
      {
        getSnapshotState: awake,
        getSnapshot: async (_id, opts) =>
          opts?.force === true ? null : { base64: b64, contentType: 'image/jpeg' },
        getFrameCapturedAt: async () => new Map([[7, Date.now() - 900_000]]),
      },
      lines,
    )
    const owner = shelf.capture(7, Date.now(), 'occupancy', 'live')
    await settled(lines)
    expect(shelf.get(owner)).toEqual([])
    const miss = lines.find((l) => l.msg.includes('did not answer'))
    expect(miss?.deviceId).toBe(7)
    expect(String(miss?.meta?.['reason'])).toContain('cached frame is stale')
  })
})
