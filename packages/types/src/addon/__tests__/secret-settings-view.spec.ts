import { afterEach, describe, expect, it } from 'vitest'
import type { KeychainResolveResult, KeychainState } from '../../capabilities/keychain.cap.js'
import type { ConfigUISchema } from '../../interfaces/config-ui.js'
import { clearKnownSecrets } from '../../keychain/known-secrets.js'
import { makeSecretMarker, SECRET_CLEAR, toSecretFieldView } from '../../keychain/secret-marker.js'
import {
  createSecretsAccess,
  type KeychainTransport,
  type SecretsAccess,
} from '../../keychain/secrets-access.js'
import { mergeSecretStatePaths, secretTreeFromSchema } from '../secret-paths.js'
import {
  KeychainWriteRefusedError,
  resolveSecretMarkers,
  transformSecretWrite,
} from '../secret-settings-view.js'

interface Kc {
  values: Map<string, { value: string; version: number }>
  locked: boolean
  puts: number
}

function transport(kc: Kc): KeychainTransport {
  return {
    async put({ ref, value }) {
      if (kc.locked) throw new Error('locked')
      kc.puts++
      const version = (kc.values.get(ref)?.version ?? 0) + 1
      kc.values.set(ref, { value, version })
      return { ref, version }
    },
    async resolve({ refs }) {
      const out: KeychainResolveResult = {}
      for (const ref of refs) {
        if (kc.locked) {
          out[ref] = { kind: 'unavailable', reason: 'wrong-key' }
          continue
        }
        const v = kc.values.get(ref)
        out[ref] = v ? { kind: 'value', value: v.value, version: v.version } : { kind: 'missing' }
      }
      return out
    },
    async delete({ refs }) {
      let deleted = 0
      for (const r of refs) if (kc.values.delete(r)) deleted++
      return { deleted }
    },
    async getState(): Promise<KeychainState> {
      return kc.locked ? { state: 'locked', reason: 'wrong-key' } : { state: 'ready' }
    },
  }
}

const SCHEMA: ConfigUISchema = {
  sections: [
    {
      id: 'main',
      title: 'Main',
      fields: [
        { type: 'text', key: 'host', label: 'Host' },
        { type: 'password', key: 'apiToken', label: 'API token' },
        { type: 'textarea', key: 'privateKey', label: 'Key', secret: true },
        { type: 'password', key: 'maskedButPublic', label: 'Masked', storage: 'inline' },
        {
          type: 'group',
          key: 'g',
          label: 'G',
          fields: [{ type: 'password', key: 'nested', label: 'Nested' }],
        },
        {
          type: 'editable-array',
          key: 'providers',
          label: 'Providers',
          itemFields: [
            { type: 'text', key: 'id', label: 'Id' },
            { type: 'password', key: 'clientSecret', label: 'Secret' },
          ],
        },
      ],
    },
  ],
}

function setup(kc: Kc = { values: new Map(), locked: false, puts: 0 }): {
  kc: Kc
  secrets: SecretsAccess
  tree: ReturnType<typeof secretTreeFromSchema>
} {
  const secrets = createSecretsAccess({ owner: 'auth-oidc', transport: transport(kc) })
  const tree = mergeSecretStatePaths(secretTreeFromSchema(SCHEMA), [
    'identity.pincode',
    'tokens[userId].accessToken',
  ])
  return { kc, secrets, tree }
}

const ref = (fieldPath: string): string => `secret://auth-oidc/global/${fieldPath}`

describe('secret paths come from the field TYPE, never the key name', () => {
  it('selects password and secret:true fields, honours storage:inline, walks groups and arrays', () => {
    const tree = secretTreeFromSchema(SCHEMA)
    expect([...tree.keys()].sort()).toEqual(['apiToken', 'nested', 'privateKey', 'providers'])
    expect(tree.get('providers')).toMatchObject({ kind: 'array', idKey: 'id' })
  })

  it('ignores a credential-looking NAME on a plain text field', () => {
    const tree = secretTreeFromSchema({
      sections: [{ id: 's', title: 's', fields: [{ type: 'text', key: 'password', label: 'p' }] }],
    })
    expect(tree.size).toBe(0)
  })
})

describe('save path: strip → keychain → marker', () => {
  afterEach(() => clearKnownSecrets())

  it('a typed value is put, and the blob gets a marker — never the value', async () => {
    const { kc, secrets, tree } = setup()
    const out = await transformSecretWrite({
      tree,
      secrets,
      patch: { host: 'h', apiToken: 'tok-123456' },
      stored: {},
    })
    expect(out.patch).toEqual({ host: 'h', apiToken: makeSecretMarker(ref('apiToken')) })
    expect(kc.values.get(ref('apiToken'))?.value).toBe('tok-123456')
    expect(JSON.stringify(out.patch)).not.toContain('tok-123456')
  })

  it("'' never clears: the stored marker stays and nothing is deleted", async () => {
    const { kc, secrets, tree } = setup()
    kc.values.set(ref('apiToken'), { value: 'tok-123456', version: 1 })
    const stored = { apiToken: makeSecretMarker(ref('apiToken')) }
    const out = await transformSecretWrite({ tree, secrets, patch: { apiToken: '' }, stored })
    expect(out.patch).toEqual({})
    await out.afterWrite()
    expect(kc.values.has(ref('apiToken'))).toBe(true)
  })

  it('the untouched UI view round-trips as KEEP', async () => {
    const { kc, secrets, tree } = setup()
    const stored = { apiToken: makeSecretMarker(ref('apiToken')) }
    const out = await transformSecretWrite({
      tree,
      secrets,
      patch: { apiToken: toSecretFieldView(stored.apiToken) },
      stored,
    })
    expect(out.patch).toEqual({})
    expect(kc.puts).toBe(0)
  })

  it('only the explicit Clear deletes — after the blob write', async () => {
    const { kc, secrets, tree } = setup()
    kc.values.set(ref('apiToken'), { value: 'tok-123456', version: 1 })
    const out = await transformSecretWrite({
      tree,
      secrets,
      patch: { apiToken: SECRET_CLEAR },
      stored: { apiToken: makeSecretMarker(ref('apiToken')) },
    })
    expect(out.patch).toEqual({ apiToken: null })
    expect(kc.values.has(ref('apiToken'))).toBe(true)
    await out.afterWrite()
    expect(kc.values.has(ref('apiToken'))).toBe(false)
  })

  it('re-sending the resolved value (a whole-config write-back) keeps the marker, no new version', async () => {
    const { kc, secrets, tree } = setup()
    await secrets.put(ref('apiToken'), 'tok-123456')
    const out = await transformSecretWrite({
      tree,
      secrets,
      patch: { apiToken: 'tok-123456' },
      stored: { apiToken: makeSecretMarker(ref('apiToken')) },
    })
    expect(out.patch).toEqual({ apiToken: makeSecretMarker(ref('apiToken')) })
    expect(kc.values.get(ref('apiToken'))?.version).toBe(1)
  })

  it('a marker pointing at someone else is never adopted', async () => {
    const { secrets, tree } = setup()
    const out = await transformSecretWrite({
      tree,
      secrets,
      patch: { apiToken: makeSecretMarker('secret://cloudflare-tunnel/global/customApiToken') },
      stored: {},
    })
    expect(out.patch).toEqual({})
  })

  it('a perNode key is scoped to its node', async () => {
    const { kc, secrets, tree } = setup()
    const out = await transformSecretWrite({
      tree,
      secrets,
      patch: { 'apiToken@hub': 'tok-node-1' },
      stored: {},
    })
    expect(out.patch).toEqual({
      'apiToken@hub': makeSecretMarker('secret://auth-oidc/node/hub/apiToken'),
    })
    expect(kc.values.has('secret://auth-oidc/node/hub/apiToken')).toBe(true)
  })

  it('hidden state paths (secretStatePaths) are kept like form fields — nested objects', async () => {
    const { kc, secrets, tree } = setup()
    const out = await transformSecretWrite({
      tree,
      secrets,
      patch: { identity: { name: 'Bridge', pincode: '123-45-678' } },
      stored: {},
    })
    expect(out.patch).toEqual({
      identity: { name: 'Bridge', pincode: makeSecretMarker(ref('identity.pincode')) },
    })
    expect(kc.values.get(ref('identity.pincode'))?.value).toBe('123-45-678')
  })

  it('a keychain that is locked REFUSES the write — plaintext never lands in the blob (strict)', async () => {
    const { secrets, tree } = setup({ values: new Map(), locked: true, puts: 0 })
    await expect(
      transformSecretWrite({ tree, secrets, patch: { apiToken: 'tok-123456' }, stored: {} }),
    ).rejects.toBeInstanceOf(KeychainWriteRefusedError)
  })
})

describe('arrays are addressed by item id', () => {
  afterEach(() => clearKnownSecrets())

  it('a reorder keeps every ref', async () => {
    const { kc, secrets, tree } = setup()
    const first = await transformSecretWrite({
      tree,
      secrets,
      patch: {
        providers: [
          { id: 'google', clientSecret: 'g-secret-1' },
          { id: 'authentik', clientSecret: 'a-secret-1' },
        ],
      },
      stored: {},
    })
    const stored = first.patch
    const putsBefore = kc.puts
    const views = (stored['providers'] as Array<Record<string, unknown>>).map((row) => ({
      ...row,
      clientSecret: toSecretFieldView(row['clientSecret']),
    }))
    const second = await transformSecretWrite({
      tree,
      secrets,
      patch: { providers: [views[1], views[0]] },
      stored,
    })
    expect(second.patch['providers']).toEqual([
      { id: 'authentik', clientSecret: makeSecretMarker(ref('providers[authentik].clientSecret')) },
      { id: 'google', clientSecret: makeSecretMarker(ref('providers[google].clientSecret')) },
    ])
    expect(kc.puts).toBe(putsBefore)
    await second.afterWrite()
    expect(kc.values.size).toBe(2)
  })

  it('a removed row has its refs deleted after the write; a duplicated row is "not set"', async () => {
    const { kc, secrets, tree } = setup()
    const first = await transformSecretWrite({
      tree,
      secrets,
      patch: { providers: [{ id: 'google', clientSecret: 'g-secret-1' }] },
      stored: {},
    })
    const marker = (first.patch['providers'] as Array<Record<string, unknown>>)[0]?.['clientSecret']
    const second = await transformSecretWrite({
      tree,
      secrets,
      // Google removed; a copy of its row under a new id carries google's marker.
      patch: { providers: [{ id: 'copy', clientSecret: toSecretFieldView(marker) }] },
      stored: first.patch,
    })
    expect(second.patch['providers']).toEqual([{ id: 'copy' }])
    expect(kc.values.has(ref('providers[google].clientSecret'))).toBe(true)
    await second.afterWrite()
    expect(kc.values.has(ref('providers[google].clientSecret'))).toBe(false)
  })

  it('a row with no id gets one minted, so its secret has a stable ref', async () => {
    const { secrets, tree } = setup()
    const out = await transformSecretWrite({
      tree,
      secrets,
      patch: { providers: [{ clientSecret: 'x-secret-1' }] },
      stored: {},
    })
    const row = (out.patch['providers'] as Array<Record<string, unknown>>)[0]
    expect(typeof row?.['id']).toBe('string')
    expect(row?.['clientSecret']).toEqual(
      makeSecretMarker(ref(`providers[${String(row?.['id'])}].clientSecret`)),
    )
  })

  it('hidden arrays keyed by a named id field (tokens[userId].accessToken)', async () => {
    const { secrets, tree } = setup()
    const out = await transformSecretWrite({
      tree,
      secrets,
      patch: { tokens: [{ userId: 'u1', accessToken: 'at-123456789', expiresAt: 1 }] },
      stored: {},
    })
    expect(out.patch['tokens']).toEqual([
      { userId: 'u1', accessToken: makeSecretMarker(ref('tokens[u1].accessToken')), expiresAt: 1 },
    ])
  })
})

describe('read path: markers resolve before the runtime sees the config', () => {
  afterEach(() => clearKnownSecrets())

  it('substitutes values at any depth; a keychain-only change is seen on the next resolve', async () => {
    const { kc, secrets } = setup()
    kc.values.set(ref('apiToken'), { value: 'v1-long-value', version: 1 })
    kc.values.set(ref('providers[g].clientSecret'), { value: 'cs-long-value', version: 1 })
    const blob = {
      apiToken: makeSecretMarker(ref('apiToken')),
      providers: [{ id: 'g', clientSecret: makeSecretMarker(ref('providers[g].clientSecret')) }],
    }
    const first = await resolveSecretMarkers(blob, secrets)
    expect(first.value).toEqual({
      apiToken: 'v1-long-value',
      providers: [{ id: 'g', clientSecret: 'cs-long-value' }],
    })
    expect(first.unresolved).toEqual([])
  })

  it('an unavailable value is reported, never replaced by an empty string', async () => {
    const { kc, secrets } = setup({ values: new Map(), locked: true, puts: 0 })
    kc.values.set(ref('apiToken'), { value: 'v1', version: 1 })
    const out = await resolveSecretMarkers({ apiToken: makeSecretMarker(ref('apiToken')) }, secrets)
    expect(out.value).toEqual({})
    expect(out.unresolved).toEqual([{ ref: ref('apiToken'), reason: 'wrong-key' }])
  })

  it('a blob with no marker costs no keychain call', async () => {
    let calls = 0
    const counting: KeychainTransport = {
      ...transport({ values: new Map(), locked: false, puts: 0 }),
      resolve: async () => {
        calls++
        return {}
      },
    }
    const secrets = createSecretsAccess({ owner: 'x', transport: counting })
    const blob = { a: 1, b: 'plain' }
    const out = await resolveSecretMarkers(blob, secrets)
    expect(out.value).toBe(blob)
    expect(calls).toBe(0)
  })
})

describe('no silent migration', () => {
  afterEach(() => clearKnownSecrets())

  it('the same plaintext a pre-keychain blob holds is written back as-is — it stays inline', async () => {
    const { kc, secrets, tree } = setup()
    const out = await transformSecretWrite({
      tree,
      secrets,
      patch: { apiToken: 'legacy-inline-token' },
      stored: { apiToken: 'legacy-inline-token' },
    })
    expect(out.patch).toEqual({})
    expect(kc.puts).toBe(0)
  })

  it('the OPERATOR re-entering the same value stores it in the keychain', async () => {
    const { kc, secrets, tree } = setup()
    const out = await transformSecretWrite({
      tree,
      secrets,
      patch: { apiToken: 'legacy-inline-token' },
      stored: { apiToken: 'legacy-inline-token' },
      operatorWrite: true,
    })
    expect(out.patch).toEqual({ apiToken: makeSecretMarker(ref('apiToken')) })
    expect(kc.puts).toBe(1)
  })

  it('a CHANGED value replaces the inline one through the keychain', async () => {
    const { kc, secrets, tree } = setup()
    const out = await transformSecretWrite({
      tree,
      secrets,
      patch: { apiToken: 'operator-typed-new-token' },
      stored: { apiToken: 'legacy-inline-token' },
    })
    expect(out.patch).toEqual({ apiToken: makeSecretMarker(ref('apiToken')) })
    expect(kc.puts).toBe(1)
  })
})

describe('declared device paths', () => {
  it('builds the tree of a dotted / [] path list', async () => {
    const { secretTreeFromPaths } = await import('../secret-paths.js')
    const tree = secretTreeFromPaths(['password', 'connection.apiKey', 'rows[].token'])
    expect(tree.get('password')).toEqual({ kind: 'leaf' })
    expect(tree.get('connection')).toMatchObject({ kind: 'object' })
    expect(tree.get('rows')).toMatchObject({ kind: 'array', idKey: 'id' })
  })
})
