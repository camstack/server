import { vi } from 'vitest'
import type {
  FeederStateTransition,
  LocateResult,
  RecordedFeederDeps,
} from '../../stream-broker/recorded/recorded-feeder.js'

const AU = (ptsMs: number, key = false) => ({
  data: new Uint8Array([0, 0, 0, 1, key ? 0x26 : 0x02]),
  ptsMs,
  keyframe: key,
  codec: 'H265' as const,
})

/** Mutable scratch arrays wired into default feeder deps for assertions. */
export interface RecordedFeederTestScratch {
  pushed: number[]
  states: string[]
  positions: number[]
}

export function makeRecordedFeederDeps(
  scratch: RecordedFeederTestScratch,
  patch: Partial<RecordedFeederDeps> = {},
): RecordedFeederDeps {
  const onState = (transition: FeederStateTransition): void => {
    scratch.states.push(transition.to)
  }
  const onPosition = (epochMs: number): void => {
    scratch.positions.push(epochMs)
  }
  const base: RecordedFeederDeps = {
    deviceId: 99,
    profile: 'mid',
    locate: vi.fn(
      async (args: {
        deviceId: number
        profile: string
        epochMs: number
      }): Promise<LocateResult> =>
        args.epochMs < 9000
          ? { kind: 'segment', startMs: 5000, durMs: 4000, bytes: 3 }
          : { kind: 'gap', nearestEdgeMs: null },
    ),
    readBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
    demux: vi.fn(async () => [AU(5000, true), AU(5040), AU(5080)]),
    sink: {
      pushAccessUnit: (_data: Uint8Array, rtpTs: number, _codec: 'H264' | 'H265') => {
        scratch.pushed.push(rtpTs)
      },
    },
    onState,
    onPosition,
  }
  return { ...base, ...patch }
}
