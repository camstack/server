/**
 * The notification centre's side of the event-media contract.
 *
 * One rule is load-bearing above all the others and every test here exists to
 * hold it: **a notification never ships a gif and a video from two different
 * renders.** That is the defect the operator reported — a gif around a doorbell
 * press beside a video of the six seconds after it — and the fix is only real
 * if the fallback refuses to reintroduce it.
 */

import type { EventMediaArtifact, IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

import {
  EventMediaService,
  type EventMediaServiceDeps,
  NC_GIF_FPS,
  NC_GIF_SPEED,
} from '../event-media-service.js'

interface Line {
  readonly level: string
  readonly msg: string
  readonly meta: Record<string, unknown>
  readonly deviceId: unknown
}

function recorder(): { logger: IScopedLogger; lines: Line[] } {
  const lines: Line[] = []
  const push =
    (level: string) =>
    (msg: string, opts?: { tags?: Record<string, unknown>; meta?: Record<string, unknown> }) => {
      lines.push({ level, msg, meta: opts?.meta ?? {}, deviceId: opts?.tags?.['deviceId'] })
    }
  const logger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
  } as unknown as IScopedLogger
  return { logger, lines }
}

function artifact(over: Partial<EventMediaArtifact> & { kind: 'mp4' | 'gif' }): EventMediaArtifact {
  return {
    handle: `h-${over.kind}`,
    nodeId: 'agent-1',
    mime: over.kind === 'gif' ? 'image/gif' : 'video/mp4',
    bytes: 10,
    width: 1280,
    height: 720,
    ...over,
  }
}

function build(over: Partial<EventMediaServiceDeps> = {}): {
  service: EventMediaService
  lines: Line[]
  deps: EventMediaServiceDeps
} {
  const { logger, lines } = recorder()
  const deps: EventMediaServiceDeps = {
    logger,
    produce: vi.fn(async () => ({
      media: [artifact({ kind: 'mp4' }), artifact({ kind: 'gif' })],
      coverage: { fromTs: 1_000 - 4_100, toTs: 1_000 + 6_200 },
      profile: 'mid',
      video: 'copy' as const,
    })),
    fetch: vi.fn(async () => ({ base64: Buffer.from('xx').toString('base64') })),
    renderRingClip: vi.fn(async () => new Uint8Array([1, 2, 3])),
    ...over,
  }
  return { service: new EventMediaService(deps), lines, deps }
}

const request = {
  deviceId: 101,
  aroundMs: 1_000,
  preRollSec: 4,
  postRollSec: 6,
  wantMp4: true,
  wantGif: true,
} as const

describe('EventMediaService — the production path', () => {
  it('asks for BOTH containers in ONE production', async () => {
    const { service, deps } = build()
    await service.cut(request)
    expect(deps.produce).toHaveBeenCalledTimes(1)
    const input = vi.mocked(deps.produce).mock.calls[0]?.[0]
    expect(input?.kinds).toEqual(['mp4', 'gif'])
  })

  it('asks for 4× on BOTH containers, explicitly', async () => {
    // Explicitly, not by the cap's `.default()`: a Zod default on a cap input
    // is applied by the hub's router and only ships with a publish train, so a
    // field left unsent would keep the OLD speed on a hub the addon deploy
    // already updated.
    //
    // The video follows the gif by OPERATOR DECISION. It costs the copy branch
    // — `speed !== 1` forces libx264 — and that was priced before it was
    // chosen: a per-event burst over a ~12 s window, measured at 0.23 s and
    // 254 KB on a real 101 720p cut, against 922 KB for the copy it replaces.
    const { service, deps } = build()
    await service.cut(request)
    const input = vi.mocked(deps.produce).mock.calls[0]?.[0]
    expect(input?.gifSpeed).toBe(4)
    expect(input?.gifFps).toBe(12)
    expect(input?.speed).toBe(4)
  })

  it('still honours a rule that asks for real time — the default is a default', async () => {
    const { service, deps } = build()
    await service.cut({ ...request, speed: 1 })
    expect(vi.mocked(deps.produce).mock.calls[0]?.[0]?.speed).toBe(1)
  })

  it('redeems each handle AT THE NODE THAT MINTED IT', async () => {
    // An unpinned fetch is answered by the hub's own store, which never held
    // an agent's artifact — the failure looks like an expired handle.
    const { service, deps } = build()
    await service.cut(request)
    expect(deps.fetch).toHaveBeenCalledWith('h-mp4', 'agent-1')
    expect(deps.fetch).toHaveBeenCalledWith('h-gif', 'agent-1')
  })

  it('reports the coverage as OFFSETS FROM THE EVENT, negative start included', async () => {
    const { service, lines } = build()
    const media = await service.cut(request)
    expect(media.startOffsetMs).toBe(-4_100)
    expect(media.endOffsetMs).toBe(6_200)
    const line = lines.find((l) => l.msg.includes('one production, every attachment'))
    expect(line?.deviceId).toBe(101)
    expect(line?.meta['startOffsetMs']).toBe(-4_100)
    expect(line?.meta['video']).toBe('copy')
  })

  it('never renders the gif itself — the ring renderer is untouched on this path', async () => {
    const { service, deps } = build()
    await service.cut(request)
    expect(deps.renderRingClip).not.toHaveBeenCalled()
  })

  it('asks for nothing at all when the rule wants no footage', async () => {
    const { service, deps } = build()
    const media = await service.cut({ ...request, wantMp4: false, wantGif: false })
    expect(media.source).toBe('none')
    expect(deps.produce).not.toHaveBeenCalled()
  })
})

describe('EventMediaService — the fallback', () => {
  it('falls back to the ring when the production throws, and LOGS the reason', async () => {
    const { service, lines, deps } = build({
      produce: vi.fn(async () => {
        throw new Error('No procedure found on path "streamBroker.produceEventMedia"')
      }),
    })
    const media = await service.cut(request)
    expect(media.source).toBe('ring-fallback')
    expect(media.mp4).not.toBeNull()
    expect(deps.renderRingClip).toHaveBeenCalledTimes(2)
    const warn = lines.find((l) => l.level === 'warn' && l.msg.includes('falling back'))
    expect(warn?.deviceId).toBe(101)
    expect(String(warn?.meta['error'])).toContain('produceEventMedia')
  })

  it('gives BOTH ring calls the identical window and profile — coherence by parameters', async () => {
    // The fallback cannot cut once, so the only thing holding the two
    // attachments together is that they are asked for identically. A drift here
    // is the original defect wearing a different hat.
    const { service, deps } = build({
      produce: vi.fn(async () => {
        throw new Error('nope')
      }),
    })
    await service.cut({ ...request, profile: 'mid' })
    const calls = vi.mocked(deps.renderRingClip).mock.calls.map((c) => c[0])
    expect(calls).toHaveLength(2)
    const [mp4Call, gifCall] = calls
    expect(mp4Call?.format).toBe('mp4')
    expect(gifCall?.format).toBe('gif')
    // The RATES are excluded on purpose: the gif is 4× and the video is real
    // time, and neither selects packets. What must not drift is the window.
    for (const key of ['aroundMs', 'preRollSec', 'postRollSec', 'profile'] as const) {
      expect(gifCall?.[key]).toEqual(mp4Call?.[key])
    }
  })

  it('speeds the FALLBACK gif up too — 4×, sampled at a quarter of its playback rate', async () => {
    // A fallback that quietly shipped a real-time gif would put the operator
    // back where they started for the one path they cannot see coming.
    const { service, deps } = build({
      produce: vi.fn(async () => {
        throw new Error('nope')
      }),
    })
    await service.cut(request)
    const [mp4Call, gifCall] = vi.mocked(deps.renderRingClip).mock.calls.map((c) => c[0])
    expect(gifCall?.speed).toBe(NC_GIF_SPEED)
    expect(NC_GIF_SPEED).toBe(4)
    // The ring's `fps` is SOURCE sampling, so 12 fps of playback is 3 of source.
    expect(gifCall?.fps).toBe(NC_GIF_FPS / NC_GIF_SPEED)
    expect(gifCall?.fps).toBe(3)
    // The video runs at the same 4x — one clip, one rate, both containers.
    expect(mp4Call?.speed).toBe(4)
  })

  it('a gif-only rule STILL gets its gif on the fallback', async () => {
    // Three of the four live rules on this install ask for a gif and nothing
    // else; a fallback that served only mp4 would silence them.
    const { service, deps } = build({
      produce: vi.fn(async () => {
        throw new Error('nope')
      }),
    })
    const media = await service.cut({ ...request, wantMp4: false })
    expect(media.source).toBe('ring-fallback')
    expect(media.gif).not.toBeNull()
    expect(media.mp4).toBeNull()
    expect(vi.mocked(deps.renderRingClip).mock.calls).toHaveLength(1)
  })

  it('falls back when the production carried no artifact at all', async () => {
    const { service, deps } = build({
      produce: vi.fn(async () => ({
        media: [],
        coverage: { fromTs: 0, toTs: 0 },
        profile: 'mid',
        video: 'copy' as const,
      })),
    })
    const media = await service.cut(request)
    expect(media.source).toBe('ring-fallback')
    expect(deps.renderRingClip).toHaveBeenCalled()
  })

  it('an expired handle drops THAT attachment and says so — it does not fail the rest', async () => {
    const { service, lines } = build({
      fetch: vi.fn(async (handle: string) =>
        handle === 'h-gif' ? null : { base64: Buffer.from('xx').toString('base64') },
      ),
    })
    const media = await service.cut(request)
    expect(media.source).toBe('produced')
    expect(media.mp4).not.toBeNull()
    expect(media.gif).toBeNull()
    expect(lines.some((l) => l.level === 'warn' && l.msg.includes('handle expired'))).toBe(true)
  })

  it('nothing anywhere leaves the notification without a line', async () => {
    const { service, lines } = build({
      produce: vi.fn(async () => {
        throw new Error('nope')
      }),
      renderRingClip: vi.fn(async () => null),
    })
    const media = await service.cut(request)
    expect(media.source).toBe('none')
    expect(lines.filter((l) => l.level === 'warn').length).toBeGreaterThanOrEqual(2)
  })
})
