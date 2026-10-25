/**
 * sqlite-settings IS the engine behind `settings-store`. `BaseAddon.initialize`
 * always `await`s `resolveConfig()` → `ctx.settings.readAddonStore()`, and
 * that round-trip goes to the parent door. On an isolated engine the parent
 * has not built the door yet — it is waiting for THIS child's post-init
 * handshake. The live hub (1.2.152) spent the whole 30 s wait budget on that
 * cycle: sqlite hung in `resolveConfig`, the parent timed out, every
 * in-process builtin skipped the empty door, then sqlite finished one
 * second later. Useless.
 *
 * Mutation: delete the `resolveConfig` override on `SqliteSettingsAddon` and
 * this fails — initialize never returns while the door hangs.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddonContext, IScopedLogger } from '@camstack/types'
import { SqliteSettingsAddon } from '../sqlite-settings.addon.js'

const tmpDirs: string[] = []

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

describe('isolated engine initialize does not wait on the door', () => {
  it('finishes even when settings-store never answers', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-engine-init-'))
    tmpDirs.push(dir)
    let doorCalls = 0
    const addon = new SqliteSettingsAddon()
    const ctx = {
      id: 'sqlite-settings',
      dataDir: dir,
      logger: makeLogger(),
      settings: {
        readAddonStore: async () => {
          doorCalls += 1
          await new Promise<never>(() => undefined)
          return {}
        },
      },
    }
    const started = Date.now()
    const result = await addon.initialize(ctx as unknown as AddonContext)
    expect(Date.now() - started).toBeLessThan(8_000)
    expect(doorCalls).toBe(0)
    const providers = result && 'providers' in result && result.providers ? result.providers : []
    expect(providers.map((p) => p.capability.name)).toEqual([
      'data-store-provider',
      'records',
      'vector-store',
      'database-snapshot',
      'storage-admin',
    ])
    await addon.shutdown()
  })
})
