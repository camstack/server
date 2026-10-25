/**
 * The census reads hap-nodejs internals through a declared shape. These tests
 * pin BOTH halves of that: the numbers it reports for a healthy accessory, and
 * that every missing hop degrades to "we could not tell" instead of throwing on
 * a control path.
 */
import { describe, expect, it } from 'vitest'

import { describeHapControllers, noAdminControllerConnected } from '../controller-census.js'

const ADMIN = 'AA:BB:CC:DD:EE:FF'
const GUEST = '11:22:33:44:55:66'

interface AccessoryShape {
  readonly connections: readonly { readonly username?: string }[]
  readonly admins: readonly string[]
  readonly paired: readonly string[]
}

function accessory(shape: AccessoryShape): unknown {
  return {
    _accessoryInfo: {
      pairedClients: Object.fromEntries(shape.paired.map((u) => [u, {}])),
      hasAdminPermissions: (username: string) => shape.admins.includes(username),
    },
    _server: { httpServer: { connections: new Set(shape.connections) } },
  }
}

describe('describeHapControllers', () => {
  it('separates admin, non-admin and unauthenticated connections', () => {
    const census = describeHapControllers(
      accessory({
        connections: [{ username: ADMIN }, { username: GUEST }, {}],
        admins: [ADMIN],
        paired: [ADMIN, GUEST],
      }),
    )
    expect(census).toEqual({
      serverPublished: true,
      connections: 3,
      adminConnections: 1,
      nonAdminConnections: 1,
      unverifiedConnections: 1,
      pairedControllers: 2,
      pairedAdmins: 1,
    })
  })

  it('still counts the PAIRED controllers when none is connected', () => {
    // A home hub that is paired but offline is a different fault from a home
    // hub that was never paired, and the connection list cannot tell them apart.
    const census = describeHapControllers(
      accessory({ connections: [], admins: [ADMIN], paired: [ADMIN, GUEST] }),
    )
    expect(census.connections).toBe(0)
    expect(census.pairedControllers).toBe(2)
    expect(census.pairedAdmins).toBe(1)
  })

  it('degrades instead of throwing when the accessory is not published', () => {
    // Before `publish()` there is no `_server`. This is the state the restore
    // path runs in, one second after boot.
    const unpublished = {
      _accessoryInfo: {
        pairedClients: { [ADMIN]: {} },
        hasAdminPermissions: () => true,
      },
    }
    const census = describeHapControllers(unpublished)
    expect(census.serverPublished).toBe(false)
    expect(census.pairedControllers).toBe(1)
  })

  it('degrades instead of throwing on any shape the library may change', () => {
    for (const value of [
      undefined,
      null,
      42,
      {},
      { _server: {} },
      { _server: { httpServer: {} } },
    ]) {
      expect(() => describeHapControllers(value)).not.toThrow()
      expect(describeHapControllers(value).serverPublished).toBe(false)
    }
  })
})

describe('noAdminControllerConnected', () => {
  it('is true only when somebody IS connected and none of them may write', () => {
    const connectedGuest = describeHapControllers(
      accessory({ connections: [{ username: GUEST }], admins: [ADMIN], paired: [ADMIN, GUEST] }),
    )
    expect(noAdminControllerConnected(connectedGuest)).toBe(true)
  })

  it('is false when nobody is connected — that is a different fault', () => {
    const nobody = describeHapControllers(
      accessory({ connections: [], admins: [ADMIN], paired: [ADMIN] }),
    )
    expect(noAdminControllerConnected(nobody)).toBe(false)
  })

  it('is false as soon as one admin is connected', () => {
    const withAdmin = describeHapControllers(
      accessory({
        connections: [{ username: GUEST }, { username: ADMIN }],
        admins: [ADMIN],
        paired: [ADMIN, GUEST],
      }),
    )
    expect(noAdminControllerConnected(withAdmin)).toBe(false)
  })
})
