/**
 * The verdict tap's training frame: the frozen frame first, the track's best
 * frame as the fallback, and a copy that cannot be taken is a named outcome
 * and a log line carrying the camera — never a throw.
 */

import type { IScopedLogger, RetrainFrameList, RetrainFrameSelection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { copyVerdictFrame, type VerdictFrameCopyApi } from '../verdict-frame-copy.js'

interface Line {
  readonly level: string
  readonly message: string
  readonly tags: Record<string, unknown> | undefined
  readonly meta: Record<string, unknown>
}

function recordingLogger(): { logger: IScopedLogger; lines: Line[] } {
  const lines: Line[] = []
  const at =
    (level: string) =>
    (
      message: string,
      extras?: { tags?: Record<string, unknown>; meta?: Record<string, unknown> },
    ): void => {
      lines.push({ level, message, tags: extras?.tags, meta: extras?.meta ?? {} })
    }
  const logger: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, lines }
}

const candidate = (mediaId: number, kind: 'keyFrame' | 'sceneFrame' | 'keyFrameSmall') => ({
  mediaId,
  kind,
  timestamp: 1000 + mediaId,
  sizeBytes: 10_000,
  copied: false,
})

const listing = (...candidates: ReturnType<typeof candidate>[]): RetrainFrameList => ({
  candidates,
  copies: [],
})

interface World {
  readonly api: VerdictFrameCopyApi
  readonly selected: number[][]
}

/** `refuse` names the media ids the copy refuses; everything else lands. */
function world(list: RetrainFrameList, refuse: readonly number[] = []): World {
  const selected: number[][] = []
  return {
    selected,
    api: {
      listRetrainFrames: async () => list,
      selectRetrainFrames: async ({ mediaIds }): Promise<RetrainFrameSelection> => {
        selected.push(mediaIds)
        const refused = mediaIds.filter((id) => refuse.includes(id))
        return {
          copied: mediaIds.filter((id) => !refuse.includes(id)).map(() => ({}) as never),
          refused: refused.map((sourceMediaId) => ({
            sourceMediaId,
            reason: 'source-missing' as const,
          })),
        }
      },
    },
  }
}

describe('copyVerdictFrame', () => {
  it('copies the frozen frame when the track owns it', async () => {
    const w = world(listing(candidate(1, 'keyFrame'), candidate(42, 'sceneFrame')))
    const { logger } = recordingLogger()
    const out = await copyVerdictFrame(w.api, logger, {
      deviceId: 101,
      trackId: 't1',
      sourceMedia: { mediaId: 42, kind: 'sceneFrame' },
    })
    expect(out).toEqual({ ok: true, via: 'frozen', mediaId: 42 })
    expect(w.selected).toEqual([[42]])
  })

  it('refuses a frozen media id that is not on the track, and auto-picks instead', async () => {
    const w = world(listing(candidate(3, 'keyFrame')))
    const { logger, lines } = recordingLogger()
    const out = await copyVerdictFrame(w.api, logger, {
      deviceId: 101,
      trackId: 't1',
      sourceMedia: { mediaId: 999, kind: 'keyFrame' },
    })
    expect(out).toEqual({ ok: true, via: 'auto-pick', mediaId: 3 })
    expect(w.selected).toEqual([[3]])
    expect(lines.some((l) => l.message.includes('not on this track'))).toBe(true)
  })

  it('an old token (no frozen frame) copies the best frame of the track', async () => {
    const w = world(listing(candidate(5, 'keyFrameSmall'), candidate(3, 'keyFrame')))
    const { logger } = recordingLogger()
    const out = await copyVerdictFrame(w.api, logger, { deviceId: 101, trackId: 't1' })
    expect(out).toEqual({ ok: true, via: 'auto-pick', mediaId: 3 })
    expect(w.selected).toEqual([[3]])
  })

  it('a refused frozen frame falls back to the best OTHER frame', async () => {
    const w = world(listing(candidate(42, 'keyFrame'), candidate(9, 'sceneFrame')), [42])
    const { logger } = recordingLogger()
    const out = await copyVerdictFrame(w.api, logger, {
      deviceId: 101,
      trackId: 't1',
      sourceMedia: { mediaId: 42, kind: 'keyFrame' },
    })
    expect(out).toEqual({ ok: true, via: 'auto-pick', mediaId: 9 })
    expect(w.selected).toEqual([[42], [9]])
  })

  it('a copy that is refused everywhere answers the reason and logs it with the camera', async () => {
    const w = world(listing(candidate(42, 'keyFrame')), [42])
    const { logger, lines } = recordingLogger()
    const out = await copyVerdictFrame(w.api, logger, {
      deviceId: 101,
      trackId: 't1',
      sourceMedia: { mediaId: 42, kind: 'keyFrame' },
    })
    expect(out).toEqual({ ok: false, reason: 'no-candidate-frame' })
    const warn = lines.find((l) => l.level === 'warn')
    expect(warn?.tags).toEqual({ deviceId: 101 })
    expect(warn?.meta['reason']).toBe('no-candidate-frame')
  })

  it('names the refusal the corpus gave when the best frame is refused', async () => {
    const w = world(listing(candidate(3, 'keyFrame')), [3])
    const { logger, lines } = recordingLogger()
    const out = await copyVerdictFrame(w.api, logger, { deviceId: 101, trackId: 't1' })
    expect(out).toEqual({ ok: false, reason: 'source-missing' })
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(1)
  })

  it('never throws: a failing corpus is a logged outcome', async () => {
    const { logger, lines } = recordingLogger()
    const out = await copyVerdictFrame(
      {
        listRetrainFrames: async () => {
          throw new Error('db down')
        },
        selectRetrainFrames: async () => {
          throw new Error('db down')
        },
      },
      logger,
      { deviceId: 101, trackId: 't1' },
    )
    expect(out).toEqual({ ok: false, reason: 'copy-threw' })
    expect(lines.find((l) => l.level === 'warn')?.tags).toEqual({ deviceId: 101 })
  })
})
