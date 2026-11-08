import type { ICamstackAddon } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { createChildAddonCallDispatch } from '../child-addon-call-dispatch.js'

/** A grouped runner: its UDS child id is the GROUP name, its addons keep their own ids. */
function groupedRunner() {
  const hosted = new Map<string, ICamstackAddon>([
    ['auth-oidc', {} as ICamstackAddon],
    ['auth-webauthn', {} as ICamstackAddon],
  ])
  return createChildAddonCallDispatch({
    getRouteProvider: () => null,
    customActions: {} as never,
    getAddonInstance: (id) => hosted.get(id) ?? null,
    listAddonIds: () => [...hosted.keys()],
    getDataPlanes: () => [],
  })
}

describe('a settings call to an addon this runner does not host', () => {
  it('names the addons the runner does host, so a group name is not mistaken for an addon id', async () => {
    const dispatch = groupedRunner()
    await expect(
      dispatch({ addonId: 'auth', target: 'settings', method: 'listScopedSettings', args: {} }),
    ).rejects.toThrow(/"auth" is not loaded in this runner.*hosts: auth-oidc, auth-webauthn/)
  })
})
