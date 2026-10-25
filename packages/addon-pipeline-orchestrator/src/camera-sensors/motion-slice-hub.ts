/**
 * The ONE place a camera's `motion` runtime slice is written (D696): the hub's
 * `deviceState`, for `CameraMotionSlice`. The emitter guard
 * (`scripts/check-onboard-motion-emitters.ts`) exempts this file, and only this
 * file, from its slice-writer rule — so a second motion-slice write anywhere
 * else, the bootstrap included, is refused by path:line.
 */
import { type AddonApi, errMsg, type MotionStatus } from '@camstack/types'
import type { MotionSliceRead } from './motion-slice.js'

/** The slice reads and writes `CameraMotionSlice` needs, over the hub. */
export interface HubMotionSliceStore {
  readonly writeSlice: (deviceId: number, slice: MotionStatus) => Promise<void>
  readonly readSlice: (deviceId: number) => Promise<MotionSliceRead>
}

export function hubMotionSliceStore(api: () => AddonApi): HubMotionSliceStore {
  return {
    writeSlice: async (deviceId, slice) => {
      await api().deviceState.setCapSlice.mutate({
        deviceId,
        capName: 'motion',
        slice: { ...slice },
      })
    },
    readSlice: async (deviceId) => {
      try {
        const slice = await api().deviceState.getCapSlice.query({ deviceId, capName: 'motion' })
        return { kind: 'answered', slice }
      } catch (err: unknown) {
        return { kind: 'unreadable', error: errMsg(err) }
      }
    },
  }
}
