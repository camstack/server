import type { ICamstackAddon } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { createChildAddonCallDispatch } from '../child-addon-call-dispatch.js'

function dispatchFor(addon: Partial<ICamstackAddon>) {
  return createChildAddonCallDispatch({
    getRouteProvider: () => null,
    customActions: {} as never,
    getAddonInstance: () => addon as ICamstackAddon,
    getDataPlanes: () => [],
  })
}

describe('scoped settings over the addon-call plane', () => {
  it('hands scope, cap, patch and node to the addon and acks the write', async () => {
    const update = vi.fn(async () => undefined)
    const read = vi.fn(async () => ({ k: 1 }))
    const get = vi.fn(async () => ({ sections: [] }))
    const dispatch = dispatchFor({
      updateScopedSettings: update,
      readScopedValues: read,
      getScopedSettings: get,
    })
    const args = { scope: 'node', cap: 'c', nodeId: 'n1' }
    expect(
      await dispatch({
        addonId: 'a',
        target: 'settings',
        method: 'updateScopedSettings',
        args: { ...args, patch: { k: 2 } },
      }),
    ).toEqual({ success: true })
    expect(update).toHaveBeenCalledWith('node', 'c', { k: 2 }, 'n1')
    expect(
      await dispatch({ addonId: 'a', target: 'settings', method: 'readScopedValues', args }),
    ).toEqual({ k: 1 })
    expect(
      await dispatch({ addonId: 'a', target: 'settings', method: 'getScopedSettings', args }),
    ).toEqual({ sections: [] })
    expect(get).toHaveBeenCalledWith('node', 'c', 'n1')
  })

  it('refuses a call without scope and cap', async () => {
    const dispatch = dispatchFor({ readScopedValues: async () => ({}) })
    await expect(
      dispatch({ addonId: 'a', target: 'settings', method: 'readScopedValues', args: {} }),
    ).rejects.toThrow(/needs scope and cap/)
  })
})
