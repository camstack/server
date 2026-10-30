import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'
import { afterAll, describe, expect, it } from 'vitest'
import viteConfig from '../../vite.config.ts'
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

describe('the shipped bundle', () => {
  it('talks to a gateway: every wire frame resolves without a file next to the bundle', async () => {
    rmSync(OUT_DIR, { recursive: true, force: true })
    mkdirSync(OUT_DIR, { recursive: true })
    await build({
      ...viteConfig,
      configFile: false,
      root: PACKAGE_ROOT,
      logLevel: 'silent',
      build: { ...viteConfig.build, outDir: OUT_DIR, emptyOutDir: true },
    })

    const bundle: Record<string, unknown> = await import(
      pathToFileURL(join(OUT_DIR, 'index.mjs')).href
    )
    const Bundled = bundle['KlfGatewayClient']
    if (!isClientConstructor(Bundled)) throw new Error('bundle does not export KlfGatewayClient')

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
})
