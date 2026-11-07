/**
 * The addon's hidden state — the snapshot signing key and the legacy link ledgers — lives under the
 * store keys every earlier build used (`snapshotSigningKey`, `linkedAccounts`, `tokens`), written
 * through `state()` instead of `updateGlobalSettings`. A value an old build stored is read as it was;
 * a write lands under the same key. (That a `state()` over a `secretStatePaths` key is stored through
 * the keychain is pinned in `@camstack/types` `base-addon-keychain.spec.ts`.)
 */
import { fakeAddonContext } from '@camstack/types/testing'
import { describe, expect, it } from 'vitest'
import { ExportAlexaAddon } from '../export-alexa.addon.js'
import type { LegacyLedgerPort } from '../skill-runtime.js'

class StoreAddon extends ExportAlexaAddon {
  protected override async onInitialize(): ReturnType<ExportAlexaAddon['onInitialize']> {
    return { providers: [] }
  }
  ledger(): LegacyLedgerPort {
    return this.legacyLedgerPort()
  }
  ensureKey(): Promise<void> {
    return this.ensureSnapshotSigningKey()
  }
  signingKey(): string {
    return this.config.snapshotSigningKey
  }
}

async function boot(store: Record<string, unknown>): Promise<StoreAddon> {
  const addon = new StoreAddon()
  await addon.initialize(
    fakeAddonContext({
      id: 'export-alexa',
      settings: {
        readAddonStore: async () => ({ ...store }),
        writeAddonStore: async (patch) => {
          Object.assign(store, patch)
        },
      },
    }),
  )
  return addon
}

const OLD_TOKEN = {
  userId: 'amzn1.account.OLD',
  accessToken: 'at-old',
  expiresAt: 2_000_000_000_000,
  receivedAt: 1_000_000_000_000,
}
const OLD_ACCOUNT = { userId: 'amzn1.account.OLD', username: 'old@example.com', linkedAt: 1 }

describe('signing key', () => {
  it('keeps a key an old build stored, writing nothing', async () => {
    const store: Record<string, unknown> = { snapshotSigningKey: 'old-key' }
    const addon = await boot(store)
    await addon.ensureKey()
    expect(addon.signingKey()).toBe('old-key')
    expect(store).toEqual({ snapshotSigningKey: 'old-key' })
  })

  it('mints one under the same key when none is stored, and reads it back', async () => {
    const store: Record<string, unknown> = {}
    const addon = await boot(store)
    await addon.ensureKey()
    expect(Object.keys(store)).toEqual(['snapshotSigningKey'])
    expect(typeof store['snapshotSigningKey']).toBe('string')
    expect(addon.signingKey()).toBe(store['snapshotSigningKey'])
    expect(addon.signingKey()).not.toBe('')
  })
})

describe('legacy link ledger', () => {
  it('reads what an old build stored and writes a new token under the same key', async () => {
    const store: Record<string, unknown> = {
      linkedAccounts: [OLD_ACCOUNT],
      tokens: [OLD_TOKEN],
    }
    const addon = await boot(store)
    const ledger = addon.ledger()
    expect(ledger.read()).toEqual({ linkedAccounts: [OLD_ACCOUNT], tokens: [OLD_TOKEN] })

    const fresh = { ...OLD_TOKEN, userId: 'amzn1.account.NEW', accessToken: 'at-new' }
    await ledger.write({ tokens: [OLD_TOKEN, fresh] })
    expect(store['tokens']).toEqual([OLD_TOKEN, fresh])
    expect(store['linkedAccounts']).toEqual([OLD_ACCOUNT])
    // the ledger is read back from the refreshed config
    expect(ledger.read().tokens).toEqual([OLD_TOKEN, fresh])
  })
})
