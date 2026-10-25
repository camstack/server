/**
 * Runs the per-device settings contract (`device-settings-contract.ts`) on real
 * SQLite against hub-main's view AND a runner's view of the same file — and
 * proves it can fail: each disarm breaks the wiring the contract guards and
 * the matching check must go red.
 */
import type { ISettingsStoreProvider } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONTRACT,
  type ContractHarness,
  type ContractName,
  realHarness,
} from './device-settings-contract.js'

const open: ContractHarness[] = []
afterEach(async () => {
  for (const h of open.splice(0)) await h.close()
})

async function harness(
  wrap?: (d: ISettingsStoreProvider) => ISettingsStoreProvider,
  wrapRunner?: (d: ISettingsStoreProvider) => ISettingsStoreProvider,
): Promise<ContractHarness> {
  const h = await realHarness('recorder', wrap, wrapRunner)
  open.push(h)
  return h
}

const REAL = 'addon-device-settings'
const ELSEWHERE = 'device-settings'
const REAL_ADDON = 'addon-settings'
const ELSEWHERE_ADDON = 'provider-settings'

describe('per-device settings contract (real SQLite, both views)', () => {
  for (const name of Object.keys(CONTRACT) as ContractName[]) {
    it(name, async () => {
      await CONTRACT[name](await harness())
    })
  }
})

describe('the contract goes red when the wiring it guards is broken', () => {
  it('a runner pointed at another collection fails the cross-view checks', async () => {
    const elsewhere = (door: ISettingsStoreProvider): ISettingsStoreProvider => ({
      ...door,
      query: (input) =>
        door.query({
          ...input,
          collection: input.collection === REAL ? ELSEWHERE : input.collection,
        }),
      transact: (input) =>
        door.transact({
          ...input,
          ops: input.ops.map((op) =>
            op.collection === REAL ? { ...op, collection: ELSEWHERE } : op,
          ),
        }),
      deleteWhere: (input) =>
        door.deleteWhere({
          ...input,
          collection: input.collection === REAL ? ELSEWHERE : input.collection,
        }),
    })
    const h = await harness(undefined, elsewhere)
    await expect(CONTRACT.writeInOneViewReadsFromTheOther(h)).rejects.toThrow()
  })

  it('a runner pointed at another addon-settings table fails the cross-view check', async () => {
    const elsewhere = (door: ISettingsStoreProvider): ISettingsStoreProvider => ({
      ...door,
      get: (input) =>
        door.get({
          ...input,
          collection: input.collection === REAL_ADDON ? ELSEWHERE_ADDON : input.collection,
        }),
      query: (input) =>
        door.query({
          ...input,
          collection: input.collection === REAL_ADDON ? ELSEWHERE_ADDON : input.collection,
        }),
      transact: (input) =>
        door.transact({
          ...input,
          ops: input.ops.map((op) =>
            op.collection === REAL_ADDON ? { ...op, collection: ELSEWHERE_ADDON } : op,
          ),
        }),
    })
    const h = await harness(undefined, elsewhere)
    await expect(CONTRACT.addonSettingsWriteInOneViewReadsFromTheOther(h)).rejects.toThrow()
  })

  it('a merge split into separate statements fails the atomicity check', async () => {
    const split = (door: ISettingsStoreProvider): ISettingsStoreProvider => ({
      ...door,
      transact: async (input) => {
        for (const op of input.ops) await door.transact({ ...input, ops: [op] })
        return { applied: true }
      },
    })
    const h = await harness(split, split)
    await expect(CONTRACT.mergeIsOneTransaction(h)).rejects.toThrow()
    const h2 = await harness(split, split)
    await expect(CONTRACT.addonSettingsMergeIsOneTransaction(h2)).rejects.toThrow()
  })
})
