// @vitest-environment jsdom
/**
 * useOneShotCommand: a second claim while one command is in flight is refused
 * (a double tap on Feed or Run sends once), and the claim is released when
 * the command settles — resolved, rejected or thrown (D1061).
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useOneShotCommand } from '../use-one-shot-command'

describe('useOneShotCommand', () => {
  it('refuses a second claim until the first command settles', async () => {
    const { result } = renderHook(() => useOneShotCommand())
    let finish: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    let first: ReturnType<typeof result.current.claim> = null
    act(() => {
      first = result.current.claim(() => pending)
    })
    expect(first).not.toBeNull()
    expect(result.current.inFlight).toBe(true)
    expect(result.current.claim(() => Promise.resolve())).toBeNull()
    let running: PromiseLike<unknown> | undefined
    act(() => {
      running = first?.()
    })
    await act(async () => {
      finish?.()
      await running
    })
    expect(result.current.inFlight).toBe(false)
    expect(result.current.claim(() => Promise.resolve())).not.toBeNull()
  })

  it('releases the claim when the command is refused', async () => {
    const { result } = renderHook(() => useOneShotCommand())
    const command = result.current.claim(() => Promise.reject(new Error('refused')))
    await act(async () => {
      await expect(command?.()).rejects.toThrow('refused')
    })
    expect(result.current.inFlight).toBe(false)
  })

  it('releases the claim when the command throws synchronously', () => {
    const { result } = renderHook(() => useOneShotCommand())
    const command = result.current.claim(() => {
      throw new Error('no binding')
    })
    act(() => {
      expect(() => command?.()).toThrow('no binding')
    })
    expect(result.current.inFlight).toBe(false)
  })
})
