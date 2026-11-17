// @vitest-environment jsdom
/**
 * useDeviceCommand runs a control's command and reports a refusal; it never
 * touches what the control shows (D1061).
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ alert: vi.fn<(options: { message: string }) => Promise<void>>() }))

vi.mock('../../composites/confirm-dialog', () => ({
  useAlertIfAvailable: () => h.alert,
}))

import { useDeviceCommand } from '../use-device-command'

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  h.alert.mockReset().mockResolvedValue(undefined)
})

describe('useDeviceCommand', () => {
  it('runs the command and says nothing when it goes through', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useDeviceCommand())
    result.current(run)
    await settle()
    expect(run).toHaveBeenCalledTimes(1)
    expect(h.alert).not.toHaveBeenCalled()
  })

  it('reports a refusal, a rejection or a synchronous throw alike', async () => {
    const { result } = renderHook(() => useDeviceCommand())
    result.current(() => Promise.reject(new Error('device offline')))
    await settle()
    expect(h.alert).toHaveBeenCalledWith(expect.objectContaining({ message: 'device offline' }))

    result.current(() => {
      throw new Error('no such method')
    })
    await settle()
    expect(h.alert).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'no such method' }))
  })

  it('shows one refusal at a time', async () => {
    h.alert.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useDeviceCommand())
    result.current(() => Promise.reject(new Error('first')))
    result.current(() => Promise.reject(new Error('second')))
    await settle()
    expect(h.alert).toHaveBeenCalledTimes(1)
  })

  it("hands the refusal to the caller's onError instead of the alert", async () => {
    const onError = vi.fn()
    const { result } = renderHook(() => useDeviceCommand())
    result.current(() => Promise.reject(new Error('refused')), onError)
    await settle()
    expect(onError).toHaveBeenCalledWith(new Error('refused'))
    expect(h.alert).not.toHaveBeenCalled()
  })
})
