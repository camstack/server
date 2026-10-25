/**
 * Unit spec for the non-admin device-config secret redaction.
 *
 * The invariant under test is narrow and stated once: a config key that the
 * settings UI renders as a PASSWORD field is a key whose value a non-admin
 * caller must not receive. The last assertion in this file pins the two
 * classifiers together — a keyword added to one and forgotten in the other
 * fails here rather than leaking in production.
 */
import type { DeviceConfigEntry } from '@camstack/types'
import { zodEntriesToConfigUI } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  isSecretConfigKey,
  NON_ADMIN_CONFIG_REDACTED_METHODS,
  REDACTED_SECRET,
  redactConfigEntries,
  redactDeviceInfoRecordSecrets,
  redactDeviceInfoSecrets,
  redactSettingsAggregate,
  redactSettingsSections,
  redactStreamUrlSecrets,
} from '../device-config-secret-redaction.js'

const deviceRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 101,
  name: 'Camera front door',
  online: true,
  config: {
    host: '192.168.10.139',
    port: 80,
    username: 'operator',
    password: 'hunter2-not-real',
    rtspPath: '/Streaming/Channels/101',
    ...(over['config'] as Record<string, unknown> | undefined),
  },
  ...over,
})

describe('isSecretConfigKey', () => {
  it('classifies the credential-bearing key names', () => {
    for (const key of [
      'password',
      'Password',
      'devicePassword',
      'secret',
      'clientSecret',
      'token',
      'accessToken',
      'apiKey',
      'api_key',
      'APIKEY',
    ]) {
      expect(isSecretConfigKey(key), key).toBe(true)
    }
  })

  it('leaves ordinary connection fields alone', () => {
    for (const key of ['host', 'port', 'username', 'rtspPath', 'name', 'channel']) {
      expect(isSecretConfigKey(key), key).toBe(false)
    }
  })
})

describe('redactDeviceInfoSecrets', () => {
  it('replaces the secret VALUE and keeps every other config field intact', () => {
    const out = redactDeviceInfoSecrets(deviceRow())
    const cfg = (out as { config: Record<string, unknown> }).config
    expect(cfg['password']).toBe(REDACTED_SECRET)
    expect(cfg['host']).toBe('192.168.10.139')
    expect(cfg['username']).toBe('operator')
    expect(cfg['port']).toBe(80)
  })

  it('keeps the KEY so a non-admin surface can still tell "configured" from "unset"', () => {
    const out = redactDeviceInfoSecrets(deviceRow())
    expect(Object.keys((out as { config: Record<string, unknown> }).config)).toContain('password')
  })

  it('leaves an EMPTY secret empty — "unset" must not read as "configured"', () => {
    const out = redactDeviceInfoSecrets(deviceRow({ config: { password: '' } }))
    expect((out as { config: Record<string, unknown> }).config['password']).toBe('')
  })

  it('does not mutate the input (immutability rule)', () => {
    const row = deviceRow()
    const before = JSON.stringify(row)
    redactDeviceInfoSecrets(row)
    expect(JSON.stringify(row)).toBe(before)
  })

  it('projects an ARRAY of rows — the whole-fleet listAll shape', () => {
    const out = redactDeviceInfoSecrets([deviceRow(), deviceRow({ id: 102 })])
    expect(Array.isArray(out)).toBe(true)
    for (const row of out as { config: Record<string, unknown> }[]) {
      expect(row.config['password']).toBe(REDACTED_SECRET)
    }
  })

  it('passes null / non-row payloads through untouched', () => {
    expect(redactDeviceInfoSecrets(null)).toBeNull()
    expect(redactDeviceInfoSecrets('nope')).toBe('nope')
  })
})

describe('redactSettingsSections / redactSettingsAggregate / redactConfigEntries', () => {
  const sections = {
    sections: [
      {
        id: 'connection',
        fields: [
          { key: 'host', value: '192.168.10.139', type: 'text' },
          { key: 'password', value: 'hunter2-not-real', type: 'password' },
        ],
      },
    ],
  }

  it('redacts the field VALUE inside a settings aggregate', () => {
    const out = redactSettingsSections(sections) as typeof sections
    expect(out.sections[0]!.fields[1]!.value).toBe(REDACTED_SECRET)
    expect(out.sections[0]!.fields[0]!.value).toBe('192.168.10.139')
    // The field still renders — only its value is withheld.
    expect(out.sections[0]!.fields[1]!.type).toBe('password')
  })

  it('reaches the nested `settings` of the combined device aggregate', () => {
    const out = redactSettingsAggregate({ live: { foo: 1 }, settings: sections })
    const nested = (out as { settings: typeof sections }).settings
    expect(nested.sections[0]!.fields[1]!.value).toBe(REDACTED_SECRET)
  })

  it('redacts a flat ConfigEntry[] (getConfigSchema)', () => {
    const out = redactConfigEntries([
      { key: 'host', value: '192.168.10.139' },
      { key: 'password', value: 'hunter2-not-real' },
    ])
    expect((out as { key: string; value: unknown }[])[1]!.value).toBe(REDACTED_SECRET)
  })
})

describe('redactStreamUrlSecrets — RTSP/RTMP userinfo (F0.3)', () => {
  it('masks user:pass@ in a `url` field but keeps the rest of the entry', () => {
    const out = redactStreamUrlSecrets({
      brokerId: '101/high',
      url: 'rtsp://admin:hunter2-not-real@192.168.10.139:554/Streaming/Channels/101',
      enabled: true,
      codec: 'h264',
    }) as Record<string, unknown>
    expect(out['url']).toBe('rtsp://192.168.10.139:554/Streaming/Channels/101')
    expect(JSON.stringify(out)).not.toContain('hunter2-not-real')
    expect(out['codec']).toBe('h264')
    expect(out['enabled']).toBe(true)
  })

  it('masks BOTH url and mutedUrl on an RTSP restream entry array', () => {
    const out = redactStreamUrlSecrets([
      {
        brokerId: 'b1',
        url: 'rtsp://u:p@10.0.0.5/main',
        mutedUrl: 'rtsp://u:p@10.0.0.5/main?muted=1',
        enabled: true,
      },
    ]) as Record<string, unknown>[]
    expect(JSON.stringify(out)).not.toContain('u:p@')
    expect(out[0]!['url']).toBe('rtsp://10.0.0.5/main')
    expect(out[0]!['mutedUrl']).toBe('rtsp://10.0.0.5/main?muted=1')
  })

  it('leaves a credential-free broker URL (token in the path) unchanged', () => {
    const url = 'rtsp://192.168.10.10:8554/101-high-abc123token'
    const out = redactStreamUrlSecrets({ url }) as Record<string, unknown>
    expect(out['url']).toBe(url)
  })

  it('leaves an empty / absent url and non-row payloads alone', () => {
    expect(redactStreamUrlSecrets({ url: '' })).toEqual({ url: '' })
    expect(redactStreamUrlSecrets(null)).toBeNull()
    expect(redactStreamUrlSecrets('nope')).toBe('nope')
  })

  it('does not mutate the input (immutability rule)', () => {
    const row = { url: 'rtsp://u:p@h/s' }
    const before = JSON.stringify(row)
    redactStreamUrlSecrets(row)
    expect(JSON.stringify(row)).toBe(before)
  })
})

describe('redactDeviceInfoRecordSecrets — the batch answer is a RECORD of device rows', () => {
  it('redacts inside every parent bucket', () => {
    const out = redactDeviceInfoRecordSecrets({ '700': [deviceRow()], '701': [deviceRow()] })
    const buckets = Object.values(out as Record<string, unknown>)
    for (const bucket of buckets) {
      const rows = bucket as readonly Record<string, unknown>[]
      const config = rows[0]?.['config'] as Record<string, unknown>
      expect(config['password']).toBe(REDACTED_SECRET)
      expect(config['host']).toBe('192.168.10.139')
    }
  })

  it('is NOT what the array redactor would have done — which is the whole point', () => {
    // `redactDeviceInfoSecrets` accepts the batch answer (it IS a record),
    // finds no `config` on it, and returns it verbatim. A batch of a
    // single-device read must never be the ungated way to ask the question.
    const batch = { '700': [deviceRow()] }
    const throughArrayRedactor = redactDeviceInfoSecrets(batch) as Record<string, unknown>
    const leaked = (throughArrayRedactor['700'] as readonly Record<string, unknown>[])[0]?.[
      'config'
    ] as Record<string, unknown>
    expect(leaked['password']).toBe('hunter2-not-real')
  })
})

describe('every enumerated path is wired to a redactor that fits ITS shape', () => {
  it('the redactor registered for getChildrenBatch actually cuts the batch payload', () => {
    // Being in the list is not the invariant — being in the list with the
    // WRONG projection reads as covered and leaks anyway.
    const redactor = NON_ADMIN_CONFIG_REDACTED_METHODS.get('deviceManager.getChildrenBatch')
    const out = redactor?.({ '700': [deviceRow()] }) as Record<string, unknown>
    const config = (out['700'] as readonly Record<string, unknown>[])[0]?.['config'] as Record<
      string,
      unknown
    >
    expect(config['password']).toBe(REDACTED_SECRET)
  })
})

describe('the enumeration covers every non-admin read that can leak a secret', () => {
  it('lists exactly the config-bearing AND stream-url-bearing paths', () => {
    expect([...NON_ADMIN_CONFIG_REDACTED_METHODS.keys()].sort()).toEqual([
      'addonSettings.getDeviceSettings',
      'addonSettings.getGlobalSettings',
      'addonSettings.getIntegrationSettings',
      'cameraStreams.getCameraStreams',
      'cameraStreams.getProfileRtspEntries',
      'cameraStreams.getRtspEntries',
      'deviceExport.getStatus',
      'deviceManager.getChildren',
      'deviceManager.getChildrenBatch',
      'deviceManager.getConfigSchema',
      'deviceManager.getDevice',
      'deviceManager.getDeviceAggregate',
      'deviceManager.getDeviceSettingsAggregate',
      'deviceManager.getDeviceStatusAggregate',
      'deviceManager.getDeviceStatusAggregateBatch',
      'deviceManager.getSettingsSchema',
      'deviceManager.getStreamSources',
      'deviceManager.listAll',
      'deviceOps.getConfigEntries',
      'deviceOps.getRawState',
      'deviceOps.getSettingsSchema',
      'deviceOps.getStreamSources',
      'deviceState.getAllSnapshots',
      'deviceState.getCapSlice',
      'deviceState.getSnapshot',
      'integrations.get',
      'integrations.getByAddonId',
      'integrations.list',
      'mqttBroker.listBrokers',
      'streamBroker.getAllRtspEntries',
      'streamBroker.getRtspEntry',
      'streamCatalog.getCatalog',
    ])
  })
})

describe('the redactor agrees with the settings UI about what is a secret', () => {
  it('a key rendered as a PASSWORD field is a key that gets redacted', () => {
    const keys = [
      'password',
      'devicePassword',
      'secret',
      'clientSecret',
      'token',
      'accessToken',
      'apiKey',
      'api_key',
      'host',
      'username',
      'rtspPath',
      'channel',
    ]
    const entries: DeviceConfigEntry[] = keys.map((key) => ({
      key,
      schema: z.string(),
      value: 'x',
    }))
    const ui = zodEntriesToConfigUI(entries)
    const fields = ui.sections.flatMap((s) => s.fields)
    for (const key of keys) {
      const field = fields.find((f) => f.key === key)
      expect(field, `no UI field for ${key}`).toBeDefined()
      const rendersAsPassword = field?.type === 'password'
      expect(isSecretConfigKey(key), `classifier disagrees with the UI for '${key}'`).toBe(
        rendersAsPassword,
      )
    }
  })
})

/**
 * `addonSettings.getGlobalSettings` & co. are `protected`, and `hydrateSchema`
 * fills a `password` field with its STORED value (the masking was removed on
 * purpose, trusting an "admin-gated endpoint" that was never admin-gated). So
 * every role read every addon's API keys — a Cloudflare token, an LLM key, a
 * Home Assistant token — in plaintext (review L6, D634). The field decides:
 * `type: 'password'` or `secret: true`, whatever its key is called, and in a
 * group or sub-tab as much as at the top level.
 */
describe('addon settings forms are redacted for a non-admin (D634)', () => {
  const form = {
    sections: [
      {
        id: 'main',
        fields: [
          { key: 'topic', type: 'password', value: 'ntfy-secret-topic' },
          { key: 'privateKey', type: 'textarea', secret: true, value: '-----BEGIN KEY-----' },
          { key: 'host', type: 'text', value: 'nas.local' },
          {
            key: 'advanced',
            type: 'group',
            fields: [{ key: 'credential', type: 'password', value: 'nested-secret' }],
          },
          {
            key: 'tabs',
            type: 'sub-tabs',
            tabs: [{ id: 't', fields: [{ key: 'bearer', type: 'password', value: 'tab-secret' }] }],
          },
          { key: 'empty', type: 'password', value: '' },
        ],
      },
    ],
  }

  it('withholds every password / secret field value, at any depth, by field type', () => {
    const redact = NON_ADMIN_CONFIG_REDACTED_METHODS.get('addonSettings.getGlobalSettings')
    if (redact === undefined) throw new Error('addonSettings.getGlobalSettings is not redacted')
    const out = JSON.stringify(redact(form))
    for (const secret of ['ntfy-secret-topic', 'BEGIN KEY', 'nested-secret', 'tab-secret']) {
      expect(out).not.toContain(secret)
    }
    expect(out).toContain('nas.local')
    // "unset" still reads as unset.
    expect(out).toContain('"key":"empty","type":"password","value":""')
  })

  it('the device and integration surfaces use the same redactor', () => {
    const global = NON_ADMIN_CONFIG_REDACTED_METHODS.get('addonSettings.getGlobalSettings')
    expect(NON_ADMIN_CONFIG_REDACTED_METHODS.get('addonSettings.getDeviceSettings')).toBe(global)
    expect(NON_ADMIN_CONFIG_REDACTED_METHODS.get('addonSettings.getIntegrationSettings')).toBe(
      global,
    )
  })
})
