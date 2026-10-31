/**
 * Secrets inside ARRAY values of an addon settings form are withheld from a
 * non-admin too (D634, fix round 2).
 *
 * Round 1 redacted a secret field's STRING value only. An `editable-array`
 * whose rows carry a `password` item has an array of row objects as its value,
 * and the array's own key (`brokers`) is not secret-named — so every row went
 * out whole. Live: `addon-mqtt-broker`'s `brokers` rows, one password each.
 *
 * Driven through a schema of the same SHAPE as `addon-mqtt-broker`'s global
 * settings (an `editable-array` of broker rows with a `password` item, a URL
 * text field with userinfo, an embedded password, client rows with a bcrypt
 * hash in a text field), hydrated by the REAL `hydrateSchema` — the pair
 * `BaseAddon.getGlobalSettings` answers with. The server never imports an
 * addon, not even in a spec, so the shape is restated here.
 */
import { type ConfigUISchema, hydrateSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  NON_ADMIN_CONFIG_REDACTED_METHODS,
  REDACTED_SECRET,
} from '../device-config-secret-redaction.js'

const BROKER_LIKE_SCHEMA: ConfigUISchema = {
  sections: [
    {
      id: 'external-brokers',
      title: 'External brokers',
      columns: 1,
      fields: [
        {
          type: 'editable-array',
          key: 'brokers',
          label: 'External brokers',
          itemFields: [
            { type: 'text', key: 'id', label: 'Id' },
            { type: 'text', key: 'name', label: 'Name' },
            { type: 'text', key: 'url', label: 'URL' },
            { type: 'text', key: 'username', label: 'Username' },
            { type: 'password', key: 'password', label: 'Password' },
            { type: 'text', key: 'clientIdPrefix', label: 'Client id prefix' },
          ],
        },
      ],
    },
    {
      id: 'embedded',
      title: 'Embedded broker',
      columns: 1,
      fields: [{ type: 'password', key: 'embeddedPassword', label: 'Password' }],
    },
    {
      id: 'embedded-clients',
      title: 'Embedded broker — credentials',
      columns: 1,
      fields: [
        {
          type: 'editable-array',
          key: 'embeddedClients',
          label: 'Clients',
          itemFields: [
            { type: 'text', key: 'username', label: 'Username' },
            { type: 'text', key: 'passwordHash', label: 'bcrypt hash' },
          ],
        },
      ],
    },
  ],
}

function redactGlobal(data: unknown): unknown {
  const redact = NON_ADMIN_CONFIG_REDACTED_METHODS.get('addonSettings.getGlobalSettings')
  if (redact === undefined) throw new Error('addonSettings.getGlobalSettings is not redacted')
  return redact(data)
}

const STORED = {
  brokers: [
    {
      id: 'b1',
      name: 'Home mosquitto',
      url: 'mqtt://camstack:url-secret@10.0.0.5:1883',
      username: 'camstack',
      password: 'broker-row-secret',
      clientIdPrefix: 'cs',
    },
  ],
  embeddedPassword: 'embedded-secret',
  embeddedClients: [{ username: 'shelly', passwordHash: '$2b$10$bcrypt-hash-secret' }],
}

describe('addon settings: secrets inside arrays (broker-shaped schema)', () => {
  // As `BaseAddon.getGlobalSettings` answers: inline secrets become views (D789).
  const hydrated = hydrateSchema(BROKER_LIKE_SCHEMA, STORED, {
    inlineSecretsAsViews: true,
  })

  it('the admin form carries no keychain-stored value, only the secrets redaction must still withhold', () => {
    const raw = JSON.stringify(hydrated)
    // `password` fields hydrate as their keychain view since D789 — even a
    // pre-keychain inline value never reaches the form.
    for (const s of ['broker-row-secret', 'embedded-secret']) expect(raw).not.toContain(s)
    // A non-secret-typed field (a URL with userinfo, a bcrypt hash in a text
    // field) is still in the admin form, so the non-admin redaction below is
    // what keeps it from a viewer.
    for (const s of ['bcrypt-hash-secret', 'url-secret']) expect(raw).toContain(s)
  })

  it('withholds every row password, the embedded password, the client hashes and URL userinfo', () => {
    const out = JSON.stringify(redactGlobal(hydrated))
    for (const s of ['broker-row-secret', 'embedded-secret', 'bcrypt-hash-secret', 'url-secret']) {
      expect(out, `${s} reached a non-admin`).not.toContain(s)
    }
    // The rows still render: names, hosts and usernames survive.
    expect(out).toContain('Home mosquitto')
    expect(out).toContain('10.0.0.5:1883')
    expect(out).toContain('shelly')
    expect(out).toContain(REDACTED_SECRET)
  })
})

describe('addon settings: other array-valued secret shapes', () => {
  it('redacts each element of a `multiple` password field', () => {
    const form = {
      sections: [
        {
          id: 's',
          fields: [
            {
              key: 'apiKeys',
              type: 'password',
              multiple: {},
              value: ['k-one-secret', 'k-two-secret'],
            },
          ],
        },
      ],
    }
    const out = JSON.stringify(redactGlobal(form))
    expect(out).not.toContain('k-one-secret')
    expect(out).not.toContain('k-two-secret')
  })

  it('redacts a secret nested in an array inside an array row', () => {
    const form = {
      sections: [
        {
          id: 's',
          fields: [
            {
              key: 'sites',
              type: 'editable-array',
              itemFields: [
                { key: 'name', type: 'text' },
                {
                  key: 'logins',
                  type: 'editable-array',
                  itemFields: [{ key: 'pin', type: 'password' }],
                },
              ],
              value: [{ name: 'Casa', logins: [{ pin: 'nested-row-secret' }] }],
            },
          ],
        },
      ],
    }
    const out = JSON.stringify(redactGlobal(form))
    expect(out).not.toContain('nested-row-secret')
    expect(out).toContain('Casa')
  })

  it('redacts a secret-NAMED key inside an object/JSON value (a map of tokens)', () => {
    const form = {
      sections: [
        {
          id: 's',
          fields: [
            {
              key: 'integrations',
              type: 'textarea',
              isJson: true,
              value: { hass: { url: 'http://ha', token: 'map-token-secret' } },
            },
          ],
        },
      ],
    }
    const out = JSON.stringify(redactGlobal(form))
    expect(out).not.toContain('map-token-secret')
    expect(out).toContain('http://ha')
  })
})

/**
 * Found by the round-2 sweep: the same pairing secrets reach a non-admin
 * outside the addon settings form.
 *  - HomeKit export contributes a `qr-code` field to a device's settings whose
 *    VALUE is the `X-HM://` setup URI and whose CAPTION spells the setup code —
 *    enough to pair a stranger's iPhone with the camera.
 *  - `deviceExport.getStatus` carries a `setup` block: the same HAP URI as
 *    `qr`, and the Alexa export's Lambda ingress token as a `secret: true` row.
 * Both are `protected`; the admin export panel is the only reader.
 */
describe('pairing secrets outside the addon form', () => {
  const deviceForm = {
    sections: [
      {
        id: 'export-hap',
        fields: [
          {
            key: '__hap-pair-qr',
            type: 'qr-code',
            value: 'X-HM://0023ISYWYHAPSECRET',
            caption: 'Scan with the iOS Camera app. Setup code: 123-45-678.',
          },
          { key: 'hapPin', type: 'password', value: 'device-pw-typed-field' },
        ],
      },
    ],
  }

  it('a device settings form withholds a QR code, its caption, and any password-TYPED field', () => {
    for (const path of [
      'deviceManager.getDeviceSettingsAggregate',
      'deviceManager.getSettingsSchema',
    ]) {
      const redact = NON_ADMIN_CONFIG_REDACTED_METHODS.get(path)
      if (redact === undefined) throw new Error(`${path} is not redacted`)
      const out = JSON.stringify(redact(deviceForm))
      expect(out, path).not.toContain('HAPSECRET')
      expect(out, path).not.toContain('123-45-678')
      expect(out, path).not.toContain('device-pw-typed-field')
    }
  })

  it('deviceExport.getStatus loses its setup block for a non-admin, keeps the link state', () => {
    const redact = NON_ADMIN_CONFIG_REDACTED_METHODS.get('deviceExport.getStatus')
    if (redact === undefined) throw new Error('deviceExport.getStatus is not redacted')
    const status = {
      linkState: 'linked',
      exposedDeviceCount: 3,
      setup: {
        qr: 'X-HM://0023ISYWYHAPSECRET',
        fields: [{ label: 'Ingress token', value: 'alexa-ingress-secret', secret: true }],
      },
    }
    for (const payload of [status, [status]]) {
      const out = JSON.stringify(redact(payload))
      expect(out).not.toContain('HAPSECRET')
      expect(out).not.toContain('alexa-ingress-secret')
      expect(out).toContain('"linkState":"linked"')
    }
  })
})

/**
 * Defence in depth for R2-H1 (fix round 3): the status aggregates re-served
 * `deviceExport.getStatus` — `setup` included — per device. The system fix
 * stops asking a system collection cap per device; this boundary also drops
 * a `device-export` entry's `setup` for a non-admin, in the single
 * (`Record<cap, status>`) and batch (`Record<deviceId, Record<cap, status>>`)
 * shapes, so a provider or registry change cannot reopen it.
 */
describe('status aggregates never carry the export setup to a non-admin', () => {
  const exportStatus = {
    linkState: 'linked',
    exposedDeviceCount: 3,
    setup: { qr: 'X-HM://0023ISYWYHAPSECRET' },
  }

  it('single aggregate', () => {
    const redact = NON_ADMIN_CONFIG_REDACTED_METHODS.get('deviceManager.getDeviceStatusAggregate')
    if (redact === undefined) throw new Error('getDeviceStatusAggregate is not redacted')
    const out = JSON.stringify(
      redact({ 'device-export': exportStatus, battery: { percentage: 5 } }),
    )
    expect(out).not.toContain('HAPSECRET')
    expect(out).toContain('"percentage":5')
    expect(out).toContain('"linkState":"linked"')
  })

  it('batch aggregate', () => {
    const redact = NON_ADMIN_CONFIG_REDACTED_METHODS.get(
      'deviceManager.getDeviceStatusAggregateBatch',
    )
    if (redact === undefined) throw new Error('getDeviceStatusAggregateBatch is not redacted')
    const out = JSON.stringify(
      redact({ '101': { 'device-export': exportStatus }, '102': { battery: { percentage: 9 } } }),
    )
    expect(out).not.toContain('HAPSECRET')
    expect(out).toContain('"percentage":9')
  })
})

/**
 * Round-3 sweep: the same secrets through device-ops and the integration /
 * broker listings. `deviceOps.*` is the per-device twin of the
 * `deviceManager` reads that were already redacted; the Home Assistant raw
 * state carries `access_token` and a `?token=` picture URL, contrary to the
 * provider's "display-safe" comment.
 */
describe('round-3 sweep: device-ops twins and listings', () => {
  function redactorFor(path: string): (data: unknown) => unknown {
    const redact = NON_ADMIN_CONFIG_REDACTED_METHODS.get(path)
    if (redact === undefined) throw new Error(`${path} is not redacted`)
    return redact
  }

  it('deviceOps.getConfigEntries withholds the camera password', () => {
    const out = JSON.stringify(
      redactorFor('deviceOps.getConfigEntries')([
        { key: 'host', value: '192.168.10.139' },
        { key: 'password', value: 'hunter2-not-real' },
      ]),
    )
    expect(out).not.toContain('hunter2-not-real')
    expect(out).toContain('192.168.10.139')
  })

  it('deviceOps.getSettingsSchema withholds a password-typed field', () => {
    const out = JSON.stringify(
      redactorFor('deviceOps.getSettingsSchema')({
        sections: [
          { id: 'c', fields: [{ key: 'pin', type: 'password', value: 'typed-pin-secret' }] },
        ],
      }),
    )
    expect(out).not.toContain('typed-pin-secret')
  })

  it('deviceOps.getRawState withholds a token attribute and a ?token= URL', () => {
    const out = JSON.stringify(
      redactorFor('deviceOps.getRawState')({
        source: 'homeassistant',
        data: {
          state: 'idle',
          attributes: {
            access_token: 'ha-camera-access-token',
            entity_picture: 'https://ha.local/api/camera_proxy/camera.x?token=ha-picture-token',
            friendly_name: 'Front door',
          },
        },
      }),
    )
    expect(out).not.toContain('ha-camera-access-token')
    expect(out).not.toContain('ha-picture-token')
    expect(out).toContain('Front door')
  })

  it('mqttBroker.listBrokers and integrations.* lose URL userinfo and secret-named info', () => {
    const brokers = JSON.stringify(
      redactorFor('mqttBroker.listBrokers')([{ id: 'b', url: 'mqtt://u:broker-url-pw@h:1883' }]),
    )
    expect(brokers).not.toContain('broker-url-pw')
    for (const path of ['integrations.list', 'integrations.get', 'integrations.getByAddonId']) {
      const out = JSON.stringify(
        redactorFor(path)([{ id: 'i', info: { apiKey: 'integration-api-key', host: 'nas' } }]),
      )
      expect(out, path).not.toContain('integration-api-key')
      expect(out, path).toContain('nas')
    }
  })
})
