/**
 * D783 — a device-config secret is the one its schema DECLARES, wherever it
 * sits in the blob, and the non-admin redaction honours that declaration.
 *
 * D634 decided by key NAME, on the top level only: UniFi / VeSync / Velux /
 * Rademacher / Ecowitt / Unraid keep their credentials under `connection.*`
 * and went out whole; Tuya `localKey` and Dreame `navigationAccessCode` match
 * no keyword at all. A device now advertises `secretConfigPaths` (computed
 * from its Zod schema's `.meta({ secret: true })`), and the keyword list
 * survives only as a backstop — at any depth now.
 *
 * Also here: Reolink's stream catalog carries `rtsp://user:pass@…` and FLV
 * `&password=` URLs, persisted in the `stream-catalog` runtime slice and
 * returned by view-level reads. Those reads mask URL credentials.
 */
import { describe, expect, it } from 'vitest'
import {
  NON_ADMIN_CONFIG_REDACTED_METHODS,
  REDACTED_SECRET,
  redactDeviceInfoSecrets,
} from '../device-config-secret-redaction.js'

const PW = 'CANARY-pw-0000'
const KEY = 'CANARY-key-1111'

describe('redactDeviceInfoSecrets — declared paths (D783)', () => {
  it('withholds every declared path, nested ones included', () => {
    const row = {
      id: 9,
      secretConfigPaths: ['connection.password', 'connection.apiKey'],
      config: {
        connection: { host: '10.0.0.2', username: 'u', password: PW, apiKey: KEY, site: 'default' },
      },
    }
    const out = redactDeviceInfoSecrets(row) as typeof row
    expect(out.config.connection).toEqual({
      host: '10.0.0.2',
      username: 'u',
      password: REDACTED_SECRET,
      apiKey: REDACTED_SECRET,
      site: 'default',
    })
    expect(JSON.stringify(out)).not.toContain(PW)
  })

  it('withholds a declared key no keyword would ever catch (tuya localKey, dreame code)', () => {
    const row = {
      id: 10,
      secretConfigPaths: ['localKey', 'navigationAccessCode'],
      config: { devId: 'abc', localKey: KEY, navigationAccessCode: PW },
    }
    const out = redactDeviceInfoSecrets(row) as typeof row
    expect(out.config).toEqual({
      devId: 'abc',
      localKey: REDACTED_SECRET,
      navigationAccessCode: REDACTED_SECRET,
    })
  })

  it('walks array items (`rows[].token`)', () => {
    const row = {
      id: 11,
      secretConfigPaths: ['rows[].pin'],
      config: {
        rows: [
          { name: 'a', pin: PW },
          { name: 'b', pin: '' },
        ],
      },
    }
    const out = redactDeviceInfoSecrets(row) as typeof row
    expect(out.config.rows).toEqual([
      { name: 'a', pin: REDACTED_SECRET },
      { name: 'b', pin: '' },
    ])
  })

  it('keeps an empty declared secret empty — "unset" must not read as "configured"', () => {
    const out = redactDeviceInfoSecrets({
      id: 12,
      secretConfigPaths: ['localKey'],
      config: { localKey: '' },
    }) as { config: Record<string, unknown> }
    expect(out.config['localKey']).toBe('')
  })

  it('does not mutate the input', () => {
    const row = {
      id: 13,
      secretConfigPaths: ['connection.password'],
      config: { connection: { password: PW } },
    }
    const before = JSON.stringify(row)
    redactDeviceInfoSecrets(row)
    expect(JSON.stringify(row)).toBe(before)
  })

  it('the keyword backstop now reaches nested keys of a row that declares nothing', () => {
    const out = redactDeviceInfoSecrets({
      id: 14,
      config: { connection: { host: 'h', password: PW, apiKey: KEY } },
    }) as { config: { connection: Record<string, unknown> } }
    expect(out.config.connection['password']).toBe(REDACTED_SECRET)
    expect(out.config.connection['apiKey']).toBe(REDACTED_SECRET)
    expect(out.config.connection['host']).toBe('h')
  })

  it('a non-secret URL in the config loses its userinfo', () => {
    const out = redactDeviceInfoSecrets({
      id: 15,
      config: { streamUrl: `rtsp://admin:${PW}@10.0.0.3:554/main` },
    }) as { config: Record<string, unknown> }
    expect(String(out.config['streamUrl'])).not.toContain(PW)
  })
})

describe('Reolink stream-catalog URLs on view-level reads (D783)', () => {
  const descriptors = [
    {
      camStreamId: 'rtsp-0-main',
      kind: 'pull-rtsp',
      url: `rtsp://admin:${PW}@10.0.0.5:554/h264Preview_01_main`,
    },
    {
      camStreamId: 'flv-0-main',
      kind: 'pull-flv',
      url: `http://10.0.0.5/flv?port=1935&app=bcs&stream=channel0_main.bcs&user=admin&password=${PW}`,
    },
  ]
  const slice = { descriptors, lastFetchedAt: 1 }

  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['streamCatalog.getCatalog', descriptors],
    ['deviceState.getCapSlice', slice],
    ['deviceState.getSnapshot', { 'stream-catalog': slice }],
    ['deviceState.getAllSnapshots', { '102': { 'stream-catalog': slice } }],
    ['deviceManager.getDeviceStatusAggregate', { 'stream-catalog': slice }],
    ['deviceManager.getDeviceStatusAggregateBatch', { '102': { 'stream-catalog': slice } }],
  ]

  it.each(cases)('%s masks user:pass@ and &password= in every URL', (method, payload) => {
    const redactor = NON_ADMIN_CONFIG_REDACTED_METHODS.get(method)
    expect(redactor, `${method} is not redacted for non-admins`).toBeDefined()
    const out = JSON.stringify(redactor!(payload))
    expect(out).not.toContain(PW)
    expect(out).toContain('10.0.0.5')
    expect(out).toContain('channel0_main.bcs')
  })

  it('leaves non-URL values of a state slice alone', () => {
    const redactor = NON_ADMIN_CONFIG_REDACTED_METHODS.get('deviceState.getCapSlice')!
    expect(redactor({ value: 21.5, unit: '°C', eventTypeTokens: ['a'] })).toEqual({
      value: 21.5,
      unit: '°C',
      eventTypeTokens: ['a'],
    })
  })
})
