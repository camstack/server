/**
 * Task 15 re-review N1: React Query's `refetch()` RESOLVES with an error result
 * instead of throwing, so the Motion card only learns that its re-read after a
 * write failed through this outcome — a catch alone never fires in production.
 */
import type { CameraSensorsStatus } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { cameraSensorsPresence, refetchOutcome } from '../use-camera-sensors-presence'

const CONFIGURED: CameraSensorsStatus = {
  state: 'configured',
  sensors: [],
  cameraMotion: 'always',
}

describe('refetchOutcome', () => {
  it('an error RESULT (the production shape) is a failed re-read', async () => {
    expect(await refetchOutcome(async () => ({ isError: true }))).toBe('failed')
  })
  it('a thrown refetch is a failed re-read too', async () => {
    expect(
      await refetchOutcome(async () => {
        throw new Error('network down')
      }),
    ).toBe('failed')
  })
  it('a successful result is answered', async () => {
    expect(await refetchOutcome(async () => ({ isError: false }))).toBe('answered')
  })
})

describe('cameraSensorsPresence', () => {
  it('a failed refetch that still holds an answer stays present', () => {
    expect(
      cameraSensorsPresence({
        status: 'error',
        data: { cameraSensors: CONFIGURED },
      }),
    ).toBe('present')
  })
  it('a failed read that never answered is unknown', () => {
    expect(cameraSensorsPresence({ status: 'error', data: undefined })).toBe('unknown')
  })
})
