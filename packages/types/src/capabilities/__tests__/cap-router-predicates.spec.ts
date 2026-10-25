import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  extractNestedAddonId,
  isCollectionArrayMethod,
  objectInputDeclaresAddonId,
  resolveMethodAuth,
} from '../cap-router-predicates.js'
import { type CapabilityDefinition, method } from '../capability-definition.js'
import { notificationOutputCapability } from '../notification-output.cap.js'

/**
 * `isCollectionArrayMethod` is the single predicate that lets the child-side
 * cap dispatcher reproduce the hub's `concatCollection` graceful skip: a
 * COLLECTION cap's array-returning method that a provider doesn't implement
 * degrades to `[]` instead of "method not found".
 */
describe('isCollectionArrayMethod', () => {
  it('is true for a real collection cap array method (notification-output.listTargets)', () => {
    expect(notificationOutputCapability.mode).toBe('collection')
    expect(isCollectionArrayMethod(notificationOutputCapability, 'listTargets')).toBe(true)
    expect(isCollectionArrayMethod(notificationOutputCapability, 'listTargetKinds')).toBe(true)
    expect(isCollectionArrayMethod(notificationOutputCapability, 'discoverTargets')).toBe(true)
  })

  it('is false for a collection cap NON-array method (notification-output.send / upsertTarget)', () => {
    // `send` returns a SendResult object, `upsertTarget` a Target object — a
    // missing one of those is a genuine bug, not a graceful-empty candidate.
    expect(isCollectionArrayMethod(notificationOutputCapability, 'send')).toBe(false)
    expect(isCollectionArrayMethod(notificationOutputCapability, 'upsertTarget')).toBe(false)
  })

  it('is false for an unknown method name', () => {
    expect(isCollectionArrayMethod(notificationOutputCapability, 'noSuchMethod')).toBe(false)
  })

  it('is false for a SINGLETON cap even when the method returns an array', () => {
    const singletonWithArray = {
      name: 'fake-singleton',
      scope: 'system',
      mode: 'singleton',
      methods: {
        listThings: method(z.object({}), z.array(z.string())),
      },
    } as const satisfies CapabilityDefinition
    expect(isCollectionArrayMethod(singletonWithArray, 'listThings')).toBe(false)
  })

  it('is false for an undefined cap definition', () => {
    expect(isCollectionArrayMethod(undefined, 'listTargets')).toBe(false)
  })

  it('unwraps optional/nullable array outputs on a collection cap', () => {
    const collectionOptionalArray = {
      name: 'fake-collection',
      scope: 'system',
      mode: 'collection',
      methods: {
        listMaybe: method(z.object({}), z.array(z.string()).optional()),
        scalar: method(z.object({}), z.string()),
      },
    } as const satisfies CapabilityDefinition
    expect(isCollectionArrayMethod(collectionOptionalArray, 'listMaybe')).toBe(true)
    expect(isCollectionArrayMethod(collectionOptionalArray, 'scalar')).toBe(false)
  })
})

/**
 * `extractNestedAddonId` recovers the owning `addonId` a single-object
 * collection mutation already carries in its payload (`upsertTarget({ target:
 * { addonId } })`) when the caller omits the top-level `{ addonId }` selector.
 */
describe('extractNestedAddonId', () => {
  it('recovers a nested addonId from a domain entity (upsertTarget payload)', () => {
    const input = {
      target: { id: 't1', kind: 'webhook', addonId: 'notifiers', config: {} },
    }
    expect(extractNestedAddonId(input)).toBe('notifiers')
  })

  it('returns undefined for an id-only payload (deleteTarget)', () => {
    expect(extractNestedAddonId({ targetId: 't1' })).toBeUndefined()
  })

  it('returns undefined for a non-object / null input', () => {
    expect(extractNestedAddonId(undefined)).toBeUndefined()
    expect(extractNestedAddonId(null)).toBeUndefined()
    expect(extractNestedAddonId('nope')).toBeUndefined()
  })

  it('ignores a non-string nested addonId', () => {
    expect(extractNestedAddonId({ target: { addonId: 42 } })).toBeUndefined()
  })

  it('matches the notification-output Target shape used by the runtime router', () => {
    const target = {
      id: 'wh_1',
      name: 'My Webhook',
      kind: 'webhook',
      addonId: 'provider-homeassistant',
      enabled: true,
      config: {},
    }
    expect(extractNestedAddonId({ target })).toBe('provider-homeassistant')
  })
})

/**
 * `objectInputDeclaresAddonId` gates nested recovery: a method whose input
 * declares a TOP-LEVEL `addonId` selector routes via that field and must never
 * fall back to a nested scan (which could hijack routing off an incidental
 * `addonId` inside a free-form record like `llm.generate`'s `jsonSchema`).
 */
describe('objectInputDeclaresAddonId', () => {
  it('is true when the object schema declares a top-level addonId (llm.generate posture)', () => {
    const schema = z.object({ addonId: z.string().optional(), consumer: z.string() })
    expect(objectInputDeclaresAddonId(schema)).toBe(true)
  })

  it('is false for upsertTarget-style input (addonId only nested in target)', () => {
    expect(
      objectInputDeclaresAddonId(notificationOutputCapability.methods.upsertTarget.input),
    ).toBe(false)
  })

  it('is true for a schema extended from a base that declares addonId', () => {
    const base = z.object({ addonId: z.string().optional(), prompt: z.string() })
    const extended = base.extend({ images: z.array(z.string()) })
    expect(objectInputDeclaresAddonId(extended)).toBe(true)
  })

  it('is false for a non-object schema', () => {
    expect(objectInputDeclaresAddonId(z.string())).toBe(false)
    expect(objectInputDeclaresAddonId(undefined)).toBe(false)
  })
})

/**
 * `resolveMethodAuth` — Task 7.5c floor. `internal: true` on a cap def is a
 * declaration that its methods are for in-process (`ctx.api`) consumption
 * only, but `resolveCapMount` never read the field, so an `internal` cap
 * still got a full tRPC router — and a method with no EXPLICIT `auth`
 * defaulted to `'protected'`, reachable by any authenticated session. That
 * silent default is how `ssoBridge.signBridgeToken` became a privilege
 * escalation (caller-supplied `isAdmin` claims, redeemable at
 * `/api/auth/sso/finish`).
 *
 * The floor: an `internal` cap's un-annotated method resolves to `'admin'`
 * instead of `'protected'`. An EXPLICIT `auth` — of ANY value, including one
 * that already agrees with the floor — always wins; the author said what
 * they meant. A non-`internal` cap is untouched.
 */
describe('resolveMethodAuth', () => {
  it('floors an internal cap method with no explicit auth to admin', () => {
    expect(resolveMethodAuth({ internal: true }, {})).toBe('admin')
    expect(resolveMethodAuth({ internal: true }, { auth: undefined })).toBe('admin')
  })

  it('keeps an internal cap method EXPLICIT auth, whatever it is', () => {
    expect(resolveMethodAuth({ internal: true }, { auth: 'public' })).toBe('public')
    expect(resolveMethodAuth({ internal: true }, { auth: 'protected' })).toBe('protected')
    expect(resolveMethodAuth({ internal: true }, { auth: 'admin' })).toBe('admin')
  })

  it('leaves a non-internal cap method at the protected default', () => {
    expect(resolveMethodAuth({ internal: false }, {})).toBe('protected')
    expect(resolveMethodAuth({}, {})).toBe('protected')
  })

  it('keeps a non-internal cap method EXPLICIT auth', () => {
    expect(resolveMethodAuth({ internal: false }, { auth: 'public' })).toBe('public')
    expect(resolveMethodAuth({}, { auth: 'admin' })).toBe('admin')
  })

  it('real internal cap def: an unannotated method floors to admin', () => {
    const fakeInternal = {
      name: 'fake-internal',
      scope: 'system',
      mode: 'singleton',
      internal: true,
      methods: {
        // No explicit `auth` — the exact shape of the pre-fix defect.
        leaky: method(z.void(), z.void()),
        // Explicit — author's choice always wins.
        deliberatelyPublic: method(z.void(), z.void(), { auth: 'public' }),
      },
    } as const satisfies CapabilityDefinition
    expect(resolveMethodAuth(fakeInternal, fakeInternal.methods.leaky)).toBe('admin')
    expect(resolveMethodAuth(fakeInternal, fakeInternal.methods.deliberatelyPublic)).toBe('public')
  })
})
