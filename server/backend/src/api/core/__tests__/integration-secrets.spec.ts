import {
  createSecretsAccess,
  type KeychainResolveResult,
  type KeychainTransport,
  makeSecretMarker,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { readIntegrationSettings, writeIntegrationSettings } from '../integration-secrets'

/**
 * The integration-settings door (D787): a Wyze password typed in the
 * integration form is kept in the keychain for the Wyze addon; the addon
 * reads it back resolved, the admin form reads "set".
 */

function world() {
  const kc = new Map<string, string>()
  let table: Record<string, unknown> = {}
  const transport: KeychainTransport = {
    put: async ({ ref, value }) => {
      kc.set(ref, value)
      return { ref, version: 1 }
    },
    resolve: async ({ refs }) => {
      const out: KeychainResolveResult = {}
      for (const ref of refs) {
        const v = kc.get(ref)
        out[ref] = v !== undefined ? { kind: 'value', value: v, version: 1 } : { kind: 'missing' }
      }
      return out
    },
    delete: async ({ refs }) => {
      for (const r of refs) kc.delete(r)
      return { deleted: refs.length }
    },
    getState: async () => ({ state: 'ready' }),
  }
  const registry = {
    getIntegrationSettings: async () => ({ ...table }),
    setIntegrationSettings: async (_id: string, s: Record<string, unknown>) => {
      table = { ...table, ...s }
    },
  }
  return {
    kc,
    registry,
    table: () => table,
    secrets: createSecretsAccess({ owner: 'provider-wyze', transport }),
  }
}

const REF = 'secret://provider-wyze/integration/int_1/password'

describe('integration settings keychain door', () => {
  it('keeps the declared password out of the table and serves the owner the value, the form a view', async () => {
    const w = world()
    await writeIntegrationSettings(
      { registry: w.registry, secrets: w.secrets },
      {
        integrationId: 'int_1',
        settings: { email: 'a@b.c', password: 'wyze-pass-123' },
        secretKeys: ['password'],
      },
    )
    expect(w.table()).toEqual({ email: 'a@b.c', password: makeSecretMarker(REF) })
    expect(
      await readIntegrationSettings(
        { registry: w.registry, secrets: w.secrets },
        { integrationId: 'int_1', forOwner: true },
      ),
    ).toEqual({ email: 'a@b.c', password: 'wyze-pass-123' })
    const form = await readIntegrationSettings(
      { registry: w.registry, secrets: null },
      { integrationId: 'int_1', forOwner: false },
    )
    expect(form).toEqual({ email: 'a@b.c', password: { $secret: REF, v: 1, set: true } })
    expect(JSON.stringify(form)).not.toContain('wyze-pass-123')
  })

  it("a re-save sending the view back keeps the value; '' keeps it too", async () => {
    const w = world()
    await writeIntegrationSettings(
      { registry: w.registry, secrets: w.secrets },
      { integrationId: 'int_1', settings: { password: 'wyze-pass-123' }, secretKeys: ['password'] },
    )
    await writeIntegrationSettings(
      { registry: w.registry, secrets: w.secrets },
      {
        integrationId: 'int_1',
        settings: { password: { $secret: REF, v: 1, set: true } },
        secretKeys: [],
      },
    )
    await writeIntegrationSettings(
      { registry: w.registry, secrets: w.secrets },
      { integrationId: 'int_1', settings: { password: '' }, secretKeys: ['password'] },
    )
    expect(w.table()['password']).toEqual(makeSecretMarker(REF))
    expect(w.kc.get(REF)).toBe('wyze-pass-123')
  })

  it('a declared secret held as plaintext never reaches the admin form, and is reported', async () => {
    const w = world()
    await w.registry.setIntegrationSettings('int_1', { email: 'a@b.c', password: 'inline-pass' })
    const reported: string[] = []
    const form = await readIntegrationSettings(
      { registry: w.registry, secrets: null },
      {
        integrationId: 'int_1',
        forOwner: false,
        secretKeys: new Set(['password']),
        onSuspectSecret: (s) => reported.push(`${s.key}:${s.kind}`),
      },
    )
    expect(JSON.stringify(form)).not.toContain('inline-pass')
    expect(form['password']).toEqual({ $secret: null, v: 1, set: true, inline: true })
    expect(form['email']).toBe('a@b.c')
    expect(reported).toEqual(['password:plaintext'])
  })

  it('a marker coerced to "[object Object]" is redacted for the form and reported for every reader', async () => {
    const w = world()
    await w.registry.setIntegrationSettings('int_1', { password: '[object Object]' })
    const reported: string[] = []
    const onSuspectSecret = (s: { key: string; kind: string }): void => {
      reported.push(`${s.key}:${s.kind}`)
    }
    const form = await readIntegrationSettings(
      { registry: w.registry, secrets: null },
      { integrationId: 'int_1', forOwner: false, onSuspectSecret },
    )
    expect(JSON.stringify(form)).not.toContain('[object Object]')
    await readIntegrationSettings(
      { registry: w.registry, secrets: w.secrets },
      { integrationId: 'int_1', forOwner: true, onSuspectSecret },
    )
    expect(reported).toEqual(['password:coerced-marker', 'password:coerced-marker'])
  })
})
