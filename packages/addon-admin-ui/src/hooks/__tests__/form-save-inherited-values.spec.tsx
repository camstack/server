/**
 * A form that SHOWS inherited cluster values must not save them.
 *
 * The per-camera Analytics form hydrates every field with the effective value
 * (cluster store under the camera's own blob). The server values the save
 * controller sees therefore contain keys the camera never wrote. Saving one
 * edited field has to send that field alone: sending the rest would copy the
 * cluster's numbers onto the camera and freeze them there, so a later cluster
 * change would silently stop reaching it.
 *
 * Pinned at the controller because `FormBuilder.onChange` hands it the WHOLE
 * values bag on every keystroke; "only what changed" is the controller's diff.
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useFormSaveController } from '../useFormSaveController'

const SCHEMA = {
  sections: [
    {
      fields: [
        { type: 'number', key: 'minHits' },
        { type: 'number', key: 'cooldownSec' },
        { type: 'number', key: 'minTrackAge' },
      ],
    },
  ],
} as never

// minHits and cooldownSec are inherited from the cluster; the camera saved nothing.
const SERVER_VALUES = { minHits: 7, cooldownSec: 11, minTrackAge: 3 }

describe('saving one field of a form that shows inherited values', () => {
  it('sends only the edited key, never the inherited ones', async () => {
    const onDeferredSave = vi.fn(async () => undefined)
    const { result } = renderHook(() =>
      useFormSaveController({
        schema: SCHEMA,
        serverValues: SERVER_VALUES,
        onImmediateSave: vi.fn(),
        onDeferredSave,
      }),
    )

    // What FormBuilder does: the whole bag with one key changed.
    act(() => result.current.handleChange({ ...SERVER_VALUES, minTrackAge: 9 }))
    expect(result.current.pendingKeys).toEqual(['minTrackAge'])

    await act(async () => {
      result.current.handleSave(result.current.pendingKeys)
    })

    expect(onDeferredSave).toHaveBeenCalledTimes(1)
    expect(onDeferredSave).toHaveBeenCalledWith({ minTrackAge: 9 })
  })

  it('an untouched inherited field is not pending', () => {
    const { result } = renderHook(() =>
      useFormSaveController({
        schema: SCHEMA,
        serverValues: SERVER_VALUES,
        onImmediateSave: vi.fn(),
        onDeferredSave: vi.fn(),
      }),
    )
    expect(result.current.pendingKeys).toEqual([])
    expect(result.current.values['minHits']).toBe(7)
  })
})
