import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@camstack/system', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/system')>()
  return {
    ...actual,
    retirePreviousLocalCa: () => false,
    readPendingRestart: () => null,
  }
})
vi.mock('../reconcile-lifecycle-jobs.js', () => ({
  reconcileLifecycleJobsAtBoot: async () => ({ resumed: 0, failed: 0 }),
}))

import { PostBootService } from '../post-boot.service'

let dataPath: string
const emitted: Array<{ category: string; data: Record<string, unknown> }> = []

function makeService(): PostBootService {
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }
  const bus = {
    emit: (e: { category: string; data: Record<string, unknown> }) => emitted.push(e),
  }
  const logging = { createLogger: () => logger }
  // The service only touches the bus and the logger on the path under test.
  return Reflect.construct(PostBootService, [{}, bus, logging])
}

async function boot(productVersion: string): Promise<void> {
  vi.stubEnv('CAMSTACK_PRODUCT_VERSION', productVersion)
  vi.stubEnv('CAMSTACK_NODE_ID', 'hub')
  await makeService().run({
    port: 1,
    host: 'h',
    dataPath,
    trpcRegistered: true,
  })
}

beforeEach(() => {
  dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'post-boot-image-'))
  emitted.length = 0
})
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(dataPath, { recursive: true, force: true })
})

describe('the hub announces a boot on a different container image', () => {
  it('emits node-updating material once, on the second boot with a new product version', async () => {
    await boot('1.2.10')
    expect(emitted.filter((e) => e.category === 'system.restarting')).toHaveLength(0)
    await boot('1.2.11')
    const announced = emitted.filter((e) => e.category === 'system.restarting')
    expect(announced).toHaveLength(1)
    expect(announced[0]?.data).toMatchObject({
      what: 'container-image',
      fromVersion: '1.2.10',
      toVersion: '1.2.11',
      nodeId: 'hub',
    })
    await boot('1.2.11')
    expect(emitted.filter((e) => e.category === 'system.restarting')).toHaveLength(1)
  })
})
