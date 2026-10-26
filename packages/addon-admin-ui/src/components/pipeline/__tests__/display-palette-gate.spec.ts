import { bundledCamstack } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { paletteViewOf } from '../display-palette-gate'

const READY = bundledCamstack()

describe('paletteViewOf', () => {
  it('keeps the last answered palette when a background refetch fails', () => {
    const view = paletteViewOf({
      isPending: false,
      isError: true,
      error: new Error('Unknown error'),
      data: READY,
    })
    expect(view.status).toBe('ready')
  })

  it('reads as unknown only when the hub never answered', () => {
    const view = paletteViewOf({
      isPending: false,
      isError: true,
      error: new Error('Unknown error'),
      data: undefined,
    })
    expect(view).toEqual({ status: 'unknown', reason: 'Error: Unknown error' })
  })

  it('stays pending before the first answer', () => {
    expect(
      paletteViewOf({ isPending: true, isError: false, error: null, data: undefined }),
    ).toEqual({ status: 'pending' })
  })

  it('passes on an unknown the hub itself answered', () => {
    const view = paletteViewOf({
      isPending: false,
      isError: false,
      error: null,
      data: { status: 'unknown', reason: 'store unreadable' },
    })
    expect(view).toEqual({ status: 'unknown', reason: 'store unreadable' })
  })
})
