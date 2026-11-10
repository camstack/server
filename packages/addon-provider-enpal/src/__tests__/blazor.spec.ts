import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { settingsToConnection } from '../config.js'
import { parseDeviceMessages } from '../enpal-device-page.js'
import { EnpalError, readEnpalSnapshot, type FetchLike } from '../enpal-client.js'
import {
  BlazorBridgeError,
  BlazorRowsSchema,
  blazorRowsToReadings,
  createBlazorReader,
  type BlazorReader,
} from '../enpal-blazor.js'

const FIXTURES = join(__dirname, 'fixtures')
// Captured from a real energy-manager box, firmware 8.52.2 (serial-like values masked).
const page852 = readFileSync(join(FIXTURES, 'device-messages-fw852.html'), 'utf8')
const rows = BlazorRowsSchema.parse(
  JSON.parse(readFileSync(join(FIXTURES, 'blazor-rows.json'), 'utf8')),
)

describe('parseDeviceMessages - firmware 8.52 markup', () => {
  it('reads the Site Data rows of a page whose rows are <tr class=""> under a d-flex card header', () => {
    const readings = parseDeviceMessages(page852)
    expect(readings.find((r) => r.key === 'Power.Consumption.AC')).toMatchObject({
      unit: 'W',
      measurement: 'Site Data',
    })
    expect(readings.find((r) => r.key === 'Energy.Consumption.Total.Day')).toMatchObject({
      value: 3.6,
      unit: 'kWh',
    })
    expect(readings.length).toBeGreaterThanOrEqual(4)
  })
})

describe('blazorRowsToReadings', () => {
  const readings = blazorRowsToReadings(rows)
  const get = (key: string) => readings.find((r) => r.key === key)

  it('keeps the numeric sensors of every device card, with their unit', () => {
    expect(get('Energy.Battery.Charge.Level')).toMatchObject({ value: 98.9, unit: '%' })
    expect(get('Power.DC.Total')).toMatchObject({ value: 1234, unit: 'W' })
    expect(get('Heatpump.Power.Consumption.Total')).toMatchObject({ value: 2991, unit: 'W' })
    expect(get('Power.Battery.Charge.Discharge')?.value).toBe(339)
    expect(get('Temperature.Battery')?.unit).toBe('°C')
  })

  it('drops text values, markup values and keys that are not sensors', () => {
    expect(get('Inverter.System.State')).toBeUndefined()
    expect(get('Inverter.Running.State')).toBeUndefined()
    expect(get('LTE.State')).toBeUndefined()
    expect(get('V1.1.7')).toBeUndefined()
    expect(get('Device.Name')).toBeUndefined()
  })
})

describe('readEnpalSnapshot - blazor source', () => {
  const noHttp: FetchLike = async () => {
    throw new TypeError('fetch failed')
  }
  const now = () => 5

  it('reads through the bridge in auto mode, before any token or page', async () => {
    const targets: Array<{ host: string; port: number }> = []
    const blazor: BlazorReader = async (target) => {
      targets.push(target)
      return rows
    }
    const snap = await readEnpalSnapshot({
      connection: settingsToConnection({ host: '192.0.2.10' }),
      fetch: noHttp,
      blazor,
      now,
    })
    expect(snap.source).toBe('blazor')
    expect(snap.readings.get('Energy.Battery.Charge.Level')?.value).toBe(98.9)
    expect(targets).toEqual([{ host: '192.0.2.10', port: 80 }])
  })

  it('falls back to the device page and names why when the bridge fails', async () => {
    const blazor: BlazorReader = async () => {
      throw new BlazorBridgeError('unreachable', 'cannot reach 192.0.2.10:80')
    }
    const fetchFake: FetchLike = async () => new Response(page852, { status: 200 })
    const snap = await readEnpalSnapshot({
      connection: settingsToConnection({ host: '192.0.2.10' }),
      fetch: fetchFake,
      blazor,
      now,
    })
    expect(snap.source).toBe('device-page')
    expect(snap.fallbackReason).toMatchObject({ kind: 'unreachable' })
  })

  it('refuses source=blazor when no Python bridge is available, instead of reading zeros', async () => {
    await expect(
      readEnpalSnapshot({
        connection: settingsToConnection({ host: '192.0.2.10', source: 'blazor' }),
        fetch: noHttp,
        now,
      }),
    ).rejects.toMatchObject({ name: 'EnpalError', kind: 'bridge-unavailable' })
  })

  it('a bridge that answers no sensor row is an empty read, not a snapshot', async () => {
    const err = await readEnpalSnapshot({
      connection: settingsToConnection({ host: '192.0.2.10', source: 'blazor' }),
      fetch: noHttp,
      blazor: async () => [],
      now,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EnpalError)
    expect(err).toMatchObject({ kind: 'empty', source: 'blazor' })
  })
})

describe('createBlazorReader - the process bridge', () => {
  // The bridge is language-agnostic: any executable that speaks the JSON contract works, so the
  // test runs node as the "interpreter" and needs no Python on CI.
  function script(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'enpal-bridge-'))
    const file = join(dir, 'bridge.cjs')
    writeFileSync(file, body)
    return file
  }

  it('sends host/port on stdin and returns the rows from stdout', async () => {
    const file = script(`
      let raw = ''
      process.stdin.on('data', (c) => (raw += c))
      process.stdin.on('end', () => {
        const req = JSON.parse(raw)
        process.stdout.write(JSON.stringify({ ok: true, rows: [
          { key: 'Power.DC.Total', value: String(req.port), unit: 'W', timestamp: null },
        ] }))
      })`)
    const read = createBlazorReader({ pythonPath: process.execPath, scriptPath: file })
    const out = await read({ host: '192.0.2.10', port: 8123 })
    expect(out).toEqual([{ key: 'Power.DC.Total', value: '8123', unit: 'W', timestamp: null }])
  })

  it('maps a { ok: false } answer to a typed error with the kind the bridge gave', async () => {
    const file = script(
      `process.stdout.write(JSON.stringify({ ok: false, kind: 'unreachable', error: 'cannot reach' })); process.exit(1)`,
    )
    const read = createBlazorReader({ pythonPath: process.execPath, scriptPath: file })
    await expect(read({ host: 'h', port: 80 })).rejects.toMatchObject({
      name: 'BlazorBridgeError',
      kind: 'unreachable',
    })
  })

  it('kills a bridge that never answers and reports a timeout', async () => {
    const file = script(`setTimeout(() => {}, 60000)`)
    const read = createBlazorReader({
      pythonPath: process.execPath,
      scriptPath: file,
      timeoutMs: 300,
    })
    await expect(read({ host: 'h', port: 80 })).rejects.toMatchObject({ kind: 'timeout' })
  })
})
