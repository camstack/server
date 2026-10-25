/**
 * D696: a camera provider's `motion.isDetected` answers from the HUB's slice,
 * which only the orchestrator writes. Its local runtime state no longer holds
 * a `motion` slice. An unanswered read, and a slice nobody has published yet,
 * are UNKNOWN: the call fails, it never answers `false` (D49, D393).
 */
import { describe, expect, it } from 'vitest'
import {
  type HubMotionSliceReader,
  hubMotionNativeProvider,
  readHubMotionDetected,
  readHubMotionStatus,
} from '../hub-motion-read.js'

function reader(answer: () => Promise<Readonly<Record<string, unknown>> | null>): {
  readonly port: HubMotionSliceReader
  readonly asked: { deviceId: number; capName: string }[]
} {
  const asked: { deviceId: number; capName: string }[] = []
  return {
    asked,
    port: {
      getCapSlice: {
        query: (input) => {
          asked.push(input)
          return answer()
        },
      },
    },
  }
}

describe('readHubMotionDetected (D696)', () => {
  it("answers the hub slice's `detected`, asking for this device's `motion`", async () => {
    const on = reader(async () => ({
      detected: true,
      lastDetectedAt: 5,
      autoClearAfterMs: 15_000,
    }))
    await expect(readHubMotionDetected(on.port, 7)).resolves.toBe(true)
    expect(on.asked).toEqual([{ deviceId: 7, capName: 'motion' }])
    const off = reader(async () => ({
      detected: false,
      lastDetectedAt: 5,
      autoClearAfterMs: null,
    }))
    await expect(readHubMotionDetected(off.port, 7)).resolves.toBe(false)
  })
  it('an unreadable hub is unknown: it throws, never false', async () => {
    const r = reader(async () => {
      throw new Error('hub unreachable')
    })
    await expect(readHubMotionDetected(r.port, 7)).rejects.toThrow(/unreadable.*hub unreachable/)
  })
  it('a slice nobody published yet is unknown: it throws, never false', async () => {
    await expect(readHubMotionDetected(reader(async () => null).port, 7)).rejects.toThrow(
      /not published/,
    )
    await expect(
      readHubMotionDetected(reader(async () => ({ lastDetectedAt: 1 })).port, 7),
    ).rejects.toThrow(/not published/)
  })
})

describe('readHubMotionStatus (D696): the `getStatus` half', () => {
  it("answers the hub slice as a MotionStatus, asking for this device's `motion`", async () => {
    const slice = {
      detected: false,
      lastDetectedAt: 1791305772852,
      autoClearAfterMs: null,
    }
    const r = reader(async () => slice)
    await expect(readHubMotionStatus(r.port, 101)).resolves.toEqual(slice)
    expect(r.asked).toEqual([{ deviceId: 101, capName: 'motion' }])
  })
  it('a slice nobody published yet is `null` — the status contract`s own "no status"', async () => {
    await expect(readHubMotionStatus(reader(async () => null).port, 7)).resolves.toBeNull()
  })
  it('an unreadable hub throws, it is never folded into null', async () => {
    const r = reader(async () => {
      throw new Error('hub unreachable')
    })
    await expect(readHubMotionStatus(r.port, 7)).rejects.toThrow(/unreadable.*hub unreachable/)
  })
  it('a malformed slice throws, naming the device', async () => {
    await expect(
      readHubMotionStatus(reader(async () => ({ lastDetectedAt: 1 })).port, 7),
    ).rejects.toThrow(/device 7 is malformed/)
  })
})

/**
 * The regression this exists for (2026-10-06): every camera provider served
 * ONLY `isDetected`, so `registerNativeCap` installed the framework's default
 * `getStatus` — a read of the provider's LOCAL runtime state, where D696 means
 * no `motion` slice ever lands. `motion.getStatus` answered `null` for every
 * camera while the hub held its slice. The provider must answer BOTH reads.
 */
describe('hubMotionNativeProvider (D696)', () => {
  const HUB_SLICE = {
    detected: true,
    lastDetectedAt: 1791305772852,
    autoClearAfterMs: 15_000,
  }

  it('serves getStatus from the hub, so the framework never installs its local-state default', async () => {
    const provider = hubMotionNativeProvider(reader(async () => HUB_SLICE).port, 101, 'Cam')
    expect(typeof provider.getStatus).toBe('function')
    await expect(provider.getStatus?.({ deviceId: 101 })).resolves.toEqual(HUB_SLICE)
    await expect(provider.isDetected({ deviceId: 101 })).resolves.toBe(true)
  })
  it('refuses another device, naming the owner', async () => {
    const provider = hubMotionNativeProvider(reader(async () => HUB_SLICE).port, 101, 'Cam')
    await expect(provider.getStatus?.({ deviceId: 616 })).rejects.toThrow(/Cam: .*616/)
    await expect(provider.isDetected({ deviceId: 616 })).rejects.toThrow(/Cam: .*616/)
  })
})
