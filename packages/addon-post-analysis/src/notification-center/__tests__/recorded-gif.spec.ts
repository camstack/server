/**
 * The recorded gif (D682): derived from the recorded clip's bytes with the
 * broker's own filter chain, on the pinned ffmpeg, and every miss named.
 */
import type { IScopedLogger } from '@camstack/types'
import { gifFilterComplex } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NC_GIF_FPS, NC_GIF_MAX_WIDTH, NC_GIF_SPEED } from '../event-media/event-media-service.js'
import {
  deriveRecordedGif,
  type NcRecordedGifPorts,
  type NcRecordedGifRunResult,
  stageTempClip,
} from '../recorded-gif.js'

const DEVICE = 101

interface Harness {
  readonly ports: NcRecordedGifPorts
  readonly runs: Array<{ cmd: string; args: readonly string[] }>
  readonly removed: string[]
  readonly warns: Array<{ msg: string; deviceId: unknown; reason: unknown }>
}

function harness(opts: {
  readonly run?: NcRecordedGifRunResult
  readonly stageFails?: boolean
}): Harness {
  const runs: Array<{ cmd: string; args: readonly string[] }> = []
  const removed: string[] = []
  const warns: Array<{ msg: string; deviceId: unknown; reason: unknown }> = []
  const logger: IScopedLogger = {
    ...makeSilentLogger(),
    warn: (msg, ctx) => {
      warns.push({ msg, deviceId: ctx?.tags?.['deviceId'], reason: ctx?.meta?.['reason'] })
    },
  }
  return {
    runs,
    removed,
    warns,
    ports: {
      logger,
      resolveFfmpeg: async () => '/data/deps/ffmpeg-8.1.2/ffmpeg',
      run: async (cmd, args) => {
        runs.push({ cmd, args })
        return opts.run ?? { ok: true, stdout: Buffer.from('GIF89a') }
      },
      writeTemp: async () => {
        if (opts.stageFails === true) throw new Error('ENOSPC')
        return '/tmp/clip.mp4'
      },
      removeTemp: async (file) => {
        removed.push(file)
      },
    },
  }
}

const REQ = {
  deviceId: DEVICE,
  mp4: Uint8Array.from([1, 2, 3]),
  ruleId: 'rule-pkg',
  recordId: '283529',
}

describe('deriveRecordedGif', () => {
  it('derives with the broker chain, from the staged clip, on the pinned ffmpeg', async () => {
    const h = harness({})
    const out = await deriveRecordedGif(h.ports, REQ)
    expect(out.ok).toBe(true)
    expect(h.runs[0]?.cmd).toBe('/data/deps/ffmpeg-8.1.2/ffmpeg')
    const args = h.runs[0]?.args ?? []
    expect(args[args.indexOf('-i') + 1]).toBe('/tmp/clip.mp4')
    // ONE chain: the same string the broker hands its own derive.
    expect(args[args.indexOf('-filter_complex') + 1]).toBe(
      gifFilterComplex({ maxWidth: NC_GIF_MAX_WIDTH, fps: NC_GIF_FPS, speed: NC_GIF_SPEED }),
    )
    expect(h.removed).toEqual(['/tmp/clip.mp4'])
  })

  it('discounts a clip that was already sped up, so the gif rate stays absolute', async () => {
    const h = harness({})
    await deriveRecordedGif(h.ports, { ...REQ, videoSpeed: 2 })
    const args = h.runs[0]?.args ?? []
    expect(args[args.indexOf('-filter_complex') + 1]).toBe(
      gifFilterComplex({ maxWidth: NC_GIF_MAX_WIDTH, fps: NC_GIF_FPS, speed: NC_GIF_SPEED / 2 }),
    )
  })

  it('names a failed derive, per camera, and still removes the staged clip', async () => {
    const h = harness({ run: { ok: false, error: 'exit 1: moov atom not found' } })
    const out = await deriveRecordedGif(h.ports, REQ)
    expect(out).toEqual({ ok: false, reason: 'derive-failed' })
    expect(h.warns[0]?.deviceId).toBe(DEVICE)
    expect(h.warns[0]?.reason).toBe('derive-failed')
    expect(h.removed).toEqual(['/tmp/clip.mp4'])
  })

  it('treats an empty output as a failed derive, never as a gif', async () => {
    const h = harness({ run: { ok: true, stdout: Buffer.alloc(0) } })
    expect(await deriveRecordedGif(h.ports, REQ)).toEqual({ ok: false, reason: 'derive-failed' })
  })

  it('names a clip that could not be staged, and runs nothing', async () => {
    const h = harness({ stageFails: true })
    expect(await deriveRecordedGif(h.ports, REQ)).toEqual({ ok: false, reason: 'stage-failed' })
    expect(h.runs).toHaveLength(0)
    expect(h.warns[0]?.reason).toBe('stage-failed')
  })
})

describe('stageTempClip — a write that fails part-way leaves no file behind', () => {
  it('removes the partial file and re-throws the write error', async () => {
    const onDisk = new Set<string>()
    const io = {
      // ENOSPC half-way: the file EXISTS, the write still rejects.
      write: async (file: string): Promise<void> => {
        onDisk.add(file)
        throw new Error('ENOSPC')
      },
      remove: async (file: string): Promise<void> => {
        onDisk.delete(file)
      },
    }
    await expect(stageTempClip('/tmp/camstack-nc-gif-x.mp4', REQ.mp4, io)).rejects.toThrow('ENOSPC')
    expect([...onDisk]).toEqual([])
  })

  it('names a partial file it could NOT remove in the error the caller logs', async () => {
    const io = {
      write: async (): Promise<void> => {
        throw new Error('ENOSPC')
      },
      remove: async (): Promise<void> => {
        throw new Error('EACCES')
      },
    }
    await expect(stageTempClip('/tmp/camstack-nc-gif-z.mp4', REQ.mp4, io)).rejects.toThrow(
      /ENOSPC.*camstack-nc-gif-z\.mp4 was NOT removed.*EACCES/,
    )
  })

  it('logs, per camera, a staged clip it could not remove after the derive', async () => {
    const h = harness({})
    const ports: NcRecordedGifPorts = {
      ...h.ports,
      removeTemp: async () => {
        throw new Error('EBUSY')
      },
    }
    const out = await deriveRecordedGif(ports, REQ)
    // The gif still ships: a leak is news, never a failed notification.
    expect(out.ok).toBe(true)
    const leak = h.warns.find((w) => w.msg === 'recorded gif: could not remove the staged clip')
    expect(leak?.deviceId).toBe(DEVICE)
  })

  it('returns the path it wrote, and removes nothing, when the write lands', async () => {
    const removed: string[] = []
    const file = await stageTempClip('/tmp/camstack-nc-gif-y.mp4', REQ.mp4, {
      write: async () => undefined,
      remove: async (f) => {
        removed.push(f)
      },
    })
    expect(file).toBe('/tmp/camstack-nc-gif-y.mp4')
    expect(removed).toEqual([])
  })
})
