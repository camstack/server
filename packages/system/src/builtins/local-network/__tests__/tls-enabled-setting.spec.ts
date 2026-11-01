/**
 * local-network — "Serve HTTPS" (`tlsEnabled`, Network → Local access).
 *
 * The listener is built before the settings database opens, so the setting is
 * mirrored to the `tls/enabled` marker on every apply and the boot reads the
 * marker. A first boot (nothing stored) mirrors the default, HTTPS on; a stored
 * `false` mirrors off.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AddonContext, IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readTlsEnabled } from '../../../tls/tls-status.js'
import { LocalNetworkAddon } from '../local-network.addon.js'

vi.mock('../hub-mdns-ciao.js', () => ({
  createCiaoPublisher: () => ({ publish: async () => ({ stop: async () => undefined }) }),
}))

function makeLogger(): IScopedLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

async function startAddon(dataDir: string, stored: Record<string, unknown>): Promise<void> {
  const addonStore: Record<string, unknown> = { httpEnabled: false, ...stored }
  // Documented type boundary: the suite exercises only the members the settings path reads.
  const ctx = {
    id: 'local-network',
    logger: makeLogger(),
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    addonConfig: {},
    dataDir,
    kernel: { localNodeId: 'hub' },
    settings: {
      readAddonStore: vi.fn(async () => ({ ...addonStore })),
      writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
        Object.assign(addonStore, patch)
      }),
      readDeviceStore: vi.fn(async () => ({})),
      writeDeviceStore: vi.fn(async () => undefined),
      getSection: vi.fn(async () => ({ port: 4443 })),
      setSection: vi.fn(async () => undefined),
    },
  } as unknown as AddonContext
  await new LocalNetworkAddon().initialize(ctx)
}

describe('local-network tlsEnabled setting', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-network-tls-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('first boot, nothing stored: the marker says HTTPS on', async () => {
    await startAddon(dir, {})
    expect(fs.readFileSync(path.join(dir, 'tls', 'enabled'), 'utf-8').trim()).toBe('true')
    expect(readTlsEnabled(dir)).toBe(true)
  })

  it('a stored false is mirrored to the marker the boot reads', async () => {
    await startAddon(dir, { tlsEnabled: false })
    expect(fs.readFileSync(path.join(dir, 'tls', 'enabled'), 'utf-8').trim()).toBe('false')
    expect(readTlsEnabled(dir)).toBe(false)
  })
})
