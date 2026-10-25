import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { customAction, defineCustomActions } from '@camstack/types'
import type { CustomActionCaller } from '@camstack/types'
import { CustomActionRegistry } from '../custom-action-registry.js'

describe('CustomActionRegistry', () => {
  it('registers a system-scoped action and resolves it', () => {
    const reg = new CustomActionRegistry()
    const cat = defineCustomActions({ ping: customAction(z.void(), z.literal('pong')) })
    reg.registerAddon('benchmark', cat, async (action, _input) =>
      action === 'ping' ? ('pong' as const) : (null as never),
    )
    const entry = reg.resolve('benchmark', 'ping')
    expect(entry?.spec.kind).toBe('query')
    expect(entry?.spec.scope).toEqual({ kind: 'system' })
  })

  it('throws when an addon declares a device-scoped action', () => {
    const reg = new CustomActionRegistry()
    const cat = defineCustomActions({
      mute: customAction(z.object({ id: z.string() }), z.void(), {
        kind: 'mutation',
        scope: { kind: 'device' },
      }),
    })
    expect(() => reg.registerAddon('foo', cat, async () => undefined)).toThrow(
      /scope 'device' — not yet implemented/,
    )
  })

  it('returns null for unknown action', () => {
    const reg = new CustomActionRegistry()
    expect(reg.resolve('nope', 'nope')).toBeNull()
  })

  it('unregisters all actions for an addon', () => {
    const reg = new CustomActionRegistry()
    const cat = defineCustomActions({ ping: customAction(z.void(), z.literal('pong')) })
    reg.registerAddon('benchmark', cat, async () => 'pong' as const)
    reg.unregisterAddon('benchmark')
    expect(reg.resolve('benchmark', 'ping')).toBeNull()
  })

  it('records a caller:required action on the spec and forwards the caller', async () => {
    const reg = new CustomActionRegistry()
    const cat = defineCustomActions({
      whoami: customAction(z.object({}), z.object({ userId: z.string() }), {
        kind: 'mutation',
        caller: 'required',
      }),
    })
    let seen: CustomActionCaller | undefined
    reg.registerAddon('nc', cat, async (_action, _input, caller) => {
      seen = caller
      return { userId: caller?.userId ?? 'NONE' }
    })
    const entry = reg.resolve('nc', 'whoami')
    expect(entry?.spec.caller).toBe('required')
    const result = await entry?.handler({}, { userId: 'u1', isAdmin: false })
    expect(result).toEqual({ userId: 'u1' })
    expect(seen).toEqual({ userId: 'u1', isAdmin: false })
  })
})

/**
 * `describeAll` is what a runner puts in its register frame (D444): every
 * hosted addon, schemas stripped, empty catalogs INCLUDED so the hub can say
 * "declares no actions" per addon instead of guessing from an absent key.
 *
 * Disarm: drop the `for (const addonId of hostedAddonIds) out[addonId] = {}`
 * seed — the second test loses `model-studio`.
 */
describe('CustomActionRegistry.describeAll', () => {
  it('strips the schemas and keeps everything the hub gates on', () => {
    const registry = new CustomActionRegistry()
    registry.registerAddon(
      'benchmark',
      {
        run: customAction(z.object({ n: z.number() }), z.object({ ran: z.number() }), {
          kind: 'mutation',
          auth: 'admin',
          caller: 'required',
        }),
      },
      async () => ({ ran: 1 }),
    )
    const described = registry.describeAll(['benchmark'])
    expect(described).toEqual({
      benchmark: {
        run: { kind: 'mutation', auth: 'admin', scope: { kind: 'system' }, caller: 'required' },
      },
    })
    // Nothing that cannot cross MsgPack survives the description.
    expect(JSON.parse(JSON.stringify(described))).toEqual(described)
  })

  it('names a hosted addon with NO actions with an empty catalog — absence is never ambiguous', () => {
    const registry = new CustomActionRegistry()
    registry.registerAddon(
      'benchmark',
      { run: customAction(z.object({}), z.object({})) },
      async () => ({}),
    )
    expect(registry.describeAll(['benchmark', 'model-studio'])).toEqual({
      benchmark: { run: { kind: 'query', auth: 'protected', scope: { kind: 'system' } } },
      'model-studio': {},
    })
  })
})
