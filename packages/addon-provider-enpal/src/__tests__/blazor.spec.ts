import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { settingsToConnection } from '../config.js'
import { parseDeviceMessages } from '../enpal-device-page.js'
import { EnpalError, readEnpalSnapshot, type FetchLike } from '../enpal-client.js'
import { EnpalIntegrationManager } from '../enpal-integration-manager.js'
import {
  BLAZOR_BACKOFF_MS,
  BlazorBackoff,
  BlazorBridgeError,
  effectivePollIntervalMs,
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

describe('auto - Blazor back-off and missing Python', () => {
  const pageFetch: FetchLike = async () => new Response(page852, { status: 200 })
  const down: BlazorReader = async () => {
    throw new BlazorBridgeError('empty', 'the box rendered no sensor rows')
  }
  const connection = settingsToConnection({ host: '192.0.2.10' })

  it('skips a Blazor channel that failed, for the back-off window, and says so', async () => {
    const backoff = new BlazorBackoff()
    let calls = 0
    const blazor: BlazorReader = async (t) => {
      calls += 1
      return down(t)
    }
    const read = (at: number) =>
      readEnpalSnapshot({ connection, fetch: pageFetch, blazor, blazorBackoff: backoff, now: () => at })

    const first = await read(1_000)
    expect(first.source).toBe('device-page')
    expect(calls).toBe(1)

    const second = await read(1_000 + 30_000)
    expect(calls).toBe(1)
    expect(second.fallbackReason).toMatchObject({ kind: 'empty' })
    expect(second.fallbackReason?.message).toContain('skipped')

    await read(1_000 + BLAZOR_BACKOFF_MS + 1)
    expect(calls).toBe(2)
  })

  it('a good read clears the back-off', async () => {
    const backoff = new BlazorBackoff()
    backoff.failed(0, { kind: 'empty', message: 'x' })
    const snap = await readEnpalSnapshot({
      connection,
      fetch: pageFetch,
      blazor: async () => rows,
      blazorBackoff: backoff,
      now: () => BLAZOR_BACKOFF_MS + 1,
    })
    expect(snap.source).toBe('blazor')
    expect(backoff.skipReason(BLAZOR_BACKOFF_MS + 2)).toBeNull()
  })

  it('source=blazor ignores the back-off: the operator asked for that channel', async () => {
    const backoff = new BlazorBackoff()
    backoff.failed(0, { kind: 'empty', message: 'x' })
    const snap = await readEnpalSnapshot({
      connection: settingsToConnection({ host: '192.0.2.10', source: 'blazor' }),
      fetch: pageFetch,
      blazor: async () => rows,
      blazorBackoff: backoff,
      now: () => 5,
    })
    expect(snap.source).toBe('blazor')
  })

  it('names a missing Python as the reason the page was read', async () => {
    const snap = await readEnpalSnapshot({ connection, fetch: pageFetch, now: () => 1 })
    expect(snap.source).toBe('device-page')
    expect(snap.fallbackReason?.kind).toBe('bridge-unavailable')
    expect(snap.fallbackReason?.message).toMatch(/Python is not available/)
  })

  it('keeps the real failure kind when Python is missing AND InfluxDB failed', async () => {
    const snap = await readEnpalSnapshot({
      connection: settingsToConnection({ host: '192.0.2.10', token: 't' }),
      fetch: async (url) =>
        url.includes(':8086') ? new Response('no', { status: 401 }) : pageFetch(url),
      now: () => 1,
    })
    expect(snap.fallbackReason?.kind).toBe('unauthorized')
    expect(snap.fallbackReason?.message).toMatch(/Python is not available/)
  })
})

describe('effectivePollIntervalMs', () => {
  it('raises a short interval above the worst-case Blazor read, only where it can be used', () => {
    const at = (patch: Record<string, unknown>) =>
      effectivePollIntervalMs(settingsToConnection({ host: 'h', pollIntervalMs: 10_000, ...patch }))
    expect(at({})).toBeGreaterThanOrEqual(20_000)
    expect(at({ source: 'blazor' })).toBeGreaterThanOrEqual(20_000)
    expect(at({ source: 'influx' })).toBe(10_000)
    expect(at({ source: 'page' })).toBe(10_000)
    expect(at({ pollIntervalMs: 60_000 })).toBe(60_000)
  })
})

describe('EnpalIntegrationManager - source changes are logged', () => {
  function recordingLogger() {
    const lines: Array<{ level: string; message: string }> = []
    const at =
      (level: string) =>
      (message: string): void => {
        lines.push({ level, message })
      }
    const logger: IScopedLogger = {
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
      child: () => logger,
      withTags: () => logger,
    }
    return { logger, lines }
  }

  it('warns when a connected box drops from the web channel to the page, and once only', async () => {
    const rec = recordingLogger()
    let healthy = true
    let clock = 0
    const manager = new EnpalIntegrationManager({
      id: 'enpal:1',
      name: 'Enpal',
      connection: settingsToConnection({ host: '192.0.2.10' }),
      tokenLocked: false,
      logger: rec.logger,
      fetch: async () => new Response(page852, { status: 200 }),
      blazor: () => async () => {
        if (!healthy) throw new BlazorBridgeError('unreachable', 'cannot reach the box')
        return rows
      },
      now: () => clock,
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onPolled: () => undefined,
    })
    await manager.start()
    expect(manager.getSnapshot()?.source).toBe('blazor')
    expect(rec.lines.filter((l) => l.level === 'warn')).toHaveLength(0)

    healthy = false
    clock += 30_000
    await manager.poll()
    clock += 30_000
    await manager.poll()
    const warns = rec.lines.filter((l) => l.level === 'warn' && l.message.includes('preferred source'))
    expect(warns).toHaveLength(1)
    expect(warns[0]?.message).toContain('cannot reach the box')
    expect(warns[0]?.message).toContain('device-page')
    await manager.stop()
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

  it('kills a bridge whose output grows without bound', async () => {
    const file = script(
      `const chunk = 'x'.repeat(1 << 20); const t = setInterval(() => process.stdout.write(chunk), 5); setTimeout(() => clearInterval(t), 20000)`,
    )
    const read = createBlazorReader({ pythonPath: process.execPath, scriptPath: file, timeoutMs: 15000 })
    const started = Date.now()
    await expect(read({ host: 'h', port: 80 })).rejects.toMatchObject({ kind: 'protocol' })
    expect(Date.now() - started).toBeLessThan(10000)
  })

  it('kills a bridge that never answers and reports a timeout', async () => {
    const pidFile = `${script('')}.pid`
    const file = script(
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000)`,
    )
    const read = createBlazorReader({
      pythonPath: process.execPath,
      scriptPath: file,
      timeoutMs: 1500,
    })
    await expect(read({ host: 'h', port: 80 })).rejects.toMatchObject({ kind: 'timeout' })
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(pid).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const alive = (() => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    })()
    if (alive) process.kill(pid, 'SIGKILL')
    expect(alive).toBe(false)
  })
})
