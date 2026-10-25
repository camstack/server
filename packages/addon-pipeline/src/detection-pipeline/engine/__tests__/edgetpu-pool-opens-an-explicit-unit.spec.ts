/**
 * An edgetpu pool opens its libedgetpu delegate on an EXPLICIT unit.
 *
 * The pool's `device` is the device-key suffix (`usb`, `usb:1`, `pci`,
 * `pci:1`). A bare `usb`/`pci` — or none — means "the first Edge TPU of any
 * bus" to libedgetpu, so on a node with a USB and a PCIe Coral two pools could
 * open the same unit. The startup config sent to the Python worker therefore
 * carries the ordinal string (`usb:0`, `pci:0`, `pci:1`), while the pool keeps
 * naming itself by the key suffix it was built for.
 */
import { EventEmitter } from 'node:events'
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

const spawned: FakeChild[] = []

class FakeChild extends EventEmitter {
  readonly written: Buffer[] = []
  readonly stdin = {
    write: (chunk: Buffer): boolean => {
      this.written.push(chunk)
      return true
    },
  }
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly pid = 4243
  kill = vi.fn()
}

vi.mock('node:child_process', () => ({
  spawn: () => {
    const c = new FakeChild()
    spawned.push(c)
    return c
  },
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, existsSync: () => true }
})

function silentLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

/** Start a pool and return the JSON startup config its worker received. */
async function startupConfig(
  runtime: 'edgetpu' | 'openvino',
  device: string,
): Promise<Record<string, unknown>> {
  const mod = await import('../shared-inference-pool.js')
  const before = spawned.length
  const pool = new mod.SharedInferencePool('/usr/bin/python3', runtime, silentLogger(), {
    numWorkers: 1,
    device,
  })
  const init = pool.initialize([])
  const child = spawned[before]
  if (child === undefined) throw new Error('no worker spawned')
  const json = Buffer.from(JSON.stringify({ status: 'ready', models: [] }), 'utf8')
  const frame = Buffer.allocUnsafe(8 + json.length)
  frame.writeUInt32LE(4 + json.length, 0)
  frame.writeUInt32LE(0, 4)
  json.copy(frame, 8)
  child.stdout.emit('data', frame)
  await init
  const payload = child.written.find((b) => b.length > 0 && b[0] === 0x7b)
  if (payload === undefined) throw new Error('no startup config written')
  const parsed: unknown = JSON.parse(payload.toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null) throw new Error('config is not an object')
  return Object.fromEntries(Object.entries(parsed))
}

describe('edgetpu pool startup device', () => {
  it.each([
    ['usb', 'usb:0'],
    ['usb:1', 'usb:1'],
    ['pci', 'pci:0'],
    ['pci:1', 'pci:1'],
  ])('key device %s → delegate device %s', async (device, expected) => {
    expect((await startupConfig('edgetpu', device))['device']).toBe(expected)
  })

  it('a non-edgetpu pool keeps its device verbatim', async () => {
    expect((await startupConfig('openvino', 'npu'))['device']).toBe('npu')
  })
})
