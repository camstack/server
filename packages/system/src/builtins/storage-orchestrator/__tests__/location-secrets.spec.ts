/**
 * Credential redaction for `StorageLocation.config`.
 *
 * `storage.listLocations` has no `auth` override, so it is `protected` and
 * every authenticated session reads it — and the orchestrator used to spread
 * each stored row verbatim. The exposure is not live only because every
 * location on the hub today is `filesystem-storage`; it arrives with the first
 * remote location, and three providers that collect a credential already ship.
 *
 * The test that matters most is the SFTP private key: it lives in a
 * `textarea`, not a password input, so a redaction keyed on
 * `type: 'password'` would have shipped with the key on the wire AND an
 * assurance that credentials were redacted.
 */
import { REDACTED_SECRET } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  redactLocationConfig,
  restoreRedactedSecrets,
  secretKeysOfProviderInfo,
} from '../location-secrets.js'

const SFTP_LIKE_SCHEMA = {
  sections: [
    {
      id: 'connection',
      title: 'Connection',
      fields: [
        { type: 'text', key: 'host', label: 'Host' },
        { type: 'text', key: 'username', label: 'Username' },
        { type: 'password', key: 'password', label: 'Password' },
        { type: 'textarea', key: 'privateKey', label: 'Private Key', secret: true },
        { type: 'password', key: 'privateKeyPassphrase', label: 'Passphrase' },
      ],
    },
    {
      id: 'storage',
      title: 'Storage',
      fields: [{ type: 'text', key: 'basePath', label: 'Path' }],
    },
  ],
}

describe('secret discovery from a provider’s own schema', () => {
  it('finds the PEM key parked in a textarea, not just the password inputs', () => {
    const keys = secretKeysOfProviderInfo({
      providerId: 'sftp-storage',
      configSchema: SFTP_LIKE_SCHEMA,
    })
    expect([...keys].toSorted()).toEqual(['password', 'privateKey', 'privateKeyPassphrase'])
  })

  it('walks nested group and sub-tabs containers', () => {
    const keys = secretKeysOfProviderInfo({
      providerId: 'x',
      configSchema: {
        sections: [
          {
            id: 's',
            title: 'S',
            fields: [
              {
                type: 'group',
                key: 'g',
                label: 'G',
                fields: [{ type: 'password', key: 'nestedSecret', label: 'N' }],
              },
              {
                type: 'sub-tabs',
                key: 't',
                label: 'T',
                tabs: [
                  {
                    id: 'a',
                    label: 'A',
                    fields: [{ type: 'text', key: 'tokenish', label: 'T', secret: true }],
                  },
                ],
              },
            ],
          },
        ],
      },
    })
    expect([...keys].toSorted()).toEqual(['nestedSecret', 'tokenish'])
  })

  it('reports nothing for a schema it cannot read, rather than guessing', () => {
    expect(secretKeysOfProviderInfo({ providerId: 'x', configSchema: undefined }).size).toBe(0)
    expect(secretKeysOfProviderInfo({ providerId: 'x', configSchema: 'nonsense' }).size).toBe(0)
  })
})

describe('redaction on the way out', () => {
  const keys = secretKeysOfProviderInfo({
    providerId: 'sftp-storage',
    configSchema: SFTP_LIKE_SCHEMA,
  })

  it('replaces every secret and leaves everything else alone', () => {
    const out = redactLocationConfig(
      {
        host: 'nas.local',
        username: 'camstack',
        password: 'hunter2',
        privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----',
        basePath: '/srv/backups',
      },
      keys,
    )
    expect(out['password']).toBe(REDACTED_SECRET)
    expect(out['privateKey']).toBe(REDACTED_SECRET)
    expect(out['host']).toBe('nas.local')
    expect(out['basePath']).toBe('/srv/backups')
  })

  it('does not invent a secret that is not set', () => {
    const out = redactLocationConfig({ host: 'nas.local', password: '' }, keys)
    expect(out['password']).toBe('')
    expect(Object.keys(out)).not.toContain('privateKey')
  })

  it('returns the same object when there is nothing to redact', () => {
    const config = { basePath: '/data', maxUsedGb: 100 }
    expect(redactLocationConfig(config, keys)).toBe(config)
  })
})

describe('the sentinel travelling back in', () => {
  const keys = secretKeysOfProviderInfo({
    providerId: 'sftp-storage',
    configSchema: SFTP_LIKE_SCHEMA,
  })

  it('restores the stored secret so an edit does not require retyping it', () => {
    const out = restoreRedactedSecrets(
      { host: 'nas2.local', password: REDACTED_SECRET },
      { host: 'nas.local', password: 'hunter2' },
      keys,
    )
    expect(out['password']).toBe('hunter2')
    expect(out['host']).toBe('nas2.local')
  })

  it('drops a sentinel with nothing behind it rather than persisting the literal', () => {
    const out = restoreRedactedSecrets({ password: REDACTED_SECRET }, {}, keys)
    expect(Object.keys(out)).not.toContain('password')
  })

  it('leaves a NON-secret field alone even if it happens to equal the sentinel', () => {
    const out = restoreRedactedSecrets({ host: REDACTED_SECRET }, { host: 'nas.local' }, keys)
    expect(out['host']).toBe(REDACTED_SECRET)
  })

  it('writes a genuinely new secret straight through', () => {
    const out = restoreRedactedSecrets({ password: 'newpass' }, { password: 'old' }, keys)
    expect(out['password']).toBe('newpass')
  })
})
