/**
 * A field hidden by `showWhen` is never READ by the adapter's `buildRequest`.
 *
 * `destinations.ts` compares a hidden destination field as absent — editing
 * WhatsApp's `apiUrl` while `apiHostMode` is `universal` is not a move, so a
 * redacted secret is still restored. That is safe only while the adapter
 * really ignores a hidden field; if a future `buildRequest` read one, the
 * secret would follow an edit the guard called a no-op (review round 1, Low).
 *
 * Pinned here: for every adapter that uses `showWhen`, for every valid
 * configuration in which a field is hidden, setting that field to an attacker
 * value leaves the request byte-for-byte unchanged. An adapter that starts
 * using `showWhen` without a fixture here fails the first test.
 */
import { type ConfigField, type Notification, prepareNotification } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { NotifierAdapter } from '../adapters/adapter.js'
import { NOTIFIER_ADAPTERS } from '../adapters/registry.js'
import { fieldInUse } from '../destinations.js'

/** Valid, sendable configurations per kind — one per branch of its `showWhen`s. */
const VALID_CONFIGS: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>> = {
  whatsapp: [
    // Default universal host — `apiUrl` is hidden.
    {
      apiHostMode: 'universal',
      idInstance: '7103000001',
      apiTokenInstance: 'tok',
      chatId: '39333000000',
      acknowledgeToS: true,
    },
    // Custom host — `apiUrl` is in use.
    {
      apiHostMode: 'custom',
      apiUrl: 'https://7103.api.greenapi.com',
      idInstance: '7103000001',
      apiTokenInstance: 'tok',
      chatId: '39333000000',
      acknowledgeToS: true,
    },
    // Legacy row without apiHostMode — defaults to universal; apiUrl is hidden.
    {
      apiUrl: 'https://7103.api.greenapi.com',
      idInstance: '7103000001',
      apiTokenInstance: 'tok',
      chatId: '39333000000',
      acknowledgeToS: true,
    },
  ],
  zentik: [
    {
      baseUrl: 'https://notifier-api.zentik.app',
      authMode: 'accessToken',
      accessToken: 'tok',
      bucketId: 'home',
    },
    { baseUrl: 'https://notifier-api.zentik.app', authMode: 'magicCode', magicCode: 'magic' },
  ],
}

const NOTIFICATION: Notification = { body: 'ping', title: 'CamStack', format: 'text', priority: 3 }

function conditionalFields(adapter: NotifierAdapter): readonly ConfigField[] {
  return adapter.descriptor.configSchema.sections.flatMap((s) =>
    s.fields.filter((f) => 'showWhen' in f && f.showWhen !== undefined),
  )
}

function requestOf(adapter: NotifierAdapter, config: Readonly<Record<string, unknown>>): string {
  const prepared = prepareNotification(adapter.descriptor.caps, NOTIFICATION)
  if (adapter.buildRequest === undefined) {
    throw new Error(`${adapter.descriptor.kind}: expected HTTP buildRequest`)
  }
  return JSON.stringify(adapter.buildRequest(config, prepared))
}

describe('hidden fields are never read by buildRequest', () => {
  it('every adapter with a `showWhen` field has fixtures here', () => {
    for (const adapter of NOTIFIER_ADAPTERS) {
      if (conditionalFields(adapter).length === 0) continue
      expect(
        VALID_CONFIGS[adapter.descriptor.kind],
        `${adapter.descriptor.kind} uses showWhen but has no fixture`,
      ).toBeDefined()
    }
  })

  for (const adapter of NOTIFIER_ADAPTERS) {
    const fixtures = VALID_CONFIGS[adapter.descriptor.kind]
    if (fixtures === undefined) continue
    for (const field of conditionalFields(adapter)) {
      if (!('key' in field)) continue
      it(`${adapter.descriptor.kind}: '${field.key}' changes nothing while hidden`, () => {
        let exercised = 0
        for (const base of fixtures) {
          if (fieldInUse(adapter.descriptor, base, field.key)) continue
          exercised += 1
          const withHidden = { ...base, [field.key]: 'https://attacker.example/hidden' }
          expect(requestOf(adapter, withHidden), `${JSON.stringify(base)}`).toBe(
            requestOf(adapter, base),
          )
        }
        expect(exercised, 'no fixture hides this field — add one').toBeGreaterThan(0)
      })
    }
  }
})
