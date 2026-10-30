/**
 * The stale-data audit (D905): the three verdicts, the keychain link, and the
 * operator's deletion re-checking its verdict. Ports are faked; the engine and
 * BaseAddon halves have their own specs.
 */
import { makeSecretMarker, type StorageKind } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { declaration } from '../../__tests__/support/records-harness.js'
import {
  type AddonPresence,
  StaleDataAudit,
  StaleDataRefusedError,
  type StaleDataPorts,
} from '../stale-data-audit.js'

function kind(over: Partial<StorageKind> & Pick<StorageKind, 'owner' | 'kind'>): StorageKind {
  const decl = declaration()
  return {
    database: 'settings',
    class: 'ledger',
    state: 'declared',
    declaredThisBoot: false,
    rows: 3,
    bytesEstimate: null,
    writeTrigger: decl.writeTrigger,
    retention: decl.retention,
    entry: false,
    declaration: decl,
    ...over,
  }
}

interface World {
  addons: readonly AddonPresence[] | null
  kinds: StorageKind[]
  stored: Record<string, Record<string, unknown>>
  declared: Record<string, readonly string[] | null>
  marked: string[]
  dropped: string[]
  released: string[]
  unset: string[]
  logs: string[]
}

function world(over: Partial<World> = {}): World {
  return {
    addons: [],
    kinds: [],
    stored: {},
    declared: {},
    marked: [],
    dropped: [],
    released: [],
    unset: [],
    logs: [],
    ...over,
  }
}

function auditOf(w: World): StaleDataAudit {
  const note =
    (level: string) =>
    (message: string, ctx?: { meta?: unknown }): void => {
      w.logs.push(`${level} ${message} ${JSON.stringify(ctx?.meta ?? {})}`)
    }
  const logger: StaleDataPorts['logger'] = {
    debug: note('debug'),
    info: note('info'),
    warn: note('warn'),
    error: note('error'),
    child: () => logger,
    withTags: () => logger,
  }
  const ports: StaleDataPorts = {
    listAddons: async () => w.addons,
    listKinds: async () => w.kinds,
    markOrphaned: async (refs) => {
      w.marked.push(...refs.map((r) => `${r.owner}/${r.kind}`))
    },
    dropKind: async (ref) => {
      w.dropped.push(`${ref.owner}/${ref.kind}`)
      return { deleted: 2, secretRefs: ['secret://x/row/records:k/1/token'] }
    },
    storedSettings: async (id) => w.stored[id] ?? {},
    declaredKeys: async (id) => w.declared[id] ?? null,
    unsetKeys: async (id, keys) => {
      w.unset.push(...keys.map((k) => `${id}/${k}`))
      return { removed: keys, refused: [], secretsCleared: 1 }
    },
    releaseSecrets: async (refs) => {
      w.released.push(...refs)
      return refs.length
    },
    logger,
    now: () => 42,
  }
  return new StaleDataAudit(ports)
}

const RUNNING: readonly AddonPresence[] = [
  { id: 'owner', running: true },
  { id: 'auth-oidc', running: true },
]

describe('stale-data audit: record kinds', () => {
  it('a kind nobody declared, under a running owner that declared another, is orphaned and flagged', async () => {
    const w = world({
      addons: RUNNING,
      kinds: [
        kind({ owner: 'owner', kind: 'live', declaredThisBoot: true }),
        kind({ owner: 'owner', kind: 'old' }),
      ],
    })
    const report = await auditOf(w).scan('manual')
    expect(report.kinds).toEqual([
      expect.objectContaining({
        owner: 'owner',
        kind: 'old',
        verdict: 'orphaned',
        protected: false,
      }),
    ])
    expect(w.marked).toEqual(['owner/old'])
  })

  it('an owner whose package is gone is orphaned', async () => {
    const w = world({ addons: RUNNING, kinds: [kind({ owner: 'removed', kind: 'k' })] })
    const report = await auditOf(w).scan('boot')
    expect(report.kinds[0]).toMatchObject({ owner: 'removed', verdict: 'orphaned' })
  })

  it('an owner installed but not running is unknown and nothing is flagged', async () => {
    const w = world({
      addons: [{ id: 'owner', running: false }],
      kinds: [kind({ owner: 'owner', kind: 'old' })],
    })
    const report = await auditOf(w).scan('manual')
    expect(report.kinds[0]).toMatchObject({ verdict: 'unknown' })
    expect(w.marked).toEqual([])
  })

  it('a running owner that declared nothing since the hub started is unknown, not orphaned', async () => {
    const w = world({ addons: RUNNING, kinds: [kind({ owner: 'owner', kind: 'old' })] })
    const report = await auditOf(w).scan('manual')
    expect(report.kinds[0]).toMatchObject({ verdict: 'unknown' })
    expect(w.marked).toEqual([])
  })

  it('an unreadable addon list makes every owner unknown', async () => {
    const w = world({ addons: null, kinds: [kind({ owner: 'removed', kind: 'k' })] })
    const report = await auditOf(w).scan('manual')
    expect(report.kinds[0]).toMatchObject({ verdict: 'unknown' })
    expect(w.marked).toEqual([])
  })

  it('local-auth is reported but never flagged for a drop', async () => {
    const w = world({ addons: [], kinds: [kind({ owner: 'local-auth', kind: 'users' })] })
    const report = await auditOf(w).scan('manual')
    expect(report.kinds[0]).toMatchObject({ owner: 'local-auth', protected: true })
    expect(w.marked).toEqual([])
  })
})

describe('stale-data audit: settings keys and the keychain link', () => {
  const STALE_REF = 'secret://auth-oidc/global/providers[0].clientSecret'
  const LIVE_REF = 'secret://auth-oidc/global/signingKey'

  function oidcWorld(): World {
    return world({
      addons: RUNNING,
      stored: {
        'auth-oidc': {
          issuer: 'https://example.invalid',
          signingKey: makeSecretMarker(LIVE_REF),
          providers: [{ id: 'a', clientSecret: makeSecretMarker(STALE_REF) }],
        },
      },
      declared: { 'auth-oidc': ['issuer', 'signingKey'] },
    })
  }

  it('a stale key holding a marker is reported with that secret as in use by stale data', async () => {
    const report = await auditOf(oidcWorld()).scan('manual')
    expect(report.settingsKeys).toEqual([
      { addonId: 'auth-oidc', key: 'providers', secretRefs: [STALE_REF] },
    ])
  })

  it('a declared key is never reported, nor a secret a declared key still points at', async () => {
    const w = oidcWorld()
    w.stored['auth-oidc'] = { ...w.stored['auth-oidc'], legacyCopy: makeSecretMarker(LIVE_REF) }
    const report = await auditOf(w).scan('manual')
    const keys = report.settingsKeys.map((k) => k.key).toSorted()
    expect(keys).toEqual(['legacyCopy', 'providers'])
    expect(report.settingsKeys.find((k) => k.key === 'legacyCopy')?.secretRefs).toEqual([])
  })

  it('a per-node copy of a declared key is not stale', async () => {
    const w = world({
      addons: RUNNING,
      stored: { owner: { 'issuer@node-b': 'x' } },
      declared: { owner: ['issuer'] },
    })
    expect((await auditOf(w).scan('manual')).settingsKeys).toEqual([])
  })

  it('an addon that does not answer is unknown, never stale', async () => {
    const w = oidcWorld()
    w.declared = { 'auth-oidc': null }
    const report = await auditOf(w).scan('manual')
    expect(report.settingsKeys).toEqual([])
    expect(report.unknown).toEqual([expect.objectContaining({ subject: 'auth-oidc' })])
  })

  it('an addon that is not running is not asked', async () => {
    const w = oidcWorld()
    w.addons = [{ id: 'auth-oidc', running: false }]
    const report = await auditOf(w).scan('manual')
    expect(report.settingsKeys).toEqual([])
  })

  it('logs owner and key only: a stored value never reaches a log line', async () => {
    const w = oidcWorld()
    w.stored['auth-oidc'] = { providers: [{ clientSecret: 'plaintext-value-9f3' }] }
    w.declared = { 'auth-oidc': [] }
    await auditOf(w).scan('manual')
    const text = w.logs.join('\n')
    expect(text).toContain('providers')
    expect(text).not.toContain('plaintext-value-9f3')
  })
})

describe('stale-data audit: operator deletion re-checks the verdict', () => {
  function orphanWorld(): World {
    return world({
      addons: RUNNING,
      kinds: [
        kind({ owner: 'owner', kind: 'live', declaredThisBoot: true }),
        kind({ owner: 'owner', kind: 'old' }),
      ],
    })
  }

  it('drops an orphaned kind, releases its secrets and logs the operator', async () => {
    const w = orphanWorld()
    const audit = auditOf(w)
    await audit.scan('manual')
    const out = await audit.dropOrphanedKind({ owner: 'owner', kind: 'old' }, 'user-7')
    expect(out).toEqual({ deleted: 2, secretsReleased: 1 })
    expect(w.dropped).toEqual(['owner/old'])
    expect(w.released).toEqual(['secret://x/row/records:k/1/token'])
    expect(w.logs.some((l) => l.includes('record kind dropped') && l.includes('user-7'))).toBe(true)
    expect(audit.current().kinds).toEqual([])
  })

  it('refuses when the owner declared the kind in the meantime', async () => {
    const w = orphanWorld()
    const audit = auditOf(w)
    await audit.scan('manual')
    w.kinds = w.kinds.map((k) => (k.kind === 'old' ? { ...k, declaredThisBoot: true } : k))
    await expect(
      audit.dropOrphanedKind({ owner: 'owner', kind: 'old' }, 'u'),
    ).rejects.toBeInstanceOf(StaleDataRefusedError)
    expect(w.dropped).toEqual([])
  })

  it('refuses when the owner stopped running (unknown is never dropped)', async () => {
    const w = orphanWorld()
    const audit = auditOf(w)
    await audit.scan('manual')
    w.addons = [{ id: 'owner', running: false }]
    await expect(
      audit.dropOrphanedKind({ owner: 'owner', kind: 'old' }, 'u'),
    ).rejects.toBeInstanceOf(StaleDataRefusedError)
    expect(w.dropped).toEqual([])
  })

  it('never drops a local-auth kind, even a legacy-looking one', async () => {
    const w = world({ addons: [], kinds: [kind({ owner: 'local-auth', kind: 'old' })] })
    const audit = auditOf(w)
    await audit.scan('manual')
    await expect(
      audit.dropOrphanedKind({ owner: 'local-auth', kind: 'old' }, 'u'),
    ).rejects.toBeInstanceOf(StaleDataRefusedError)
    expect(w.dropped).toEqual([])
  })

  it('unsets a stale key, and refuses one the addon declares since', async () => {
    const w = world({
      addons: RUNNING,
      stored: { 'auth-oidc': { providers: [], issuer: 'x' } },
      declared: { 'auth-oidc': ['issuer'] },
    })
    const audit = auditOf(w)
    await audit.scan('manual')
    const out = await audit.unsetStaleSettingsKey('auth-oidc', 'providers', 'user-7')
    expect(out).toEqual({ removed: true, secretsCleared: 1 })
    expect(w.unset).toEqual(['auth-oidc/providers'])

    w.declared = { 'auth-oidc': ['issuer', 'providers'] }
    await expect(
      audit.unsetStaleSettingsKey('auth-oidc', 'providers', 'user-7'),
    ).rejects.toBeInstanceOf(StaleDataRefusedError)
    expect(w.unset).toEqual(['auth-oidc/providers'])
  })

  it('refuses to unset a key of an addon that is not running', async () => {
    const w = world({
      addons: [{ id: 'auth-oidc', running: false }],
      stored: { 'auth-oidc': { providers: [] } },
      declared: { 'auth-oidc': [] },
    })
    await expect(
      auditOf(w).unsetStaleSettingsKey('auth-oidc', 'providers', 'u'),
    ).rejects.toBeInstanceOf(StaleDataRefusedError)
    expect(w.unset).toEqual([])
  })
})
