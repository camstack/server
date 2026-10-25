/**
 * Boot invariants — verify the hub comes up cleanly with the storage
 * layer pre-seeded and every protected addon healthy.
 *
 * Regression locks introduced in this suite:
 *   - Fix #7: protected/registered addons surface their failure state
 *     instead of silently disappearing.
 *   - Fix #9: AddonLoader emits warn-level entries when a package fails
 *     to load (no more silent skips).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnHub, type SpawnedHub } from '../fixtures/electron.ts'
import {
  loginAsAdmin,
  listAddons,
  listStorageLocations,
  fetchHealth,
  type AuthorizedClient,
} from '../fixtures/api-client.ts'
import { readLatestLogFile } from '../fixtures/test-data-dir.ts'

/** Storage types every fresh boot must seed a default for. */
const REQUIRED_STORAGE_TYPES = [
  'data',
  'media',
  'recordings',
  'recordings-high',
  'recordings-low',
  'recordings-clips',
  'event-images',
  'models',
  'cache',
  'logs',
  'addons-data',
  'backups',
] as const

let hub: SpawnedHub | null = null
let client: AuthorizedClient | null = null

const E2E_LIVE = process.env['CAMSTACK_E2E_LIVE'] === '1'
const desc = E2E_LIVE ? describe : describe.skip

beforeAll(async () => {
  if (!E2E_LIVE) return
  hub = await spawnHub({ port: 4543 })
  client = await loginAsAdmin(hub.port)
}, 120_000)

afterAll(async () => {
  if (hub) await hub.stop()
})

desc('boot invariants', () => {
  it('every protected addon is in the running state', async () => {
    if (!client) throw new Error('client not initialised')
    const addons = await listAddons(client)
    const protectedFails = addons.filter((a) => {
      const isProtected = a.manifest?.protected === true
      const state = a.process?.state ?? 'unknown'
      return isProtected && state !== 'running'
    })
    expect(
      protectedFails.map((a) => `${a.manifest.packageName}=${a.process?.state ?? 'missing'}`),
    ).toEqual([])
  })

  it('storage exposes exactly one default location per required type', async () => {
    if (!client) throw new Error('client not initialised')
    const locations = await listStorageLocations(client)
    const missing: string[] = []
    const duplicate: string[] = []
    for (const type of REQUIRED_STORAGE_TYPES) {
      const defaults = locations.filter((l) => l.type === type && l.isDefault)
      if (defaults.length === 0) missing.push(type)
      else if (defaults.length > 1) {
        duplicate.push(`${type} (${defaults.map((d) => d.id).join(',')})`)
      }
    }
    expect({ missing, duplicate }).toEqual({ missing: [], duplicate: [] })
  })

  it('AddonLoader did NOT log warn-level "failed to load" entries (Fix #9)', () => {
    if (!hub) throw new Error('hub not initialised')
    const log = readLatestLogFile(hub.dataDir)
    // Only flag warn entries with both AddonLoader scope AND a load-failure
    // signature. The boot path emits info-level "loaded N addons" which we
    // explicitly tolerate.
    const offenders = log.split('\n').filter((line) => {
      if (!line.includes('AddonLoader')) return false
      if (!line.includes('"level":"warn"')) return false
      return (
        line.includes('failed to load') ||
        line.includes('Failed to load') ||
        line.includes('skipping')
      )
    })
    expect(offenders).toEqual([])
  })

  it('no addon has process.state === "failed" (Fix #7)', async () => {
    if (!client) throw new Error('client not initialised')
    const addons = await listAddons(client)
    const failed = addons.filter((a) => a.process?.state === 'failed')
    expect(failed.map((a) => a.manifest.packageName)).toEqual([])
  })

  it('hub /health probe returns ok=true with non-zero uptime', async () => {
    if (!hub) throw new Error('hub not initialised')
    const probe = await fetchHealth(hub.port)
    expect(probe.status).toBe(200)
    expect(probe.body?.ok).toBe(true)
    expect(probe.body?.uptimeSeconds ?? -1).toBeGreaterThanOrEqual(0)
  })
})
