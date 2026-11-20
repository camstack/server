/**
 * `{ addonId }` pin of a collection cap's ARRAY method on the child→parent path.
 *
 * The tRPC mount answers `addonId` set → that addon's provider only; the forked
 * child path answered the union of every provider, so the Home Assistant export
 * saw every integration's `account` instance and took another one for its broker.
 * `onUnownedCall` runs the aggregate first, then the pin: both are driven here.
 */
import { describe, expect, it } from 'vitest'
import { aggregateCollectionCall, pinnedCollectionCall } from '../cap-router-runtime.js'

type Provider = Record<string, (input?: unknown) => unknown>
type Registry = NonNullable<Parameters<typeof pinnedCollectionCall>[0]>

const CAP = 'integration-instances'
const HA: Provider = { listInstances: () => [{ id: 'ha-1', kind: 'account' }] }
const OTHER: Provider = { listInstances: () => [{ id: 'other-1', kind: 'account' }] }
const PROVIDERS: Readonly<Record<string, Provider>> = {
  'provider-other': OTHER,
  'provider-homeassistant': HA,
}

// Structural fake of the registry; the documented seam of the sibling spec.
const reg: Registry = {
  getDefinition: () => ({ mode: 'collection' }),
  getProviderByAddonId: (_cap: string, addonId: string) => PROVIDERS[addonId] ?? null,
  getProviderAddonIds: () => Object.keys(PROVIDERS),
  getCollectionEntries: () => Object.entries(PROVIDERS),
} as unknown as Registry

describe('addon pin of a collection ARRAY method (child to parent)', () => {
  it('answers ONLY the named addon, and the union does not claim the call', async () => {
    const args = { addonId: 'provider-homeassistant' }
    expect(await aggregateCollectionCall(reg, CAP, 'listInstances', args)).toBeNull()
    expect(await pinnedCollectionCall(reg, CAP, 'listInstances', args)).toEqual({
      value: [{ id: 'ha-1', kind: 'account' }],
    })
  })

  it('keeps the union without an addonId', async () => {
    expect(await aggregateCollectionCall(reg, CAP, 'listInstances', {})).toEqual([
      { id: 'other-1', kind: 'account' },
      { id: 'ha-1', kind: 'account' },
    ])
  })

  it('refuses an unknown addon with the valid ids', async () => {
    await expect(
      pinnedCollectionCall(reg, CAP, 'listInstances', { addonId: 'provider-nope' }),
    ).rejects.toThrow(/no provider with addonId "provider-nope".*provider-other/)
  })
})

/**
 * A provider that is a CLASS INSTANCE keeps its `this` on this path: the
 * `action-source` provider reads `this.deps`, and a detached call threw
 * "Cannot read properties of undefined (reading 'deps')".
 */
class ClassActionSource {
  constructor(private readonly deps: { readonly id: string }) {}
  async listActions(): Promise<readonly { readonly id: string }[]> {
    return [{ id: this.deps.id }]
  }
}

describe('class-instance provider on the collection array path', () => {
  const source = new ClassActionSource({ id: 'core-blocks:fan-1' })
  const classReg: Registry = {
    getDefinition: () => ({ mode: 'collection' }),
    getProviderByAddonId: () => source,
    getProviderAddonIds: () => ['core-blocks'],
    getCollectionEntries: () => [['core-blocks', source]],
  } as unknown as Registry

  it('the union keeps `this`', async () => {
    expect(await aggregateCollectionCall(classReg, 'action-source', 'listActions', {})).toEqual([
      { id: 'core-blocks:fan-1' },
    ])
  })

  it('a pinned call keeps `this`', async () => {
    expect(
      await pinnedCollectionCall(classReg, 'action-source', 'listActions', {
        addonId: 'core-blocks',
      }),
    ).toEqual({ value: [{ id: 'core-blocks:fan-1' }] })
  })
})
