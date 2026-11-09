/**
 * Every adapter declares where its secrets GO.
 *
 * `mergeSecrets` puts a stored secret back behind the redaction marker only when the kind AND
 * every destination field the adapter declares (`destinationKeys`) are unchanged (the probe of an
 * edited form is its one caller now). An adapter that declared no destination, or a field that does
 * not exist, would restore a secret to anywhere, so the declarations are pinned here against the
 * REAL adapters.
 */
import type { ConfigField } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { NotifierAdapter } from '../adapters/adapter.js'
import { NOTIFIER_ADAPTERS } from '../adapters/registry.js'
import { createNotificationOutputProvider, type HttpSender } from '../provider.js'
import { TargetStore } from '../target-store.js'
import { makeNotifiersRecords } from './fake-records.js'

/** A top-level schema field by key. */
function fieldOf(adapter: NotifierAdapter, key: string): ConfigField | undefined {
  for (const section of adapter.descriptor.configSchema.sections) {
    for (const field of section.fields) {
      if ('key' in field && field.key === key) return field
    }
  }
  return undefined
}

interface SentPlan {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

async function makeProvider() {
  const sent: SentPlan[] = []
  const httpSend: HttpSender = async (plan) => {
    sent.push({
      url: plan.url,
      headers: plan.headers ?? {},
      body: JSON.stringify(plan.body ?? null),
    })
    return { ok: true, status: 200, statusText: 'OK', text: async () => '' }
  }
  const store = TargetStore.of((await makeNotifiersRecords()).records)
  const provider = createNotificationOutputProvider({
    store,
    adapters: NOTIFIER_ADAPTERS,
    httpSend,
  })
  return { provider, store, sent }
}

/**
 * Fields that LOOK like an address but route no secret, per kind, each with
 * the reason. Adding a line here is a claim a reviewer must be able to check.
 */
const NOT_A_DESTINATION: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  discord: { avatarUrl: 'an image URL Discord fetches for display; the hub sends nothing there' },
}

/** A non-secret field whose name or input type says it addresses something. */
const ADDRESS_KEY = /url|host|server|endpoint|instance|chat|bucket|recipient|user(s|ids)/i

describe('every adapter declares where its secrets GO — fail closed', () => {
  it('declares at least one destination (an empty list would restore to anywhere)', () => {
    for (const adapter of NOTIFIER_ADAPTERS) {
      expect(adapter.destinationKeys.length, `${adapter.descriptor.kind}`).toBeGreaterThan(0)
    }
  })

  it('names only fields its schema really has', () => {
    for (const adapter of NOTIFIER_ADAPTERS) {
      for (const key of adapter.destinationKeys) {
        expect(
          fieldOf(adapter, key),
          `${adapter.descriptor.kind}.${key} is not a schema field`,
        ).toBeDefined()
      }
    }
  })

  it('declares every address-shaped field, or exempts it with a reason', () => {
    for (const adapter of NOTIFIER_ADAPTERS) {
      const kind = adapter.descriptor.kind
      const exempt = NOT_A_DESTINATION[kind] ?? {}
      for (const section of adapter.descriptor.configSchema.sections) {
        for (const field of section.fields) {
          if (!('key' in field) || field.type === 'password' || field.type === 'info') continue
          const looksLikeAddress =
            ADDRESS_KEY.test(field.key) || ('inputType' in field && field.inputType === 'url')
          if (!looksLikeAddress || field.key in exempt) continue
          expect(
            adapter.destinationKeys.includes(field.key),
            `${kind}.${field.key} looks like an address but is not in destinationKeys`,
          ).toBe(true)
        }
      }
    }
  })
})

describe('each kind PUBLISHES its destinations, so an editor can say which edit needs the secret', () => {
  it('listTargetKinds carries `destinationKeys` for every notifier kind', async () => {
    const { provider } = await makeProvider()
    const kinds = await provider.listTargetKinds({})
    for (const adapter of NOTIFIER_ADAPTERS) {
      const published = kinds.find((k) => k.kind === adapter.descriptor.kind)
      expect(published?.destinationKeys, adapter.descriptor.kind).toEqual([
        ...adapter.destinationKeys,
      ])
    }
  })
})
