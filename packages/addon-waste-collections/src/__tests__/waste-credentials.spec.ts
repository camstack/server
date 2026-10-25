/**
 * D880 - a waste source's credential arguments (password, api_key, token,
 * authorization) live in the keychain; the source row holds typed `args` with a
 * marker, and no read surface shows the value. Every value below is fabricated.
 */
import {
  buildSecretRef,
  isSecretMarker,
  REDACTED_SECRET,
  type AddonContext,
  type KeychainResolveResult,
  type SecretScope,
  type SecretsAccess,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import catalogJson from '../catalog.json'
import { findCatalogService, serviceFormSchema } from '../waste-catalog.js'
import { WasteCollectionsAddon } from '../waste-collections.addon.js'
import {
  isSecretArg,
  REVIEWED_NON_SECRET_ARG_KEYS,
  SECRET_ARG_KEYS,
  WASTE_SECRET_STATE_PATHS,
} from '../waste-secrets.js'
import { sourceArgs } from '../waste-types.js'

const PASSWORD = 'fake-waste-pass-0001'
const CANARY_BROKEN = 'fake-broken-json-canary-0009'
const NEXT_PASSWORD = 'fake-waste-pass-0002'
const SERVICE_ID = 'recyclesmart_com--recyclesmart'

interface World {
  store: Record<string, unknown>
  kc: Map<string, string>
  locked: boolean
  /** The keychain answers a different value than the one stored. */
  lying: boolean
  /** Settings writes fail from the Nth on (1 = every write); 0 = never. */
  failWritesFrom: number
  writes: number
}

/**
 * An UNCACHED keychain handle: the real one serves a value it just put from its
 * cache, which would hide a keychain that did not keep it. Refs are built by the
 * production `buildSecretRef`.
 */
function secretsFor(w: World): SecretsAccess {
  const owner = 'waste-collections'
  return {
    owner,
    ref: (scope: SecretScope, fieldPath: string) => buildSecretRef({ owner, scope, fieldPath }),
    resolve: async (refs) => {
      const out: KeychainResolveResult = {}
      for (const ref of refs) {
        const value = w.kc.get(ref)
        out[ref] = w.locked
          ? { kind: 'unavailable', reason: 'key-missing' }
          : value === undefined
            ? { kind: 'missing' }
            : { kind: 'value', value: w.lying ? `${value}-x` : value, version: 1 }
      }
      return out
    },
    put: async (ref, value) => {
      if (w.locked) throw new Error('keychain locked')
      w.kc.set(ref, value)
      return 1
    },
    delete: async (refs) => {
      let deleted = 0
      for (const ref of refs) if (w.kc.delete(ref)) deleted += 1
      return deleted
    },
    state: async () => (w.locked ? { state: 'locked', reason: 'key-missing' } : { state: 'ready' }),
    onChange: () => () => undefined,
    forOwner: null,
  }
}

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
}

function contextFor(w: World): AddonContext {
  const eventBus = { emit: () => undefined, subscribe: () => () => undefined, getRecent: () => [] }
  const settings = {
    readAddonStore: async () => structuredClone(w.store),
    readAddonStoreResult: async () => ({ kind: 'value', value: structuredClone(w.store) }),
    writeAddonStore: async (patch: Record<string, unknown>) => {
      w.writes += 1
      if (w.failWritesFrom > 0 && w.writes >= w.failWritesFrom) throw new Error('store down')
      w.store = { ...w.store, ...structuredClone(patch) }
    },
    readDeviceStore: async () => ({}),
    writeDeviceStore: async () => undefined,
  }
  return {
    id: 'waste-collections',
    logger: noopLogger,
    eventBus,
    settings,
    dataDir: '/nonexistent',
    kernel: { localNodeId: 'hub' },
    secrets: secretsFor(w),
  } as unknown as AddonContext
}

/** The addon minus Python and the refresh timer: only the settings/keychain contract. */
class BareWasteAddon extends WasteCollectionsAddon {
  protected override async onInitialize() {
    return { providers: [] }
  }
}

async function boot(w: World): Promise<BareWasteAddon> {
  const addon = new BareWasteAddon()
  await addon.initialize(contextFor(w))
  return addon
}

const world = (): World => ({
  store: {},
  kc: new Map(),
  locked: false,
  lying: false,
  failWritesFrom: 0,
  writes: 0,
})

const LEGACY_ROW = {
  id: 'home',
  label: 'Home',
  module: 'recyclesmart_com',
  argsJson: JSON.stringify({ email: 'u', password: PASSWORD }),
  enabled: true,
}

describe('the catalog and the credential list', () => {
  it('every credential-looking argument of every service is listed secret or reviewed as not', () => {
    const looksLikeCredential =
      /pass|pwd|secret|token|api_?key|auth|cred|bearer|cookie|(^|_)key$|(^|_)pin$/i
    const unknown = new Set<string>()
    for (const service of catalogJson.services) {
      for (const field of service.fields) {
        if (!looksLikeCredential.test(field.key)) continue
        if (SECRET_ARG_KEYS.includes(field.key)) continue
        if (field.key in REVIEWED_NON_SECRET_ARG_KEYS) continue
        unknown.add(field.key)
      }
    }
    expect([...unknown]).toEqual([])
  })

  it('matching is case-insensitive, and no catalog key escapes by its case', () => {
    expect(isSecretArg('PIN')).toBe(true)
    expect(isSecretArg('Account_Pin')).toBe(true)
    const escaped = new Set<string>()
    for (const service of catalogJson.services) {
      for (const field of service.fields) {
        if (isSecretArg(field.key) && !SECRET_ARG_KEYS.includes(field.key)) escaped.add(field.key)
      }
    }
    expect([...escaped]).toEqual([])
  })

  it('a credential argument renders as a password field', () => {
    const service = findCatalogService(SERVICE_ID)
    expect(service).toBeDefined()
    const fields = serviceFormSchema(service!).sections.flatMap((s) => s.fields)
    expect(fields.find((f) => 'key' in f && f.key === 'password')).toMatchObject({
      type: 'password',
    })
  })

  it('the state paths cover exactly the listed keys', () => {
    expect(WASTE_SECRET_STATE_PATHS).toEqual(SECRET_ARG_KEYS.map((k) => `sources[id].args.${k}`))
  })
})

describe('a source credential is keychain-backed', () => {
  it('createSource stores a marker, the keychain holds the value, the fetch reads it', async () => {
    const w = world()
    const addon = await boot(w)
    await addon.createSource({
      label: 'Home',
      serviceId: SERVICE_ID,
      args: { email: 'u', password: PASSWORD },
    })
    expect(JSON.stringify(w.store)).not.toContain(PASSWORD)
    const sources = w.store['sources'] as { args: Record<string, unknown> }[]
    expect(isSecretMarker(sources[0]?.args['password'])).toBe(true)
    expect([...w.kc.values()]).toEqual([PASSWORD])
    const [source] = addon.configuredSources()
    expect(sourceArgs(source!)['password']).toBe(PASSWORD)
  })

  it('listSources never shows the value - the redaction token stands in', async () => {
    const w = world()
    const addon = await boot(w)
    await addon.createSource({
      label: 'Home',
      serviceId: SERVICE_ID,
      args: { email: 'u', password: PASSWORD },
    })
    const listed = addon.listSources()
    expect(JSON.stringify(listed)).not.toContain(PASSWORD)
    expect(listed[0]?.formValues['password']).toBe(REDACTED_SECRET)
    expect(listed[0]?.formValues['email']).toBe('u')
  })

  it('updateSource keeps the credential on the redaction token and replaces it on a new value', async () => {
    const w = world()
    const addon = await boot(w)
    const { id } = await addon.createSource({
      label: 'Home',
      serviceId: SERVICE_ID,
      args: { email: 'u', password: PASSWORD },
    })
    await addon.updateSource({
      id,
      label: 'Home 2',
      serviceId: SERVICE_ID,
      args: { email: 'u2', password: REDACTED_SECRET },
    })
    expect(sourceArgs(addon.configuredSources()[0]!)).toMatchObject({
      email: 'u2',
      password: PASSWORD,
    })
    await addon.updateSource({
      id,
      label: 'Home 2',
      serviceId: SERVICE_ID,
      args: { email: 'u2', password: NEXT_PASSWORD },
    })
    // The marker (same ref) is unchanged; the keychain's change event re-resolves the config.
    expect([...w.kc.values()]).toEqual([NEXT_PASSWORD])
    expect(JSON.stringify(w.store)).not.toContain(NEXT_PASSWORD)
  })

  it('a locked keychain refuses the save and stores nothing', async () => {
    const w = world()
    const addon = await boot(w)
    w.locked = true
    await expect(
      addon.createSource({
        label: 'Home',
        serviceId: SERVICE_ID,
        args: { email: 'u', password: PASSWORD },
      }),
    ).rejects.toThrow()
    expect(JSON.stringify(w.store)).not.toContain(PASSWORD)
  })

  it('a nested object is refused as an argument value', async () => {
    const addon = await boot(world())
    await expect(
      addon.createSource({ label: 'Home', serviceId: SERVICE_ID, args: { email: { a: 1 } } }),
    ).rejects.toThrow()
  })
})

describe('migrateSources', () => {
  function legacyWorld(): World {
    const w = world()
    w.store = { sources: [LEGACY_ROW] }
    return w
  }

  it('a dry run changes nothing and counts', async () => {
    const w = legacyWorld()
    const addon = await boot(w)
    const report = await addon.migrateSources(false)
    expect(report).toMatchObject({ rows: 1, raw: 1, migrated: 0, redundantCopies: 1 })
    expect(report.verified).toBe(false)
    expect(JSON.stringify(w.store)).toContain(PASSWORD)
    expect(w.kc.size).toBe(0)
  })

  it('apply types the row, moves the credential, and leaves no raw copy', async () => {
    const w = legacyWorld()
    const addon = await boot(w)
    const report = await addon.migrateSources(true)
    expect(report).toMatchObject({ migrated: 1, failed: 0, remainingRaw: 0, verified: true })
    expect(JSON.stringify(w.store)).not.toContain(PASSWORD)
    expect(JSON.stringify(w.store)).not.toContain('argsJson')
    expect(sourceArgs(addon.configuredSources()[0]!)).toMatchObject({
      email: 'u',
      password: PASSWORD,
    })
  })

  it('is idempotent', async () => {
    const w = legacyWorld()
    const addon = await boot(w)
    await addon.migrateSources(true)
    const again = await addon.migrateSources(true)
    expect(again).toMatchObject({ raw: 0, migrated: 0, markers: 1, verified: true })
  })

  it('a keychain that does not return what it stored rolls the legacy row back', async () => {
    const w = legacyWorld()
    const addon = await boot(w)
    w.lying = true
    const report = await addon.migrateSources(true)
    expect(report).toMatchObject({ migrated: 0, failed: 1, verified: false })
    expect(JSON.stringify(w.store)).toContain(PASSWORD)
    w.lying = false
    // The rollback deletes the refs the migration created: none are orphaned.
    expect(w.kc.size).toBe(0)
    expect(sourceArgs(addon.configuredSources()[0]!)['password']).toBe(PASSWORD)
  })

  it('a rollback that itself fails does not throw, still reports failed', async () => {
    const w = legacyWorld()
    const addon = await boot(w)
    w.lying = true
    w.failWritesFrom = 2
    const report = await addon.migrateSources(true)
    expect(report).toMatchObject({ migrated: 0, failed: 1, verified: false })
  })

  it('a malformed legacy JSON never leaks its text, and does not stop the other rows', async () => {
    const w = legacyWorld()
    const broken = {
      id: 'broken',
      label: 'Broken',
      module: 'recyclesmart_com',
      argsJson: `{"password":"${CANARY_BROKEN}"`,
      enabled: true,
    }
    w.store = { sources: [broken, LEGACY_ROW] }
    const addon = await boot(w)
    const report = await addon.migrateSources(true)
    expect(report).toMatchObject({ migrated: 1, failed: 1, verified: false })
    expect(JSON.stringify(report)).not.toContain(CANARY_BROKEN)
    const stored = JSON.stringify(w.store)
    expect(stored).toContain(CANARY_BROKEN) // the row is left exactly as it was
    expect(JSON.stringify(addon.listSources())).not.toContain(CANARY_BROKEN)
    const [first] = addon.configuredSources()
    let message = ''
    try {
      sourceArgs(first!)
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('not valid JSON')
    expect(message).not.toContain(CANARY_BROKEN)
  })

  it('a locked keychain leaves the legacy row untouched', async () => {
    const w = legacyWorld()
    const addon = await boot(w)
    w.locked = true
    const report = await addon.migrateSources(true)
    expect(report).toMatchObject({ migrated: 0, failed: 1, verified: false })
    expect(JSON.stringify(w.store)).toContain(PASSWORD)
  })

  it('the report holds counts only', async () => {
    const w = legacyWorld()
    const addon = await boot(w)
    const text = JSON.stringify(await addon.migrateSources(true))
    expect(text).not.toContain(PASSWORD)
    expect(text).not.toContain('home')
  })
})
