import { describe, expect, it, vi } from 'vitest'
import { performRawRead, type RawReadDeps } from '../raw-read'

/**
 * Auto-focus is a question only a PTZ camera can answer.
 *
 * Measured on device 3825 ("Magicam", an Argus MagiCam behind a Home Hub) on
 * 2026-09-19, sweeping every read CamStack performs: fifteen of sixteen
 * answered, and exactly one did not —
 *
 *   autofocus  FAIL  PCAP-derived settings GET failed for cmdId=224
 *
 * cmd 224 appears in NEITHER packet capture of the Reolink app taken that day:
 * the app never asks a fixed-focus camera about its focus motor, because there
 * is none. The snapshot probe had already learned this the expensive way and
 * carries a sticky `supported: false` skip; the raw read had no such gate and
 * dialled the camera every time, to be told 400 three times over at 1.5 s
 * apiece.
 *
 * So the gate is the camera's own PTZ probe, and a camera without one is told
 * WHY rather than handed a failure that reads like a fault.
 */

function deps(over: Partial<RawReadDeps> = {}): RawReadDeps {
  return {
    deviceId: 3825,
    channel: 3,
    sleeping: false,
    hubChild: true,
    hasPtz: false,
    getApi: vi.fn(async () => ({ getAutoFocus: vi.fn() })) as unknown as RawReadDeps['getApi'],
    believedCache: {},
    believedCapState: {},
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  } as RawReadDeps
}

describe('the autofocus raw read', () => {
  it('is refused on a camera with no PTZ, and says why', async () => {
    const d = deps({ hasPtz: false })
    const result = await performRawRead('autofocus', d)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('unsupported')
    expect(result.ok === false && result.message).toContain('focus')
    // The whole point: the camera is never dialled.
    expect(d.getApi).not.toHaveBeenCalled()
  })

  it('still runs on a camera that has PTZ', async () => {
    const getAutoFocus = vi.fn(async () => ({ body: { AutoFocus: { disable: 0 } } }))
    const d = deps({
      hasPtz: true,
      getApi: vi.fn(async () => ({ getAutoFocus })) as unknown as RawReadDeps['getApi'],
    })
    const result = await performRawRead('autofocus', d)
    expect(d.getApi).toHaveBeenCalled()
    expect(result.ok).toBe(true)
  })

  it('gates NOTHING else on PTZ', async () => {
    // The refusal is about cmd 224 only. A camera without a focus motor still
    // has an image, an encoder and a mask.
    const getVideoInput = vi.fn(async () => ({ body: { VideoInput: { bright: 128 } } }))
    const d = deps({
      hasPtz: false,
      getApi: vi.fn(async () => ({ getVideoInput })) as unknown as RawReadDeps['getApi'],
    })
    const result = await performRawRead('image', d)
    expect(result.ok).toBe(true)
  })
})
