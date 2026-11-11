/**
 * The process bridge, run against small Node scripts standing in for the Python worker
 * (`process.execPath` is the interpreter): the answer contract, the timeout, and where the
 * access token travels.
 */
import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHomeComBridge, HomeComBridgeError, type HomeComSpawn } from '../homecom-bridge.js'
import { resolveHomeComWorker } from '../homecom-python-paths.js'
import { k40Reading } from './homecom-bridge-fixture.js'

const TOKEN = 'eyJ-secret-access-token'
const TARGET = { token: TOKEN, gatewayId: 'g1', deviceType: 'k40' } as const

function script(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'homecom-bridge-'))
  const file = join(dir, 'worker.cjs')
  writeFileSync(file, body)
  return file
}

/** A worker that keeps what it was given (stdin, argv, env) in `seen` and answers `answer`. */
function recordingWorker(answer: unknown): { file: string; seen: string } {
  const seen = join(mkdtempSync(join(tmpdir(), 'homecom-seen-')), 'seen.json')
  const file = script(`
    let input = ''
    process.stdin.on('data', (c) => { input += c })
    process.stdin.on('end', () => {
      require('node:fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify({
        stdin: input, argv: process.argv, env: process.env,
      }))
      process.stdout.write(${JSON.stringify(JSON.stringify(answer))})
    })
  `)
  return { file, seen }
}

async function failureOf(run: Promise<unknown>): Promise<HomeComBridgeError> {
  try {
    await run
  } catch (error) {
    if (error instanceof HomeComBridgeError) return error
    throw error
  }
  throw new Error('expected the bridge to fail')
}

describe('HomeCom bridge - the answer contract', () => {
  it('finds the bundled worker from the source tree', () => {
    expect(readFileSync(resolveHomeComWorker(), 'utf8')).toContain('homecom_alt')
  })

  it('returns the reading the worker answered', async () => {
    const { file } = recordingWorker({ ok: true, reading: k40Reading() })
    const bridge = createHomeComBridge({
      pythonPath: process.execPath,
      scriptPath: file,
    })
    expect(await bridge.read(TARGET)).toEqual(k40Reading())
  })

  it('names a malformed answer as a protocol failure, with a stderr tail', async () => {
    const file = script(`process.stderr.write('Traceback: boom'); process.stdout.write('not json')`)
    const bridge = createHomeComBridge({
      pythonPath: process.execPath,
      scriptPath: file,
    })
    const error = await failureOf(bridge.read(TARGET))
    expect(error.kind).toBe('protocol')
    expect(error.message).toContain('boom')
  })

  it('names an answer of an unknown shape as a protocol failure', async () => {
    const { file } = recordingWorker({
      ok: true,
      reading: { heatSource: 'x' },
    })
    const bridge = createHomeComBridge({
      pythonPath: process.execPath,
      scriptPath: file,
    })
    expect((await failureOf(bridge.read(TARGET))).kind).toBe('protocol')
  })

  it('carries the kind the worker named, auth included', async () => {
    const { file } = recordingWorker({
      ok: false,
      kind: 'auth',
      error: 'refused',
    })
    const bridge = createHomeComBridge({
      pythonPath: process.execPath,
      scriptPath: file,
    })
    expect((await failureOf(bridge.read(TARGET))).kind).toBe('auth')
  })

  it('kills a worker that does not answer in time and names the timeout', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'homecom-pid-')), 'pid')
    const file = script(
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000)`,
    )
    const bridge = createHomeComBridge({
      pythonPath: process.execPath,
      scriptPath: file,
      readTimeoutMs: 1500,
    })
    expect((await failureOf(bridge.read(TARGET))).kind).toBe('timeout')
    const pid = Number(readFileSync(pidFile, 'utf8'))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('requires the worker to confirm the op it wrote', async () => {
    const { file } = recordingWorker({ ok: true, written: 'awayMode' })
    const bridge = createHomeComBridge({
      pythonPath: process.execPath,
      scriptPath: file,
    })
    await expect(bridge.write(TARGET, { op: 'awayMode', value: 'on' })).resolves.toBeUndefined()
    const error = await failureOf(bridge.write(TARGET, { op: 'silentMode', value: 'on' }))
    expect(error.kind).toBe('protocol')
  })
})

describe('HomeCom bridge - the access token travels only on stdin', () => {
  it('spawns the worker with the script as the only argument and no token in the options', async () => {
    const { file } = recordingWorker({ ok: true, written: 'awayMode' })
    const calls: {
      command: string
      args: readonly string[]
      options: SpawnOptionsWithoutStdio
    }[] = []
    const spawnFn: HomeComSpawn = (command, args, options) => {
      calls.push({ command, args, options })
      return spawn(command, [...args], options)
    }
    const bridge = createHomeComBridge({
      pythonPath: process.execPath,
      scriptPath: file,
      spawnFn,
    })
    await bridge.write(TARGET, { op: 'awayMode', value: 'on' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual([file])
    expect(JSON.stringify(calls[0])).not.toContain(TOKEN)
  })

  it('hands the worker the token on stdin and nowhere in its argv or environment', async () => {
    const { file, seen } = recordingWorker({ ok: true, reading: k40Reading() })
    const bridge = createHomeComBridge({
      pythonPath: process.execPath,
      scriptPath: file,
    })
    await bridge.read(TARGET)
    const got: unknown = JSON.parse(readFileSync(seen, 'utf8'))
    if (typeof got !== 'object' || got === null || !('stdin' in got)) throw new Error('no record')
    const { stdin, ...rest } = got
    expect(JSON.parse(String(stdin))).toEqual({ ...TARGET, action: 'read' })
    expect(JSON.stringify(rest)).not.toContain(TOKEN)
  })
})
