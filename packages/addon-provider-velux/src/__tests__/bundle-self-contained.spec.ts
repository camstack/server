import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { KlfGatewayClient } from '../klf-gateway-client.js'
import { FakeKlfGateway, type FakeNode } from './fake-klf-gateway.js'
import { RecordingLogger } from './recording-logger.js'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT_DIR = join(PACKAGE_ROOT, 'node_modules', '.cache', 'velux-bundle-spec')

const PASSWORD = 'correct-horse'
const SHUTTER: FakeNode = {
  nodeId: 1,
  name: 'Tapparella',
  actuatorType: 2,
  actuatorSubType: 0,
  serialHex: '1a1b1c1d1e1f2021',
  positionRaw: 0,
}

function isClientConstructor(value: unknown): value is typeof KlfGatewayClient {
  return typeof value === 'function'
}

afterAll(() => {
  rmSync(OUT_DIR, { recursive: true, force: true })
})

let bundle: Record<string, unknown> = {}

beforeAll(async () => {
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })
  // The package's own vite.config.ts, exactly as `npm run build` reads it.
  await build({
    configFile: join(PACKAGE_ROOT, 'vite.config.ts'),
    root: PACKAGE_ROOT,
    logLevel: 'silent',
    build: { outDir: OUT_DIR, emptyOutDir: true },
  })
  bundle = await import(pathToFileURL(join(OUT_DIR, 'index.mjs')).href)
}, 60_000)

function bundledClient(): typeof KlfGatewayClient {
  const Bundled = bundle['KlfGatewayClient']
  if (!isClientConstructor(Bundled)) throw new Error('bundle does not export KlfGatewayClient')
  return Bundled
}

describe('the shipped bundle', () => {
  it('talks to a gateway: every wire frame resolves without a file next to the bundle', async () => {
    const Bundled = bundledClient()
    const gateway = new FakeKlfGateway(PASSWORD, [SHUTTER])
    const { certPem } = await gateway.start()
    const client = new Bundled({
      host: '127.0.0.1',
      password: PASSWORD,
      logger: new RecordingLogger(),
      tls: { ca: [certPem], checkServerIdentity: () => undefined },
    })
    try {
      await client.connect()
      expect(client.listNodes().map((n) => n.name)).toEqual(['Tapparella'])
    } finally {
      await client.disconnect()
      await gateway.stop()
    }
  }, 60_000)

  it('routes the library diagnostics to the addon sink instead of the console', async () => {
    const Bundled = bundledClient()
    const setSink = bundle['setKlfLibraryLogSink']
    if (typeof setSink !== 'function') throw new Error('bundle does not export the sink setter')
    const received: string[] = []
    setSink((_level: string, message: string) => received.push(message))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const client = new Bundled({
      host: '127.0.0.1',
      password: PASSWORD,
      logger: new RecordingLogger(),
    })
    try {
      // Nothing listens on the gateway port: the library logs from its login error handler.
      await expect(client.connect()).rejects.toThrow()
      expect(received.length).toBeGreaterThan(0)
      expect(consoleError).not.toHaveBeenCalled()
      expect(consoleWarn).not.toHaveBeenCalled()
    } finally {
      setSink(null)
      consoleError.mockRestore()
      consoleWarn.mockRestore()
    }
  }, 60_000)
})
