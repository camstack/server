/**
 * The FORKED settings view's three-way read (D651 fix round 4): an `api` with
 * no `settingsStore` router is a read that could not happen, so it is
 * `failed` — never `missing`. `missing` would tell `readStoredGlobalKey`
 * "nobody wrote this key", and the owner would answer the default BY ABSENCE
 * from a store it never reached.
 *
 * The real `api` is a tRPC proxy that answers a router for any name, so the
 * unwired branch is reached only by replacing the client here.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AddonDeclaration } from '@camstack/types'
import { ServiceBroker } from 'moleculer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAddonContext,
  registerEventBusService,
} from '../../moleculer/addon-context-factory.js'

vi.mock('@trpc/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@trpc/client')>()
  return { ...original, createTRPCClient: () => ({}) }
})

describe('forked AddonSettingsView.readAddonStoreResult without a settingsStore router', () => {
  let broker: ServiceBroker
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-unwired-'))
    broker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    registerEventBusService(broker)
    await broker.start()
  })

  afterEach(async () => {
    await broker.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('is FAILED, never missing', async () => {
    const declaration: AddonDeclaration = { id: 'test-addon', entry: './dist/index.js' }
    const ctx = await createAddonContext(broker, declaration, tmpDir)
    expect(await ctx.settings?.readAddonStoreResult?.()).toEqual({
      kind: 'failed',
      error: 'settings store not wired',
    })
  })
})
