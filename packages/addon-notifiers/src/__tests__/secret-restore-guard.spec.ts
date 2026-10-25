/**
 * A stored secret is put back ONLY where it was already going.
 *
 * The exfiltration (security review 2026-09-25): `upsertTarget` with an
 * existing target id, the password fields left as `__redacted__`, and ONE
 * non-secret field changed — ntfy/gotify `serverUrl`, zentik `baseUrl`, a
 * WhatsApp `apiUrl`, a webhook `url`. `mergeSecrets` restored the stored token
 * into the edited row, and the next `testTarget` delivered it to the new host.
 * The same thing happened across a KIND swap on one id (pushover → gotify both
 * call their secret `appToken`).
 *
 * The rule pinned here, per adapter family, against the REAL adapters: the
 * marker restores a stored secret only when the kind AND every destination
 * field the adapter declares (`destinationKeys`) are unchanged. Anything else
 * is refused with an error that names the fields and never the secret.
 */
import type { ConfigField, ConfigUISchema, Target } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { NotifierAdapter } from '../adapters/adapter.js'
import { NOTIFIER_ADAPTERS } from '../adapters/registry.js'
import { createNotificationOutputProvider, type HttpSender } from '../provider.js'
import { REDACTED_MARKER } from '../secrets.js'
import { makeNotifiersRecords } from './fake-records.js'
import { TargetStore } from '../target-store.js'

const SECRET_PREFIX = 'S3CRET-'

/** Every top-level `password` key of a schema (the array rows are handled apart). */
function topLevelSecretKeys(schema: ConfigUISchema): readonly string[] {
  const keys: string[] = []
  for (const section of schema.sections) {
    for (const field of section.fields) {
      if (field.type === 'password') keys.push(field.key)
    }
  }
  return keys
}

/** The `editable-array` fields whose rows carry a password (webhook headers). */
function secretArrayFields(schema: ConfigUISchema): readonly ConfigField[] {
  const out: ConfigField[] = []
  for (const section of schema.sections) {
    for (const field of section.fields) {
      if (field.type !== 'editable-array') continue
      if (field.itemFields.some((item) => item.type === 'password')) out.push(field)
    }
  }
  return out
}

/** A top-level schema field by key. */
function fieldOf(adapter: NotifierAdapter, key: string): ConfigField | undefined {
  for (const section of adapter.descriptor.configSchema.sections) {
    for (const field of section.fields) {
      if ('key' in field && field.key === key) return field
    }
  }
  return undefined
}

/** A select's option values; empty for any other field. */
function optionValues(field: ConfigField | undefined): readonly string[] {
  if (field === undefined || field.type !== 'select') return []
  return field.options.map((o) => String(o.value))
}

/** The "home" value of a destination: a select's first option, else a URL. */
function homeValue(adapter: NotifierAdapter, key: string): string {
  return optionValues(fieldOf(adapter, key))[0] ?? `https://home.example/${key}`
}

/** A DIFFERENT destination: a select's second option, else an attacker URL. */
function attackerValue(adapter: NotifierAdapter, key: string): string {
  return optionValues(fieldOf(adapter, key))[1] ?? `https://attacker.example/${key}`
}

/**
 * A stored config: every secret set, every destination at its "home" value,
 * and — when `focus` is shown only under a condition (a WhatsApp backend) —
 * the controlling field set so that `focus` is the one in USE.
 */
function storedConfig(adapter: NotifierAdapter, focus?: string): Record<string, unknown> {
  const schema = adapter.descriptor.configSchema
  const config: Record<string, unknown> = {}
  for (const key of topLevelSecretKeys(schema)) config[key] = `${SECRET_PREFIX}${key}`
  for (const field of secretArrayFields(schema)) {
    if (field.type !== 'editable-array') continue
    config[field.key] = [{ name: 'Authorization', value: `${SECRET_PREFIX}header` }]
  }
  // A destination that is ITSELF a secret (the webhook `url`) is written last,
  // so it is a recognisable home address rather than a secret-shaped value.
  for (const key of adapter.destinationKeys) config[key] = homeValue(adapter, key)
  const focusField = focus !== undefined ? fieldOf(adapter, focus) : undefined
  const condition =
    focusField !== undefined && 'showWhen' in focusField ? focusField.showWhen : undefined
  if (condition !== undefined) {
    const shown = condition.equals ?? condition.in?.[0]
    if (shown !== undefined) config[condition.field] = shown
  }
  return config
}

/** The same config as the editor sends it back: every secret as the marker. */
function editedConfig(
  adapter: NotifierAdapter,
  overrides: Readonly<Record<string, unknown>>,
  focus?: string,
): Record<string, unknown> {
  const schema = adapter.descriptor.configSchema
  const config: Record<string, unknown> = { ...storedConfig(adapter, focus) }
  for (const key of topLevelSecretKeys(schema)) config[key] = REDACTED_MARKER
  for (const field of secretArrayFields(schema)) {
    if (field.type !== 'editable-array') continue
    config[field.key] = [{ name: 'Authorization', value: REDACTED_MARKER }]
  }
  return { ...config, ...overrides }
}

/** True when changing `key` still leaves some OTHER stored secret to restore. */
function anotherSecretRides(adapter: NotifierAdapter, key: string): boolean {
  const schema = adapter.descriptor.configSchema
  const others = topLevelSecretKeys(schema).filter((k) => k !== key)
  return others.length > 0 || secretArrayFields(schema).length > 0
}

function targetOf(adapter: NotifierAdapter, config: Record<string, unknown>): Target {
  return {
    id: 'victim',
    name: 'Household',
    kind: adapter.descriptor.kind,
    addonId: 'notifiers',
    enabled: true,
    config,
  }
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

/** Every secret value the stored row holds — what must never move. */
function storedSecrets(adapter: NotifierAdapter): readonly string[] {
  return JSON.stringify(storedConfig(adapter)).match(/S3CRET-[a-zA-Z]+/g) ?? []
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

describe('the marker restores a secret only to the destination it already had', () => {
  for (const adapter of NOTIFIER_ADAPTERS) {
    const kind = adapter.descriptor.kind

    it(`${kind}: an edit that keeps every destination keeps the stored secrets`, async () => {
      const { provider, store } = await makeProvider()
      await provider.upsertTarget({ target: targetOf(adapter, storedConfig(adapter)) })
      await provider.upsertTarget({ target: targetOf(adapter, editedConfig(adapter, {})) })
      const stored = await store.getById('victim')
      expect(stored?.config).toEqual(storedConfig(adapter))
    })

    for (const key of adapter.destinationKeys) {
      // Re-typing the ONLY secret (the Discord webhook URL) restores nothing,
      // so there is nothing for the guard to refuse there.
      if (!anotherSecretRides(adapter, key)) continue

      it(`${kind}: changing '${key}' with the secrets left redacted is REFUSED`, async () => {
        const { provider, store, sent } = await makeProvider()
        const stored = storedConfig(adapter, key)
        await provider.upsertTarget({ target: targetOf(adapter, stored) })

        const attack = editedConfig(adapter, { [key]: attackerValue(adapter, key) }, key)
        const refusal = await provider
          .upsertTarget({ target: targetOf(adapter, attack) })
          .then(() => null)
          .catch((err: unknown) => (err instanceof Error ? err.message : String(err)))

        expect(refusal, `${kind}.${key}: the stored secret followed the new destination`).not.toBe(
          null,
        )
        expect(refusal).toMatch(/re-enter/i)
        expect(refusal).toContain(key)
        for (const secret of storedSecrets(adapter)) expect(refusal).not.toContain(secret)

        // The row did not move, so a test send still goes home.
        expect((await store.getById('victim'))?.config[key]).toBe(stored[key])
        await provider.testTarget({ targetId: 'victim' })
        for (const plan of sent) expect(plan.url).not.toContain('attacker.example')
      })

      it(`${kind}: changing '${key}' with every secret RE-TYPED is accepted`, async () => {
        const { provider, store } = await makeProvider()
        await provider.upsertTarget({ target: targetOf(adapter, storedConfig(adapter, key)) })
        const retyped = { ...storedConfig(adapter, key), [key]: attackerValue(adapter, key) }
        await provider.upsertTarget({ target: targetOf(adapter, retyped) })
        expect((await store.getById('victim'))?.config[key]).toBe(attackerValue(adapter, key))
      })
    }
  }
})

describe('a kind swap on one id never inherits the previous kind’s secret', () => {
  it('pushover → gotify (both call it `appToken`) is refused while the token is redacted', async () => {
    const pushover = NOTIFIER_ADAPTERS.find((a) => a.descriptor.kind === 'pushover')
    const gotify = NOTIFIER_ADAPTERS.find((a) => a.descriptor.kind === 'gotify')
    if (!pushover || !gotify) throw new Error('fixture: pushover/gotify adapter missing')

    const { provider, store, sent } = await makeProvider()
    await provider.upsertTarget({ target: targetOf(pushover, storedConfig(pushover)) })

    const swapped: Target = {
      ...targetOf(gotify, {}),
      config: {
        serverUrl: 'https://attacker.example',
        appToken: REDACTED_MARKER,
      },
    }
    await expect(provider.upsertTarget({ target: swapped })).rejects.toThrow(/re-enter/i)
    expect((await store.getById('victim'))?.kind).toBe('pushover')
    expect(sent).toHaveLength(0)
  })

  it('is refused on the kind alone, even when no destination field differs', async () => {
    // Isolates the kind gate: neither row has a `serverUrl`, so the
    // destination comparison sees nothing changed.
    const pushover = NOTIFIER_ADAPTERS.find((a) => a.descriptor.kind === 'pushover')
    const gotify = NOTIFIER_ADAPTERS.find((a) => a.descriptor.kind === 'gotify')
    if (!pushover || !gotify) throw new Error('fixture: pushover/gotify adapter missing')

    const { provider, store } = await makeProvider()
    await provider.upsertTarget({ target: targetOf(pushover, storedConfig(pushover)) })
    const swapped: Target = { ...targetOf(gotify, {}), config: { appToken: REDACTED_MARKER } }
    await expect(provider.upsertTarget({ target: swapped })).rejects.toThrow(
      /kind changed from 'pushover' to 'gotify'/,
    )
    expect((await store.getById('victim'))?.kind).toBe('pushover')
  })

  it('a swap that RE-TYPES the secret is an ordinary new configuration', async () => {
    const pushover = NOTIFIER_ADAPTERS.find((a) => a.descriptor.kind === 'pushover')
    const gotify = NOTIFIER_ADAPTERS.find((a) => a.descriptor.kind === 'gotify')
    if (!pushover || !gotify) throw new Error('fixture: pushover/gotify adapter missing')

    const { provider, store } = await makeProvider()
    await provider.upsertTarget({ target: targetOf(pushover, storedConfig(pushover)) })
    await provider.upsertTarget({
      target: { ...targetOf(gotify, {}), config: { serverUrl: 'https://g', appToken: 'new' } },
    })
    const stored = await store.getById('victim')
    expect(stored?.kind).toBe('gotify')
    expect(stored?.config['appToken']).toBe('new')
  })
})

describe('the webhook URL is a secret', () => {
  it('is redacted on read — a Home Assistant webhook id in the path is a credential', async () => {
    const webhook = NOTIFIER_ADAPTERS.find((a) => a.descriptor.kind === 'webhook')
    if (!webhook) throw new Error('fixture: webhook adapter missing')
    const { provider } = await makeProvider()
    await provider.upsertTarget({
      target: targetOf(webhook, { url: 'https://ha.example/api/webhook/SECRET-ID' }),
    })
    const [row] = await provider.listTargets({})
    expect(row?.config['url']).toBe(REDACTED_MARKER)
    expect(JSON.stringify(row)).not.toContain('SECRET-ID')
  })

  it('an editor that leaves it untouched keeps it, headers included', async () => {
    const webhook = NOTIFIER_ADAPTERS.find((a) => a.descriptor.kind === 'webhook')
    if (!webhook) throw new Error('fixture: webhook adapter missing')
    const { provider, store, sent } = await makeProvider()
    const stored = {
      url: 'https://ha.example/api/webhook/SECRET-ID',
      headers: [{ name: 'Authorization', value: 'Bearer SECRET-HDR' }],
    }
    await provider.upsertTarget({ target: targetOf(webhook, stored) })
    // The admin editor OMITS an untouched secret; the viewer sends the marker.
    await provider.upsertTarget({
      target: targetOf(webhook, {
        method: 'PUT',
        headers: [{ name: 'Authorization', value: REDACTED_MARKER }],
      }),
    })
    expect((await store.getById('victim'))?.config).toEqual({ ...stored, method: 'PUT' })
    await provider.testTarget({ targetId: 'victim' })
    expect(sent[0]?.url).toBe('https://ha.example/api/webhook/SECRET-ID')
  })
})

/**
 * An edit that changes NOTHING must save (review M2). The comparison is of
 * the destination the adapter would USE: an absent value is its schema
 * default, a field hidden for the stored backend routes nothing, and a
 * zentik `userIds` is the same list whether it arrives as `'a, b'` or `['a','b']`.
 * These are the shapes the two editors really send: the viewer serializer
 * fills every schema field (hidden ones included) with its default; the admin
 * form sends what the row held plus the fields it renders.
 */
describe('an unchanged destination is recognised however it is spelled', () => {
  function adapterOf(kind: string): NotifierAdapter {
    const found = NOTIFIER_ADAPTERS.find((a) => a.descriptor.kind === kind)
    if (!found) throw new Error(`fixture: ${kind} adapter missing`)
    return found
  }

  it('whatsapp: a legacy row without apiHostMode round-trips with a redacted token', async () => {
    const whatsapp = adapterOf('whatsapp')
    const { provider, store } = await makeProvider()
    const legacy = {
      apiUrl: 'https://7103.api.greenapi.com',
      idInstance: '7103000001',
      apiTokenInstance: 'S3CRET-green',
      chatId: '39333000000',
      acknowledgeToS: true,
    }
    await provider.upsertTarget({ target: targetOf(whatsapp, legacy) })
    // Same effective destination (universal): leftover apiUrl stays hidden.
    await provider.upsertTarget({
      target: targetOf(whatsapp, {
        ...legacy,
        apiTokenInstance: REDACTED_MARKER,
      }),
    })
    expect((await store.getById('victim'))?.config['apiTokenInstance']).toBe('S3CRET-green')
  })

  it('whatsapp: a field HIDDEN for the stored backend routes nothing, so editing it is not a move', async () => {
    const whatsapp = adapterOf('whatsapp')
    const { provider, store } = await makeProvider()
    const stored = {
      apiHostMode: 'universal',
      idInstance: '7103000001',
      apiTokenInstance: 'S3CRET-green',
      chatId: '39333000000',
    }
    await provider.upsertTarget({ target: targetOf(whatsapp, stored) })
    // A custom apiUrl while still on universal is hidden — not a move.
    await provider.upsertTarget({
      target: targetOf(whatsapp, {
        ...stored,
        apiTokenInstance: REDACTED_MARKER,
        apiUrl: 'https://anything.example',
      }),
    })
    expect((await store.getById('victim'))?.config['apiTokenInstance']).toBe('S3CRET-green')
    // Switching host mode (and thus the resolved destination) is a move.
    await expect(
      provider.upsertTarget({
        target: targetOf(whatsapp, {
          ...stored,
          apiTokenInstance: REDACTED_MARKER,
          apiHostMode: '7105',
        }),
      }),
    ).rejects.toThrow(/re-enter/i)
  })

  it('zentik: `userIds` stored as a list and sent back as the text the field shows', async () => {
    const zentik = adapterOf('zentik')
    const { provider, store } = await makeProvider()
    const stored = {
      baseUrl: 'https://notifier-api.zentik.app',
      accessToken: 'S3CRET-zentik',
      bucketId: 'home',
      userIds: ['alice', 'bob'],
    }
    await provider.upsertTarget({ target: targetOf(zentik, stored) })
    await provider.upsertTarget({
      target: targetOf(zentik, { ...stored, accessToken: REDACTED_MARKER, userIds: 'alice, bob' }),
    })
    expect((await store.getById('victim'))?.config['accessToken']).toBe('S3CRET-zentik')
    // A different recipient list is still a move.
    await expect(
      provider.upsertTarget({
        target: targetOf(zentik, {
          ...stored,
          accessToken: REDACTED_MARKER,
          userIds: 'alice, mallory',
        }),
      }),
    ).rejects.toThrow(/userIds/)
  })

  it('ntfy: an absent `serverUrl` and the default typed out are the same server', async () => {
    const ntfy = adapterOf('ntfy')
    const serverField = fieldOf(ntfy, 'serverUrl')
    const fallback =
      serverField !== undefined && 'default' in serverField ? serverField.default : undefined
    if (typeof fallback !== 'string') return // no declared default: nothing to equate
    const { provider, store } = await makeProvider()
    await provider.upsertTarget({ target: targetOf(ntfy, { topic: 'S3CRET-topic' }) })
    await provider.upsertTarget({
      target: targetOf(ntfy, { topic: REDACTED_MARKER, serverUrl: fallback }),
    })
    expect((await store.getById('victim'))?.config['topic']).toBe('S3CRET-topic')
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
