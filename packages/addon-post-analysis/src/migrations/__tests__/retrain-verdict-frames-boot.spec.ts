/**
 * The backfill's boot contract: it never fails the boot, and a staging list
 * longer than one run handles is cut AND said so.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  boundStagedTracks,
  runBackfillDetached,
  type StagedRetrainTrack,
} from '../retrain-verdict-frames.js'

function recordingLogger(): { logger: IScopedLogger; warns: string[] } {
  const warns: string[] = []
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string) => {
      warns.push(message)
    },
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, warns }
}

const track = (n: number): StagedRetrainTrack => ({ deviceId: 1, trackId: `t${n}`, frameCount: 0 })

describe('runBackfillDetached', () => {
  it('a run that throws (ports that cannot be built) is one warn, not a rejection', async () => {
    const { logger, warns } = recordingLogger()
    await expect(
      runBackfillDetached(async () => {
        throw new Error('the per-device settings store is unavailable')
      }, logger),
    ).resolves.toBeUndefined()
    expect(warns).toHaveLength(1)
  })

  it('a clean run says nothing', async () => {
    const { logger, warns } = recordingLogger()
    await runBackfillDetached(async () => undefined, logger)
    expect(warns).toEqual([])
  })
})

describe('boundStagedTracks', () => {
  it('cuts a list over the limit and logs the truncation', () => {
    const { logger, warns } = recordingLogger()
    const out = boundStagedTracks([track(1), track(2), track(3)], 2, logger)
    expect(out.map((t) => t.trackId)).toEqual(['t1', 't2'])
    expect(warns).toHaveLength(1)
  })

  it('a list within the limit is returned whole, silently', () => {
    const { logger, warns } = recordingLogger()
    expect(boundStagedTracks([track(1), track(2)], 2, logger)).toHaveLength(2)
    expect(warns).toEqual([])
  })
})
