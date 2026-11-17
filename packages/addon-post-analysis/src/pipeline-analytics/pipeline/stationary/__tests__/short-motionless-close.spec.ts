/**
 * `noteShortMotionlessClose` — what a closed track tells the phantom-cell
 * memory. A track too brief to judge (1441 gfygqn22cf: 387 ms, 2 sightings)
 * neither arms nor clears its cell, and says so with the camera's id (D391).
 */
import { describe, expect, it, vi } from 'vitest'
import { type LogLine, makeRecordingLogger } from '../../../__tests__/boot-analytics.js'
import {
  noteShortMotionlessClose,
  type ShortMotionlessCloseDeps,
  type ShortMotionlessCloseTrack,
} from '../short-motionless-close.js'

const DEVICE_ID = 1441

function harness(): {
  deps: ShortMotionlessCloseDeps
  logs: LogLine[]
  armed: ReturnType<typeof vi.fn>
  cleared: ReturnType<typeof vi.fn>
} {
  const logs: LogLine[] = []
  const armed = vi.fn(async () => ({ bar: 0.6, raised: false, cell: '0,0', closesInWindow: 1 }))
  const cleared = vi.fn(async () => false)
  return {
    logs,
    armed,
    cleared,
    deps: {
      phantomCells: { noteMotionlessClose: armed, noteMovingClose: cleared },
      cells: new Map(),
      logger: makeRecordingLogger(logs),
      now: 10_000,
    },
  }
}

function track(lifeMs: number, xs: readonly number[]): ShortMotionlessCloseTrack {
  return {
    trackId: 't',
    deviceId: DEVICE_ID,
    className: 'person',
    firstSeen: 1_000,
    lastSeen: 1_000 + lifeMs,
    positions: xs.map((x) => ({ x, y: 300 })),
  }
}

describe('noteShortMotionlessClose', () => {
  it('a 387 ms / 2-sighting walker neither arms nor clears its cell, and logs why', () => {
    const { deps, logs, armed, cleared } = harness()
    noteShortMotionlessClose(track(387, [400, 412]), deps)

    expect(armed).not.toHaveBeenCalled()
    expect(cleared).not.toHaveBeenCalled()
    expect(deps.cells.size).toBe(0)
    const line = logs.find((l) => l.message === 'phantom cell untouched — track too brief to judge')
    expect(line?.extras).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: { trackId: 't', lifeMs: 387, observations: 2 },
    })
  })

  it('a 4 s motionless re-fire with enough sightings arms its cell', () => {
    const { deps, logs, armed, cleared } = harness()
    noteShortMotionlessClose(track(4_000, [400, 401, 400, 401, 400, 401, 400, 401, 400]), deps)

    expect(armed).toHaveBeenCalledTimes(1)
    expect(cleared).not.toHaveBeenCalled()
    expect(deps.cells.size).toBe(1)
    expect(logs.some((l) => l.message === 'short motionless track closed')).toBe(true)
    expect(logs.some((l) => l.message.startsWith('phantom cell untouched'))).toBe(false)
  })

  it('a track that went somewhere clears its cell', () => {
    const { deps, armed, cleared } = harness()
    noteShortMotionlessClose(track(4_000, [100, 200, 300, 400, 500]), deps)

    expect(cleared).toHaveBeenCalledTimes(1)
    expect(armed).not.toHaveBeenCalled()
  })
})
