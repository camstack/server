/**
 * Unit tests for the notification-targets pure helpers (T14).
 */

import type { ConfigUISchema, TargetKind } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  collectSecretKeys,
  duplicateTargetName,
  editedDestinationKeys,
  editedNonSecretKeys,
  groupKindsByAddon,
  isSecretRestoreRefusal,
  redactedFormValues,
  SECRET_UI_MASK,
  secretMergeDiff,
  secretsToReenter,
  withRequiredSecrets,
  withStoredSecretPlaceholders,
} from '../notification-targets.helpers'

const EMPTY_SCHEMA: ConfigUISchema = { sections: [] }

function kind(k: string, addonId: string): TargetKind {
  return {
    kind: k,
    label: k,
    icon: 'bell',
    addonId,
    configSchema: EMPTY_SCHEMA,
    supportsDiscovery: false,
    caps: {
      attachments: { mediaTypes: [], mode: 'url', max: 0 },
      actions: 0,
      levels: [],
      format: ['text'],
      clickUrl: false,
      sound: false,
      ttl: false,
      bodyMaxLen: 4096,
    },
  }
}

describe('groupKindsByAddon', () => {
  it('groups kinds by addonId preserving first-seen order', () => {
    const groups = groupKindsByAddon([
      kind('ntfy', 'notifiers'),
      kind('pushover', 'notifiers'),
      kind('homeassistant', 'ha'),
      kind('telegram', 'notifiers'),
    ])
    expect(groups.map((g) => g.addonId)).toEqual(['notifiers', 'ha'])
    expect(groups[0]!.kinds.map((k) => k.kind)).toEqual(['ntfy', 'pushover', 'telegram'])
    expect(groups[1]!.kinds.map((k) => k.kind)).toEqual(['homeassistant'])
  })

  it('returns [] for an empty catalog', () => {
    expect(groupKindsByAddon([])).toEqual([])
  })
})

describe('collectSecretKeys', () => {
  it('collects top-level password fields', () => {
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 's1',
          title: 'S1',
          fields: [
            { type: 'text', key: 'serverUrl', label: 'Server' },
            { type: 'password', key: 'token', label: 'Token' },
          ],
        },
      ],
    }
    expect(collectSecretKeys(schema)).toEqual(['token'])
  })

  it('recurses into group and sub-tabs containers', () => {
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 's1',
          title: 'S1',
          fields: [
            {
              type: 'group',
              key: 'auth',
              label: 'Auth',
              fields: [
                { type: 'password', key: 'apiKey', label: 'API Key' },
                { type: 'text', key: 'user', label: 'User' },
              ],
            },
            {
              type: 'sub-tabs',
              key: 'backends',
              label: 'Backends',
              tabs: [
                {
                  id: 'green',
                  label: 'Green',
                  fields: [{ type: 'password', key: 'apiTokenInstance', label: 'Token' }],
                },
              ],
            },
          ],
        },
      ],
    }
    expect(collectSecretKeys(schema).toSorted()).toEqual(['apiKey', 'apiTokenInstance'])
  })
})

describe('secretMergeDiff', () => {
  const secretKeys = ['token', 'password']

  it('passes non-secret fields through verbatim', () => {
    const out = secretMergeDiff({ serverUrl: 'https://x', topic: 'alerts' }, {}, secretKeys)
    expect(out).toEqual({ serverUrl: 'https://x', topic: 'alerts' })
  })

  it('omits secret fields left empty (server keeps stored value)', () => {
    const out = secretMergeDiff(
      { serverUrl: 'https://x', token: '' },
      { serverUrl: 'https://x', token: '' },
      secretKeys,
    )
    expect(out).toEqual({ serverUrl: 'https://x' })
    expect('token' in out).toBe(false)
  })

  it('includes a secret when present in the form (including unchanged live values)', () => {
    expect(secretMergeDiff({ token: 'new-secret' }, { token: '' }, secretKeys)).toEqual({
      token: 'new-secret',
    })
    expect(secretMergeDiff({ token: 'same' }, { token: 'same' }, secretKeys)).toEqual({
      token: 'same',
    })
  })

  it('omits the UI mask / redacted stand-in so the hub can restore', () => {
    expect(
      secretMergeDiff(
        { serverUrl: 'https://x', token: SECRET_UI_MASK },
        { serverUrl: 'https://x', token: '__redacted__' },
        secretKeys,
      ),
    ).toEqual({ serverUrl: 'https://x' })
    expect(
      secretMergeDiff({ token: '__redacted__' }, { token: '__redacted__' }, secretKeys),
    ).toEqual({})
  })

  it('handles a fresh create (no original) — sends typed secrets', () => {
    const out = secretMergeDiff(
      { serverUrl: 'https://x', token: 'abc', password: '' },
      {},
      secretKeys,
    )
    expect(out).toEqual({ serverUrl: 'https://x', token: 'abc' })
  })
})

describe('redactedFormValues', () => {
  it('fills present secrets with the UI mask and keeps the rest', () => {
    const out = redactedFormValues(
      { serverUrl: 'https://x', token: '__redacted__', topic: 'alerts' },
      ['token'],
    )
    expect(out).toEqual({ serverUrl: 'https://x', token: SECRET_UI_MASK, topic: 'alerts' })
  })

  it('leaves an absent secret empty', () => {
    const out = redactedFormValues({ serverUrl: 'https://x', token: '' }, ['token'])
    expect(out).toEqual({ serverUrl: 'https://x', token: '' })
  })
})

/**
 * ADR 0634: the hub refuses a save that changes where a target sends while a
 * secret stays redacted. The form has to say WHICH secret to re-type, before
 * the round trip when it can and unmistakably after it.
 */
describe('the secret-restore refusal (ADR 0634)', () => {
  const REFUSAL =
    "Refusing to reuse the stored secret (token) of target 't1': its destination changed " +
    '(serverUrl). Re-enter the secret when changing where this target sends — a stored ' +
    'credential only ever goes where it was typed for.'

  it('recognises the hub refusal, even wrapped, and nothing else', () => {
    expect(isSecretRestoreRefusal(REFUSAL)).toBe(true)
    expect(isSecretRestoreRefusal(`upsertTarget failed: ${REFUSAL}`)).toBe(true)
    expect(isSecretRestoreRefusal('Save failed')).toBe(false)
    expect(isSecretRestoreRefusal('')).toBe(false)
  })

  it('a non-secret field is edited only when its value differs (absent, null and empty agree)', () => {
    const original = { serverUrl: 'https://ntfy.sh', topic: '', token: '••••••' }
    expect(editedNonSecretKeys({ ...original, token: '' }, original, ['token'])).toEqual([])
    expect(
      editedNonSecretKeys({ serverUrl: 'https://evil.example', token: '' }, original, ['token']),
    ).toEqual(['serverUrl'])
    // A secret is never "a destination edit" — re-typing it is the fix.
    expect(editedNonSecretKeys({ ...original, token: 'new' }, original, ['token'])).toEqual([])
  })

  it("with the kind's published destinations, only a DESTINATION edit asks for the secret", () => {
    const original = { serverUrl: 'https://ntfy.sh', tags: 'a', token: '••••••' }
    const destinations = ['serverUrl']
    // Editing a non-destination field (tags) no longer triggers the hint.
    expect(
      editedDestinationKeys(
        { ...original, tags: 'b', token: '' },
        original,
        ['token'],
        destinations,
      ),
    ).toEqual([])
    expect(
      editedDestinationKeys(
        { ...original, serverUrl: 'https://evil.example', token: '' },
        original,
        ['token'],
        destinations,
      ),
    ).toEqual(['serverUrl'])
  })

  it('a destination that is itself a secret counts as edited only when RE-TYPED', () => {
    const original = { url: '••', headers: [] }
    expect(editedDestinationKeys({ url: '' }, original, ['url'], ['url'])).toEqual([])
    expect(editedDestinationKeys({ url: 'https://new' }, original, ['url'], ['url'])).toEqual([
      'url',
    ])
  })

  it('a kind that publishes no destinations (an older hub) keeps the any-edit hint', () => {
    const original = { serverUrl: 'https://ntfy.sh', tags: 'a' }
    expect(editedDestinationKeys({ ...original, tags: 'b' }, original, [], undefined)).toEqual([
      'tags',
    ])
  })

  it('the secrets to re-enter are the ones a save would NOT send', () => {
    const original = { a: '••', b: '••' }
    expect(secretsToReenter({ a: '', b: 'typed' }, original, ['a', 'b'])).toEqual(['a'])
    expect(secretsToReenter({ a: 'x', b: 'y' }, original, ['a', 'b'])).toEqual([])
  })

  it('marks exactly the named password fields required, in groups and sub-tabs too', () => {
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 's',
          title: 'S',
          fields: [
            { type: 'text', key: 'serverUrl', label: 'URL' },
            { type: 'password', key: 'token', label: 'Token' },
            {
              type: 'group',
              key: 'g',
              label: 'G',
              fields: [{ type: 'password', key: 'pw', label: 'PW' }],
            },
          ],
        },
      ],
    }
    const out = withRequiredSecrets(schema, ['token', 'pw'])
    const fields = out.sections[0]?.fields ?? []
    expect(fields[0]).toEqual(schema.sections[0]?.fields[0])
    expect(fields[1]).toMatchObject({ key: 'token', required: true })
    const group = fields[2]
    expect(group?.type === 'group' ? group.fields[0] : undefined).toMatchObject({
      key: 'pw',
      required: true,
    })
    // Never in place.
    expect(schema.sections[0]?.fields[1]).not.toHaveProperty('required')
    expect(withRequiredSecrets(schema, [])).toBe(schema)
  })

  it('duplicateTargetName appends Copy', () => {
    expect(duplicateTargetName('Alerts')).toBe('Alerts Copy')
    expect(duplicateTargetName('  ')).toBe('Copy')
  })

  it('withStoredSecretPlaceholders keeps the password field and hints a stored value', () => {
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 'main',
          title: 'Main',
          fields: [{ type: 'password', key: 'token', label: 'Token', required: true }],
        },
      ],
    }
    const next = withStoredSecretPlaceholders(schema, { token: '__redacted__' }, ['token'])
    const field = next.sections[0]?.fields[0]
    expect(field?.type).toBe('password')
    expect(field && 'placeholder' in field ? field.placeholder : undefined).toMatch(/leave blank/)
  })
})
