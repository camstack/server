import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDreoBridge,
  DreoBridgeError,
  type DreoBridge,
  type DreoPush,
} from '../dreo-bridge.js'

const PASSWORD = 'pw-secret-1234'

/**
 * A Node script stands in for `python dreo_worker.py` (the same technique as the Bosch bridge
 * spec): it speaks the worker's line protocol, so the real spawn, the stdio framing and the
 * id matching run for real. It reports whether the password reached its argv or environment.
 */
const FAKE_WORKER = `
const readline = require('node:readline')
const state = (on) => ({ on, speed: 2, speedMin: 1, speedMax: 4, oscillating: false,
  temperature: null, humidity: null, pm25: null, connected: true })
const out = (line) => process.stdout.write(JSON.stringify(line) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (text) => {
  const m = JSON.parse(text)
  if (m.op === 'login') {
    if (m.email === 'garbage@example.com') return out({ id: m.id, ok: true, result: { devices: 'nope' } })
    if (m.password !== ${JSON.stringify(PASSWORD)}) {
      return out({ id: m.id, ok: false, code: 'auth', error: 'Dreo refused the account' })
    }
    const leaked = process.argv.join(' ').includes(m.password) || JSON.stringify(process.env).includes(m.password)
    out({ id: m.id, ok: true, result: { devices: [
      { deviceId: 'dev-1', model: 'DR-HAF001S', name: 'leaked=' + leaked, supported: true, state: state(false) },
    ] } })
    out({ push: 'channel', state: 'up' })
    out({ push: 'state', deviceId: 'dev-1', state: state(true) })
  } else if (m.op === 'command') {
    if (m.value === 99) return out({ id: m.id, ok: false, code: 'rejected', error: 'device said no' })
    if (m.value === -1) process.exit(3)
    if (m.value === 7) return // never answers
    out({ id: m.id, ok: true, result: {} })
  } else if (m.op === 'refresh') {
    out({ id: m.id, ok: true, result: { states: { 'dev-1': state(true) } } })
  }
})
`

const dirs: string[] = []
const bridges: DreoBridge[] = []

function make(timeouts: { commandTimeoutMs?: number } = {}): {
  bridge: DreoBridge
  pushes: DreoPush[]
} {
  const dir = mkdtempSync(join(tmpdir(), 'dreo-bridge-'))
  dirs.push(dir)
  const scriptPath = join(dir, 'worker.cjs')
  writeFileSync(scriptPath, FAKE_WORKER)
  const bridge = createDreoBridge({ pythonPath: process.execPath, scriptPath, ...timeouts })
  bridges.push(bridge)
  const pushes: DreoPush[] = []
  bridge.onPush((push) => pushes.push(push))
  return { bridge, pushes }
}

const CONFIG = { email: 'u@example.com', password: PASSWORD, region: 'eu' } as const

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) await new Promise((r) => setTimeout(r, 10))
  expect(condition()).toBe(true)
}

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Dreo bridge', () => {
  it('signs in, lists the devices and keeps the password out of argv and the environment', async () => {
    const { bridge } = make()
    const devices = await bridge.login(CONFIG)
    expect(devices).toHaveLength(1)
    expect(devices[0]?.deviceId).toBe('dev-1')
    expect(devices[0]?.name).toBe('leaked=false')
  })

  it('names a refused sign-in with the code auth', async () => {
    const { bridge } = make()
    const refused = bridge.login({ ...CONFIG, password: 'wrong' })
    await expect(refused).rejects.toBeInstanceOf(DreoBridgeError)
    await expect(refused).rejects.toMatchObject({ code: 'auth' })
  })

  it('delivers the worker pushes: the channel and a device state', async () => {
    const { bridge, pushes } = make()
    await bridge.login(CONFIG)
    await until(() => pushes.some((p) => p.push === 'state'))
    expect(pushes).toContainEqual({ push: 'channel', state: 'up' })
    const state = pushes.find((p) => p.push === 'state')
    expect(state).toMatchObject({ deviceId: 'dev-1', state: { on: true, speedMax: 4 } })
  })

  it('reads every device again on refresh', async () => {
    const { bridge } = make()
    await bridge.login(CONFIG)
    const states = await bridge.refresh()
    expect(states['dev-1']?.on).toBe(true)
  })

  it('surfaces a refused command with its code', async () => {
    const { bridge } = make()
    await bridge.login(CONFIG)
    await expect(bridge.command('dev-1', { command: 'speed', value: 3 })).resolves.toBeUndefined()
    await expect(bridge.command('dev-1', { command: 'speed', value: 99 })).rejects.toMatchObject({
      code: 'rejected',
    })
  })

  it('fails the pending call and reports exited when the worker dies', async () => {
    const { bridge, pushes } = make()
    await bridge.login(CONFIG)
    await expect(bridge.command('dev-1', { command: 'speed', value: -1 })).rejects.toMatchObject({
      code: 'exited',
    })
    await until(() => pushes.some((p) => p.push === 'exited'))
  })

  it('answers a timeout when the worker stays silent', async () => {
    const { bridge } = make({ commandTimeoutMs: 50 })
    await bridge.login(CONFIG)
    await expect(bridge.command('dev-1', { command: 'speed', value: 7 })).rejects.toMatchObject({
      code: 'timeout',
    })
  })

  it('refuses an answer of an unknown shape', async () => {
    const { bridge } = make()
    await expect(bridge.login({ ...CONFIG, email: 'garbage@example.com' })).rejects.toMatchObject({
      code: 'protocol',
    })
  })

  it('refuses a call after close', async () => {
    const { bridge } = make()
    await bridge.login(CONFIG)
    bridge.close()
    await expect(bridge.refresh()).rejects.toMatchObject({ code: 'exited' })
  })
})
