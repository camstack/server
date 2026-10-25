/**
 * A scoped camera operator can talk through a camera they are granted.
 *
 * The incident (2026-08-29): a non-admin viewer user tapped the talk button on
 * a Hikvision doorbell four times in twenty-four seconds and got a generic
 * "talk failed" alert every time. The hub logged the truth —
 *
 *   FORBIDDEN  intercom.startSession  principal="bob (session)"  "Admin required"
 *
 * — and the call never reached `provider-hikvision`, let alone the camera. The
 * user held `device:all[view,create]`, exactly the `camera-operator` grant whose
 * description has promised intercom since the initial commit. Every method of
 * the `intercom` cap was `auth: 'admin'`.
 *
 * The two gates are SEQUENTIAL, not additive: `adminProcedure` throws before
 * `protectedProcedure`'s scope check ever runs. So a cap method resolving to
 * `'admin'` makes its scope wiring — present and correct here, down to
 * `METHOD_DEVICE_SELECTORS` — unreachable by construction. That is why this
 * spec asserts BOTH halves per method: the tier that decides which procedure
 * builds it, and the matcher that then decides which devices it reaches.
 *
 * The first half is the regression bar. Put `auth: 'admin'` back on any one of
 * the six methods and this goes red on that method, because the scope grant
 * below can never be consulted for it.
 */

import type { CapabilityDefinition } from '@camstack/types'
import { intercomCapability, resolveMethodAuth } from '@camstack/types'
import type {
  CapabilityMethodSchema,
  DeviceSelector,
  MethodAccess,
  TokenScope,
} from '@camstack/types'
import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { checkScopeAccess, type DeviceScopeLookup } from '../scope-access.js'

/** Widened the way the router builder sees it — `resolveMethodAuth` reads only `internal`. */
const intercomDef: CapabilityDefinition = intercomCapability

/** The doorbell the operator tapped, plus a camera they were NOT granted. */
const GRANTED_CAMERA = 102
const OTHER_CAMERA = 101

const lookup: DeviceScopeLookup = {
  getAncestors: () => [],
  getType: () => DeviceType.Camera,
  getLocation: () => null,
}

/** `device:{ids:[102]}` at the given tier — the narrow shape of a real grant. */
function deviceGrant(selector: DeviceSelector, access: readonly MethodAccess[]): TokenScope {
  return { type: 'device', selector, access: [...access] }
}

/** The `camera-operator` preset, verbatim: `category:device[view,create]`. */
const CAMERA_OPERATOR: readonly TokenScope[] = [
  { type: 'category', target: 'device', access: ['view', 'create'] },
]

/** The `camera-viewer` preset, verbatim: `category:device[view]`. */
const CAMERA_VIEWER: readonly TokenScope[] = [
  { type: 'category', target: 'device', access: ['view'] },
]

const METHODS: Readonly<Record<string, CapabilityMethodSchema>> = intercomCapability.methods

/** One call as the middleware sees it: the tRPC path and its raw input. */
interface IntercomCall {
  readonly path: string
  readonly input: { readonly deviceId: number }
}

/** tRPC path + a minimal input carrying the `deviceId` the matcher reads. */
function callFor(methodName: string, deviceId: number): IntercomCall {
  return { path: `intercom.${methodName}`, input: { deviceId } }
}

describe('intercom is reachable by a scoped, non-admin camera operator', () => {
  it('declares six methods — the whole cap is talk-session operation, none of it configuration', () => {
    // Guards the loops below against silently covering a shrunken cap.
    expect(Object.keys(METHODS).toSorted()).toEqual([
      'endTalkSession',
      'handleAnswer',
      'pushTalkAudio',
      'startSession',
      'startTalkSession',
      'stopSession',
    ])
  })

  it('resolves every method to a scope-checked tier, never to admin', () => {
    for (const [name, schema] of Object.entries(METHODS)) {
      const auth = resolveMethodAuth(intercomDef, schema)
      expect(
        auth,
        `intercom.${name} resolves to '${auth}' — adminProcedure refuses a non-admin before the scope check runs, so no grant can reach it`,
      ).not.toBe('admin')
    }
  })

  it('admits a camera-operator grant on every method', () => {
    for (const name of Object.keys(METHODS)) {
      const { path, input } = callFor(name, GRANTED_CAMERA)
      const result = checkScopeAccess(CAMERA_OPERATOR, path, input, lookup)
      expect(result.ok, `${path}: ${result.ok ? '' : result.reason}`).toBe(true)
    }
  })

  it('admits a device-selector grant naming only that camera', () => {
    const scopes = [deviceGrant({ kind: 'ids', ids: [GRANTED_CAMERA] }, ['view', 'create'])]
    for (const name of Object.keys(METHODS)) {
      const { path, input } = callFor(name, GRANTED_CAMERA)
      const result = checkScopeAccess(scopes, path, input, lookup)
      expect(result.ok, `${path}: ${result.ok ? '' : result.reason}`).toBe(true)
    }
  })
})

describe('intercom stays closed to everything below an operator', () => {
  it('refuses a view-only camera-viewer — watching is not talking', () => {
    for (const name of Object.keys(METHODS)) {
      const { path, input } = callFor(name, GRANTED_CAMERA)
      expect(checkScopeAccess(CAMERA_VIEWER, path, input, lookup).ok, `${path}`).toBe(false)
    }
  })

  it('refuses a camera the grant does not name', () => {
    const scopes = [deviceGrant({ kind: 'ids', ids: [GRANTED_CAMERA] }, ['view', 'create'])]
    for (const name of Object.keys(METHODS)) {
      const { path, input } = callFor(name, OTHER_CAMERA)
      expect(checkScopeAccess(scopes, path, input, lookup).ok, `${path}`).toBe(false)
    }
  })

  it('refuses a principal holding only system-scope grants', () => {
    // `intercom` is `scope: 'device'`; a `category:system` grant must not reach
    // it however broad its access tier.
    const scopes: readonly TokenScope[] = [
      { type: 'category', target: 'system', access: ['view', 'create', 'delete'] },
    ]
    for (const name of Object.keys(METHODS)) {
      const { path, input } = callFor(name, GRANTED_CAMERA)
      expect(checkScopeAccess(scopes, path, input, lookup).ok, `${path}`).toBe(false)
    }
  })

  it('refuses a principal with no scopes at all', () => {
    for (const name of Object.keys(METHODS)) {
      const { path, input } = callFor(name, GRANTED_CAMERA)
      expect(checkScopeAccess([], path, input, lookup).ok, `${path}`).toBe(false)
    }
  })
})
