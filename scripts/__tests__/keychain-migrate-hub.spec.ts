import { describe, expect, it } from 'vitest'
// @ts-expect-error -- a plain .mjs operator script, no declaration file
import * as script from '../ops/keychain-migrate-hub.mjs'

/**
 * The one-off migration script's pure half: which paths are secret (by schema
 * TYPE plus the declared hidden state), which hold an inline value, and what a
 * write must re-send. It never handles a value beyond passing the stored one
 * back to the hub's own operator write path.
 */
describe('keychain-migrate-hub (operator one-off)', () => {
  const schema = {
    sections: [
      {
        id: 's',
        fields: [
          { type: 'text', key: 'password', label: 'not secret by name' },
          { type: 'password', key: 'apiToken', label: 't' },
          { type: 'textarea', key: 'pem', secret: true, label: 'k' },
          { type: 'textarea', key: 'json', secret: true, isJson: true, label: 'j' },
          { type: 'password', key: 'masked', storage: 'inline', label: 'm' },
          {
            type: 'editable-array',
            key: 'providers',
            label: 'p',
            itemFields: [{ type: 'password', key: 'clientSecret', label: 'c' }],
          },
        ],
      },
    ],
  }

  it('selects secrets by TYPE, never by name', () => {
    expect(script.secretPathsFromSchema(schema)).toEqual([
      'apiToken',
      'pem',
      'providers[id].clientSecret',
    ])
  })

  it('finds inline values (not markers, not empty), including perNode copies and array rows', () => {
    const blob = {
      apiToken: 'inline',
      'apiToken@agent-1': 'inline-too',
      pem: { $secret: 'secret://x/global/pem', v: 1 },
      providers: [
        { id: 'a', clientSecret: 'inline' },
        { id: 'b', clientSecret: '' },
      ],
      identity: { pincode: '123-45-678' },
    }
    const found = script.inlineSecrets(blob, [
      ...script.secretPathsFromSchema(schema),
      'identity.pincode',
    ])
    expect(found.map((f: { path: string }) => f.path).sort()).toEqual(
      ['apiToken', 'apiToken@agent-1', 'identity.pincode', 'providers[a].clientSecret'].sort(),
    )
    expect(JSON.stringify(found)).not.toContain('inline')
    const patch = script.migrationPatch(blob, found)
    expect(Object.keys(patch).sort()).toEqual([
      'apiToken',
      'apiToken@agent-1',
      'identity',
      'providers',
    ])
  })

  it('reads device paths with [] as id-addressed rows', () => {
    expect(script.parsePath('rows[].token')).toEqual([
      { key: 'rows', idKey: 'id' },
      { key: 'token' },
    ])
  })

  it('mirrors the hidden-state declarations of the addons', () => {
    expect(script.SECRET_STATE_PATHS['export-hap']).toEqual(['identity.pincode'])
    expect(script.SKIPPED_ADDONS.has('mqtt-broker')).toBe(true)
  })
})

describe('keychain-migrate-hub — D797 system secrets and the retired mqtt codec', () => {
  it('parses a values file without inventing empty values', () => {
    expect(
      script.parseValuesFile(
        '# hub env\nCAMSTACK_JWT_SECRET="abc"\nexport CAMSTACK_CLUSTER_SECRET=x y\nEMPTY=\n',
      ),
    ).toEqual({ CAMSTACK_JWT_SECRET: 'abc', CAMSTACK_CLUSTER_SECRET: 'x y' })
    // The cluster secret is read and ignored: there is none to import any more (D857).
  })

  it('resolves the signing key as the old hub did: env over config.yaml; only if set; no cluster secret', () => {
    expect(
      script.resolveSystemSecrets({
        values: { CAMSTACK_JWT_SECRET: 'from-env', CAMSTACK_CLUSTER_SECRET: 'ignored' },
        configAuth: { jwtSecret: 'from-yaml' },
      }),
    ).toEqual({ jwtSigningKey: 'from-env' })
    expect(script.resolveSystemSecrets({ configAuth: { jwtSecret: 'from-yaml' } })).toEqual({
      jwtSigningKey: 'from-yaml',
    })
    expect(script.resolveSystemSecrets({})).toEqual({ jwtSigningKey: null })
  })

  it('strips only the retired auth keys from config.yaml', () => {
    const { config, removed } = script.stripRetiredAuthKeys({
      server: { port: 4443 },
      auth: { jwtSecret: 's', adminUsername: 'admin', adminPassword: 'p' },
      keychain: { keyFile: '/k' },
    })
    expect(removed).toEqual(['auth.jwtSecret', 'auth.adminUsername', 'auth.adminPassword'])
    expect(config).toEqual({ server: { port: 4443 }, keychain: { keyFile: '/k' } })
  })

  it('decrypts the retired enc:v1 values and re-sends brokers whole', async () => {
    const { createCipheriv, randomBytes } = await import('node:crypto')
    const key = randomBytes(32)
    const enc = (text: string): string => {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', key, iv)
      const ct = Buffer.concat([c.update(text, 'utf-8'), c.final()])
      return `enc:v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`
    }
    const marker = { $secret: 'secret://mqtt-broker/global/brokers[b].password', v: 1 }
    const blob = {
      brokers: [
        { id: 'a', url: 'mqtt://a', password: enc('pw-a') },
        { id: 'b', url: 'mqtt://b', password: marker },
      ],
      embeddedPassword: enc('pw-embedded'),
    }
    expect(script.mqttCiphertextPaths(blob)).toEqual(['brokers[a].password', 'embeddedPassword'])
    const { patch, paths } = script.mqttMigrationPatch(blob, key)
    expect(paths).toEqual(['brokers[a].password', 'embeddedPassword'])
    expect(patch).toEqual({
      brokers: [
        { id: 'a', url: 'mqtt://a', password: 'pw-a' },
        { id: 'b', url: 'mqtt://b', password: marker },
      ],
      embeddedPassword: 'pw-embedded',
    })
    expect(() => script.mqttMigrationPatch(blob, randomBytes(32))).toThrow()
  })

  it('derives the old key like the retired codec did', () => {
    const raw = Buffer.alloc(32, 7)
    expect(script.mqttKeyFromFile(raw).equals(raw)).toBe(true)
    expect(script.mqttKeyFromMaterial(raw.toString('base64')).equals(raw)).toBe(true)
    expect(script.mqttKeyFromMaterial('a passphrase')).toHaveLength(32)
  })
})
