import { describe, expect, it } from 'vitest'
import type { KeychainResolveEntry } from '../../capabilities/keychain.cap.js'
import { makeSecretMarker, SECRET_CLEAR } from '../../keychain/secret-marker.js'
import type { SecretsAccess } from '../../keychain/secrets-access.js'
import type { SecretTree } from '../secret-paths.js'
import {
  dropUnchangedKeys,
  restoreUnchangedSecrets,
  SecretOverwriteRefusedError,
  widenTreeWithStoredMarkers,
} from '../secret-write-back.js'

const OWNER = 'own'
const A = `secret://${OWNER}/global/a`
const B = `secret://${OWNER}/global/nested.b`
const FOREIGN = 'secret://someone-else/global/x'

function fakeSecrets(
  answers: Record<string, KeychainResolveEntry>,
  puts: Array<[string, string]> = [],
): SecretsAccess {
  return {
    owner: OWNER,
    ref: () => {
      throw new Error('not used')
    },
    resolve: async (refs) =>
      Object.fromEntries(refs.map((r) => [r, answers[r] ?? { kind: 'missing' }])),
    put: async (ref, value) => {
      puts.push([ref, value])
      return 2
    },
    delete: async () => 0,
    state: async () => ({ state: 'ready' }),
    onChange: () => () => undefined,
    forOwner: null,
  }
}

const value = (v: string): KeychainResolveEntry => ({ kind: 'value', value: v, version: 1 })

describe('restoreUnchangedSecrets', () => {
  const stored = {
    a: makeSecretMarker(A),
    nested: { b: makeSecretMarker(B), plain: 1 },
    rows: [{ id: 'r1', key: makeSecretMarker(A) }],
    x: makeSecretMarker(FOREIGN),
  }

  it('turns unchanged values back into their markers, at any depth, without a put', async () => {
    const puts: Array<[string, string]> = []
    const secrets = fakeSecrets({ [A]: value('va'), [B]: value('vb') }, puts)
    const { patch, changedRefs } = await restoreUnchangedSecrets({
      patch: { a: 'va', nested: { b: 'vb', plain: 2 }, rows: [{ id: 'r1', key: 'va' }] },
      stored,
      secrets,
      operatorWrite: false,
    })
    expect(patch).toEqual({
      a: makeSecretMarker(A),
      nested: { b: makeSecretMarker(B), plain: 2 },
      rows: [{ id: 'r1', key: makeSecretMarker(A) }],
    })
    expect(puts).toEqual([])
    expect(changedRefs).toEqual([])
  })

  it("'' and null KEEP the marker; a new value is put under the SAME ref", async () => {
    const puts: Array<[string, string]> = []
    const secrets = fakeSecrets({ [A]: value('va'), [B]: value('vb') }, puts)
    const { patch, changedRefs } = await restoreUnchangedSecrets({
      patch: { a: '', nested: { b: 'vb-new' } },
      stored,
      secrets,
      operatorWrite: false,
    })
    expect(patch).toEqual({ a: makeSecretMarker(A), nested: { b: makeSecretMarker(B) } })
    expect(puts).toEqual([[B, 'vb-new']])
    expect(changedRefs).toEqual([B])
  })

  it('leaves a clear instruction and a foreign marker alone', async () => {
    const secrets = fakeSecrets({ [A]: value('va') })
    const { patch } = await restoreUnchangedSecrets({
      patch: { a: SECRET_CLEAR, x: 'not-ours' },
      stored,
      secrets,
      operatorWrite: false,
    })
    expect(patch).toEqual({ a: SECRET_CLEAR, x: 'not-ours' })
  })

  it('refuses an addon overwrite of a value it cannot read; lets the operator through', async () => {
    const unavailable: KeychainResolveEntry = { kind: 'unavailable', reason: 'wrong-key' }
    await expect(
      restoreUnchangedSecrets({
        patch: { a: 'minted' },
        stored,
        secrets: fakeSecrets({ [A]: unavailable }),
        operatorWrite: false,
      }),
    ).rejects.toBeInstanceOf(SecretOverwriteRefusedError)
    const puts: Array<[string, string]> = []
    await restoreUnchangedSecrets({
      patch: { a: 'typed' },
      stored,
      secrets: fakeSecrets({ [A]: unavailable }, puts),
      operatorWrite: true,
    })
    expect(puts).toEqual([[A, 'typed']])
  })

  it('a patch over keys with no marker is returned as is', async () => {
    const patch = { plain: 'x' }
    const out = await restoreUnchangedSecrets({
      patch,
      stored: { plain: 'y' },
      secrets: fakeSecrets({}),
      operatorWrite: false,
    })
    expect(out.patch).toBe(patch)
  })
})

describe('widenTreeWithStoredMarkers / dropUnchangedKeys', () => {
  it('adds undeclared keys holding OUR markers (nested too) — not arrays, not declared, not foreign', () => {
    const declared: SecretTree = new Map([['declared', { kind: 'leaf' }]])
    const tree = widenTreeWithStoredMarkers(
      declared,
      {
        declared: makeSecretMarker(A),
        loose: makeSecretMarker(A),
        'scoped@node-1': makeSecretMarker(A),
        deep: { inner: makeSecretMarker(B), plain: 1 },
        list: [makeSecretMarker(A)],
        foreign: makeSecretMarker(FOREIGN),
        plain: 'x',
      },
      ['declared', 'loose', 'scoped@node-1', 'deep', 'list', 'foreign', 'plain'],
      OWNER,
    )
    expect([...tree.keys()].sort()).toEqual(['declared', 'deep', 'loose', 'scoped'])
    expect(tree.get('deep')).toEqual({
      kind: 'object',
      children: new Map([['inner', { kind: 'leaf' }]]),
    })
  })

  it('returns the declared tree itself when nothing widens it', () => {
    const declared: SecretTree = new Map()
    expect(widenTreeWithStoredMarkers(declared, { a: 1 }, ['a'], OWNER)).toBe(declared)
  })

  it('drops keys equal to the stored value, whatever their key order', () => {
    expect(
      dropUnchangedKeys(
        { same: { b: 2, a: 1 }, changed: 2, fresh: 3, nul: null },
        { same: { a: 1, b: 2 }, changed: 1 },
      ),
    ).toEqual({ changed: 2, fresh: 3, nul: null })
  })
})
