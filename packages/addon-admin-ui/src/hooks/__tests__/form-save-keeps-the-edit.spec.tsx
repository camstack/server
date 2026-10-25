/**
 * The saved value must not vanish while the save is still in flight.
 *
 * `handleSave` used to drop the keys from the pending-edit overlay
 * SYNCHRONOUSLY and then fire the mutation. Since the rendered value is
 * `{...serverValues, ...pendingEdits}`, the field snapped back to the OLD
 * server value the instant Save was clicked, and polling resumed 500 ms later
 * while the write was still travelling.
 *
 * On a Reolink battery camera that write is a wake, a set and a read-back —
 * seconds, not milliseconds — so the operator saw the value revert and stay
 * reverted. But the defect is not battery-specific and neither is the fix:
 * ANY save slower than the next poll shows it.
 *
 * The rule: an edit stays on screen until the caller says the save has landed
 * AND the server has been re-read. A save that fails puts the edit back, where
 * the operator can see it and retry — it is their text, and losing it silently
 * is worse than the revert.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useFormSaveController } from '../useFormSaveController'

const SCHEMA = {
  sections: [{ fields: [{ type: 'text', key: 'osdTimePosition' }] }],
} as never

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('handleSave keeps the edit until the save lands', () => {
  it('still shows the edited value while the mutation is in flight', async () => {
    const gate = deferred<void>()
    const onDeferredSave = vi.fn(() => gate.promise)

    const { result } = renderHook(() =>
      useFormSaveController({
        schema: SCHEMA,
        serverValues: { osdTimePosition: 'bottom-right' },
        onImmediateSave: vi.fn(),
        onDeferredSave,
      }),
    )

    act(() => result.current.handleChange({ osdTimePosition: 'top-left' }))
    expect(result.current.values['osdTimePosition']).toBe('top-left')

    act(() => result.current.handleSave(['osdTimePosition']))

    // The save is away and the overlay no longer calls it "pending" — but the
    // operator must still be looking at what they saved, not at the old value.
    expect(onDeferredSave).toHaveBeenCalledWith({ osdTimePosition: 'top-left' })
    expect(result.current.pendingKeys).toEqual([])
    expect(result.current.values['osdTimePosition']).toBe('top-left')

    await act(async () => {
      gate.resolve()
      await gate.promise
    })
    await waitFor(() => expect(result.current.values['osdTimePosition']).toBe('bottom-right'))
  })

  it('hands the edit back to the operator when the save fails', async () => {
    const gate = deferred<void>()
    const onDeferredSave = vi.fn(() => gate.promise)

    const { result } = renderHook(() =>
      useFormSaveController({
        schema: SCHEMA,
        serverValues: { osdTimePosition: 'bottom-right' },
        onImmediateSave: vi.fn(),
        onDeferredSave,
      }),
    )

    act(() => result.current.handleChange({ osdTimePosition: 'top-left' }))
    act(() => result.current.handleSave(['osdTimePosition']))

    await act(async () => {
      gate.reject(new Error('camera did not answer'))
      await gate.promise.catch(() => undefined)
    })

    // Back in the overlay: still on screen, and marked unsaved so the Save
    // button returns. Silently discarding the operator's text is worse than
    // the revert this whole change is about.
    await waitFor(() => expect(result.current.pendingKeys).toEqual(['osdTimePosition']))
    expect(result.current.values['osdTimePosition']).toBe('top-left')
  })

  it('does not resume polling while a save is still travelling', async () => {
    const gate = deferred<void>()
    const { result } = renderHook(() =>
      useFormSaveController({
        schema: SCHEMA,
        serverValues: { osdTimePosition: 'bottom-right' },
        onImmediateSave: vi.fn(),
        onDeferredSave: vi.fn(() => gate.promise),
      }),
    )

    act(() => result.current.handleChange({ osdTimePosition: 'top-left' }))
    act(() => result.current.handleSave(['osdTimePosition']))

    // The pause normally lifts 500 ms after the last edit. Waiting past that
    // is the whole point of this test: a poll landing mid-write would overwrite
    // the field with the value the write is in the middle of replacing, and
    // asserting `true` on the very next tick would pass today by accident.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700))
    })
    expect(result.current.editingPaused).toBe(true)

    await act(async () => {
      gate.resolve()
      await gate.promise
    })
    await waitFor(() => expect(result.current.editingPaused).toBe(false))
  })

  it('a caller that reports nothing keeps the old behaviour', async () => {
    // AddonFormPane drives its own flush and returns void from this callback.
    // Nothing can be awaited there, so the overlay clears as it always did —
    // named here so the branch is a decision, not an oversight.
    const { result } = renderHook(() =>
      useFormSaveController({
        schema: SCHEMA,
        serverValues: { osdTimePosition: 'bottom-right' },
        onImmediateSave: vi.fn(),
        onDeferredSave: vi.fn(),
      }),
    )

    act(() => result.current.handleChange({ osdTimePosition: 'top-left' }))
    act(() => result.current.handleSave(['osdTimePosition']))

    await waitFor(() => expect(result.current.values['osdTimePosition']).toBe('bottom-right'))
  })
})
