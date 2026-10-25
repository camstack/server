// @vitest-environment jsdom
/**
 * The camera microphone inside the privacy-mask panel — the WRITE side
 * ([D113](../../../../../../docs/decisions/adr-0113.md) phase 3,
 * `device-audio`).
 *
 * What the round-trip has to prove, because the deprecated switch group is the
 * only other thing that can write this today:
 *
 *  - the control writes the REAL authority — `privacyMask.setAudioEnabled` —
 *    and then READS THE CAMERA BACK (this cap has no server-side mirror; the
 *    device is the store);
 *  - a camera already muted renders OFF on the first render and issues no
 *    write on mount (state survival across the surface change);
 *  - a camera that cannot be written offers no control at all;
 *  - saving the MASK never touches the microphone.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getOptions = vi.fn()
const getStatus = vi.fn()
const setAudioEnabledMock = vi.fn()
const setMaskMock = vi.fn()

interface MockProxy {
  readonly privacyMask: {
    readonly getOptions: typeof getOptions
    readonly getStatus: typeof getStatus
    readonly setAudioEnabled: typeof setAudioEnabledMock
    readonly setMask: typeof setMaskMock
  }
}

let mockDev: MockProxy | null = null

vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceProxy: () => mockDev,
}))
vi.mock('../../../contexts/system-context', () => ({
  useSystem: () => ({ trpcClient: {} }),
}))
vi.mock('../../../contexts/player-overlays', () => ({
  usePlayerOverlayLayer: () => undefined,
}))

import { PrivacyMaskSettings } from '../PrivacyMaskSettings'

const MASKABLE = {
  maxRegions: 4,
  supportedShapes: ['rect'],
  supportsAudioMute: true,
}

beforeEach(() => {
  getOptions.mockReset()
  getStatus.mockReset()
  setAudioEnabledMock.mockReset()
  setMaskMock.mockReset()
  mockDev = {
    privacyMask: {
      getOptions,
      getStatus,
      setAudioEnabled: setAudioEnabledMock,
      setMask: setMaskMock,
    },
  }
  getOptions.mockResolvedValue(MASKABLE)
  getStatus.mockResolvedValue({
    enabled: false,
    regions: [],
    audioEnabled: true,
    lastFetchedAt: 0,
  })
})

afterEach(() => {
  cleanup()
})

function micSwitch(): HTMLElement {
  return screen.getByRole('switch', { name: 'Microphone' })
}

describe('PrivacyMaskSettings — the microphone', () => {
  it('writes the REAL authority and reads the camera back', async () => {
    render(<PrivacyMaskSettings deviceId={102} />)
    await waitFor(() => micSwitch())
    expect(micSwitch()).toHaveProperty('ariaChecked', 'true')

    getStatus.mockResolvedValue({
      enabled: false,
      regions: [],
      audioEnabled: false,
      lastFetchedAt: 0,
    })
    fireEvent.click(micSwitch())

    await waitFor(() => {
      expect(setAudioEnabledMock).toHaveBeenCalledWith({ enabled: false })
    })
    // The read-back, not the optimistic guess, is what the control settles on.
    await waitFor(() => {
      expect(screen.getByText('Microphone off')).toBeTruthy()
    })
    expect(setMaskMock).not.toHaveBeenCalled()
  })

  it('STATE SURVIVAL: a camera muted through the deprecated group renders OFF and writes nothing on mount', async () => {
    getStatus.mockResolvedValue({
      enabled: false,
      regions: [],
      audioEnabled: false,
      lastFetchedAt: 0,
    })
    render(<PrivacyMaskSettings deviceId={102} />)
    await waitFor(() => {
      expect(screen.getByText('Microphone off')).toBeTruthy()
    })
    expect(setAudioEnabledMock).not.toHaveBeenCalled()
  })

  it('offers NO control when the camera cannot be written', async () => {
    getOptions.mockResolvedValue({ ...MASKABLE, supportsAudioMute: false })
    render(<PrivacyMaskSettings deviceId={102} />)
    await waitFor(() => screen.getByRole('button', { name: 'Edit mask' }))
    expect(screen.queryByRole('switch', { name: 'Microphone' })).toBeNull()
  })

  it('a camera with a microphone but NO mask slots still gets its microphone', async () => {
    getOptions.mockResolvedValue({ maxRegions: 0, supportedShapes: [], supportsAudioMute: true })
    render(<PrivacyMaskSettings deviceId={102} />)
    // The mask half says it is unsupported…
    await waitFor(() => screen.getByText(/doesn.t support an on-board privacy mask/i))
    // …and the audio half is still there, because the two planes are separate.
    expect(micSwitch()).toBeTruthy()
  })

  it('a camera that did not report its microphone reads UNKNOWN, never off', async () => {
    getStatus.mockResolvedValue({
      enabled: false,
      regions: [],
      audioEnabled: null,
      lastFetchedAt: 0,
    })
    render(<PrivacyMaskSettings deviceId={102} />)
    await waitFor(() => {
      expect(screen.getByText('Microphone unknown')).toBeTruthy()
    })
    expect(micSwitch()).toHaveProperty('disabled', true)
    fireEvent.click(micSwitch())
    expect(setAudioEnabledMock).not.toHaveBeenCalled()
  })
})
