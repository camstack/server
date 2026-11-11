/**
 * `auth.deviceAccess` answers, per device, what the hub would decide on a
 * real command — and the hub does refuse the command on a device outside the
 * caller's grant.
 *
 * Disarm: make `deviceAccessOf` read the caller's RAW scopes instead of
 * `enforcedScopesOf` — the person with a legacy `category:device` row then
 * reads `command: true` while the middleware refuses its command, and the
 * "agrees with enforcement" case fails.
 */
import type { CredentialScope } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { deviceAccessOf } from '../device-access.js'
import { resetPersonWithoutViewerLog } from '../person-without-viewer.js'
import type { DeviceScopeLookup } from '../scope-access.js'
import type { AuthenticatedAgent, TrpcContext } from '../trpc.context.js'
import { protectedProcedure, trpcRouter } from '../trpc.middleware.js'

const PLUG = 5
const OTHER = 9

const lookup: DeviceScopeLookup = {
  getAncestors: () => [],
  getType: (id) => (id === PLUG || id === OTHER ? 'switch' : null),
  getLocation: () => null,
}

/** The real cap path, behind the real middleware. */
const testRouter = trpcRouter({
  switch: trpcRouter({
    setState: protectedProcedure
      .input(z.object({ deviceId: z.number(), on: z.boolean() }))
      .mutation(({ input }) => ({ deviceId: input.deviceId })),
  }),
})

function person(scopes: readonly CredentialScope[], isAdmin = false): AuthenticatedAgent {
  return {
    id: 'u-1',
    username: 'ada',
    isAdmin,
    permissions: { isAdmin, allowedProviders: '*', allowedDevices: {} },
    isApiKey: false,
    interactive: true,
    scopes,
  }
}

function token(scopes: readonly CredentialScope[]): AuthenticatedAgent {
  return {
    ...person(scopes),
    id: 'token:t',
    username: 'token:t',
    isApiKey: true,
    interactive: false,
  }
}

function commandOn(principal: AuthenticatedAgent, deviceId: number): Promise<unknown> {
  const ctx: TrpcContext = { user: principal, deviceScopeLookup: lookup }
  return testRouter.createCaller(ctx).switch.setState({ deviceId, on: true })
}

describe('auth.deviceAccess — per device, decided like the command itself', () => {
  beforeEach(() => resetPersonWithoutViewerLog())

  it('a viewer whose devices include the plug may command it and not another device; the hub refuses the other', async () => {
    const viewer = person([{ type: 'viewer', allow: [PLUG], block: [], features: [] }])
    expect(deviceAccessOf(viewer, PLUG, lookup)).toEqual({ view: true, command: true })
    expect(deviceAccessOf(viewer, OTHER, lookup)).toEqual({ view: false, command: false })
    await expect(commandOn(viewer, PLUG)).resolves.toEqual({ deviceId: PLUG })
    await expect(commandOn(viewer, OTHER)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('a token with a view-only grant on the plug may look and not command; the hub refuses the command', async () => {
    const t = token([{ type: 'device', selector: { kind: 'ids', ids: [PLUG] }, access: ['view'] }])
    expect(deviceAccessOf(t, PLUG, lookup)).toEqual({ view: true, command: false })
    await expect(commandOn(t, PLUG)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('agrees with enforcement for a person holding only a legacy grant row', async () => {
    const legacy = person([
      { type: 'category', target: 'device', access: ['view', 'create', 'delete'] },
    ])
    expect(deviceAccessOf(legacy, PLUG, lookup)).toEqual({ view: false, command: false })
    await expect(commandOn(legacy, PLUG)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('an admin may command every device', () => {
    expect(deviceAccessOf(person(['*'], true), OTHER, lookup)).toEqual({
      view: true,
      command: true,
    })
  })
})
