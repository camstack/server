import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createKiaBridge, KiaBridgeError, type KiaBridge } from '../kia-bridge.js'
import { sportageState } from './kia-fixtures.js'

const PASSWORD = 'pw-secret-1234'
const PIN = '9876'

/**
 * A Node script stands in for `python kia_worker.py`: it speaks the worker's line protocol, so
 * the real spawn, the stdio framing and the id matching run for real. It reports whether the
 * password or the PIN reached its argv or environment.
 */
const FAKE_WORKER = `
const readline = require('node:readline')
const state = ${JSON.stringify(sportageState())}
const out = (line) => process.stdout.write(JSON.stringify(line) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (text) => {
  const m = JSON.parse(text)
  if (m.op === 'login') {
    if (m.username === 'garbage@example.com') return out({ id: m.id, ok: true, result: { vehicles: 'nope' } })
    if (m.password !== ${JSON.stringify(PASSWORD)} || m.pin !== ${JSON.stringify(PIN)}) {
      return out({ id: m.id, ok: false, code: 'auth', error: 'Kia refused the account' })
    }
    const hay = process.argv.join(' ') + JSON.stringify(process.env)
    const leaked = hay.includes(m.password) || hay.includes(m.pin)
    out({ id: m.id, ok: true, result: { vehicles: [
      { vehicleId: 'veh-1', vin: null, name: 'leaked=' + leaked, model: 'Sportage', year: 2023, engineType: 'HEV', state },
    ] } })
  } else if (m.op === 'read') {
    out({ id: m.id, ok: true, result: { states: { 'veh-1': state } } })
  } else if (m.op === 'refresh') {
    if (m.vehicleId === 'asleep') return out({ id: m.id, ok: false, code: 'vehicle-unreachable', error: 'no answer' })
    out({ id: m.id, ok: true, result: { state } })
  } else if (m.op === 'command') {
    if (m.command === 'unlock') return out({ id: m.id, ok: false, code: 'rejected', error: 'car said no' })
    if (m.command === 'lock') process.exit(3)
    if (m.command === 'climate-stop') return // never answers
    out({ id: m.id, ok: true, result: { outcome: 'success', state } })
  }
})
`

const dirs: string[] = []
const bridges: KiaBridge[] = []

function make(timeouts: { commandTimeoutMs?: number } = {}): KiaBridge {
  const dir = mkdtempSync(join(tmpdir(), 'kia-bridge-'))
  dirs.push(dir)
  const scriptPath = join(dir, 'worker.cjs')
  writeFileSync(scriptPath, FAKE_WORKER)
  const bridge = createKiaBridge({ pythonPath: process.execPath, scriptPath, ...timeouts })
  bridges.push(bridge)
  return bridge
}

const CONFIG = {
  username: 'u@example.com',
  password: PASSWORD,
  pin: PIN,
  region: 'europe',
  brand: 'kia',
} as const

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Kia bridge', () => {
  it('signs in, lists the vehicles and keeps the password and the PIN out of argv and the environment', async () => {
    const vehicles = await make().login(CONFIG)
    expect(vehicles).toHaveLength(1)
    expect(vehicles[0]?.vehicleId).toBe('veh-1')
    expect(vehicles[0]?.name).toBe('leaked=false')
    expect(vehicles[0]?.state.odometerM).toBe(18_432_700)
  })

  it('names a refused sign-in with the code auth, for a wrong password and for a wrong PIN', async () => {
    for (const config of [
      { ...CONFIG, password: 'wrong' },
      { ...CONFIG, pin: '0000' },
    ]) {
      const refused = make().login(config)
      await expect(refused).rejects.toBeInstanceOf(KiaBridgeError)
      await expect(refused).rejects.toMatchObject({ code: 'auth' })
    }
  })

  it('reads the cached state of every vehicle', async () => {
    const bridge = make()
    await bridge.login(CONFIG)
    const states = await bridge.read()
    expect(states['veh-1']?.locked).toBe(true)
  })

  it('wakes one vehicle, and names the car that did not answer', async () => {
    const bridge = make()
    await bridge.login(CONFIG)
    expect((await bridge.refresh('veh-1')).fuelLevelPct).toBe(64)
    await expect(bridge.refresh('asleep')).rejects.toMatchObject({ code: 'vehicle-unreachable' })
  })

  it('surfaces a refused command with its code and a successful one with its read-back', async () => {
    const bridge = make()
    await bridge.login(CONFIG)
    await expect(bridge.command('veh-1', { command: 'unlock' })).rejects.toMatchObject({
      code: 'rejected',
    })
    const result = await bridge.command('veh-1', { command: 'climate-start', temperature: 21 })
    expect(result.outcome).toBe('success')
  })

  it('fails the pending call with exited when the worker dies', async () => {
    const bridge = make()
    await bridge.login(CONFIG)
    await expect(bridge.command('veh-1', { command: 'lock' })).rejects.toMatchObject({
      code: 'exited',
    })
  })

  it('answers a timeout when the worker stays silent', async () => {
    const bridge = make({ commandTimeoutMs: 50 })
    await bridge.login(CONFIG)
    await expect(bridge.command('veh-1', { command: 'climate-stop' })).rejects.toMatchObject({
      code: 'timeout',
    })
  })

  it('refuses an answer of an unknown shape', async () => {
    await expect(
      make().login({ ...CONFIG, username: 'garbage@example.com' }),
    ).rejects.toMatchObject({
      code: 'protocol',
    })
  })

  it('refuses a call after close', async () => {
    const bridge = make()
    await bridge.login(CONFIG)
    bridge.close()
    await expect(bridge.read()).rejects.toMatchObject({ code: 'exited' })
  })
})
