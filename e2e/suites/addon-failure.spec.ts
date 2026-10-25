/**
 * Addon failure surfacing — regression locks for Fix #7-#10.
 *
 * Installs the deliberately-broken fixture (`fixtures/broken-addon`) into
 * the hub's addons dir and verifies:
 *
 *   1. (Fix #7) The addon appears in `addons.list` with state='failed'
 *      — NOT silently dropped.
 *   2. (Fix #9) The AddonLoader emits a warn-level log entry tagged with
 *      the addon's id — operator gets visibility into the failure.
 *   3. (Fix #10) `integrations.getAvailableTypes` does NOT include the
 *      broken addon — picker filter rejects unloaded packages.
 *   4. The asset endpoint still resolves a (missing) icon for the broken
 *      addon via the disk-scan fallback — Fix #7 disk-scan path.
 *   5. Uninstall succeeds without error — operator can recover.
 *
 * The fixture is staged onto the hub's data dir directly (cp -R into
 * `<dataDir>/addons/@camstack/addon-broken-fixture/`) BEFORE hub spawn,
 * so the AddonInstaller sees it on first scan.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnHub, type SpawnedHub } from '../fixtures/electron.ts'
import {
  createTestDataDir,
  readLatestLogFile,
  type TestDataDir,
} from '../fixtures/test-data-dir.ts'
import {
  loginAsAdmin,
  listAddons,
  getAvailableIntegrationTypes,
  trpcMutation,
  fetchAsset,
  type AuthorizedClient,
} from '../fixtures/api-client.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FIXTURE_PACKAGE_DIR = path.resolve(__dirname, '..', 'fixtures', 'broken-addon')
const FIXTURE_PACKAGE_NAME = '@camstack/addon-broken-fixture'
const FIXTURE_ADDON_ID = 'broken-addon'

let dataDir: TestDataDir | null = null
let hub: SpawnedHub | null = null
let client: AuthorizedClient | null = null

const E2E_LIVE = process.env['CAMSTACK_E2E_LIVE'] === '1'
const desc = E2E_LIVE ? describe : describe.skip

function stageBrokenAddon(targetDataDir: string): void {
  const target = path.join(targetDataDir, 'addons', '@camstack', 'addon-broken-fixture')
  fs.mkdirSync(target, { recursive: true })
  // Shallow copy — fixture is 3 files, no node_modules.
  for (const entry of fs.readdirSync(FIXTURE_PACKAGE_DIR)) {
    const src = path.join(FIXTURE_PACKAGE_DIR, entry)
    const dst = path.join(target, entry)
    fs.copyFileSync(src, dst)
  }
}

beforeAll(async () => {
  if (!E2E_LIVE) return
  dataDir = createTestDataDir('camstack-e2e-broken-')
  stageBrokenAddon(dataDir.path)
  hub = await spawnHub({
    port: 4545,
    dataDir: dataDir.path,
    // Don't auto-install bundled addons — keep the boot lean so the failure
    // log is easy to read.
    env: { CAMSTACK_INSTALL_SOURCE: 'local' },
  })
  client = await loginAsAdmin(hub.port)
}, 120_000)

afterAll(async () => {
  if (hub) await hub.stop()
  if (dataDir) dataDir.cleanup()
})

desc('addon failure surfacing', () => {
  it('broken addon shows up with state=failed (Fix #7)', async () => {
    if (!client) throw new Error('client not initialised')
    const addons = await listAddons(client)
    const broken = addons.find((a) => a.manifest.packageName === FIXTURE_PACKAGE_NAME)
    expect(broken, 'broken addon must be visible in list').toBeDefined()
    expect(broken?.process?.state).toBe('failed')
  })

  it('AddonLoader logged the failure tagged with the addon id (Fix #9)', () => {
    if (!hub) throw new Error('hub not initialised')
    const log = readLatestLogFile(hub.dataDir)
    // Look for a warn-level line that mentions BOTH AddonLoader scope
    // AND the failing package or addon id. Either reference is acceptable
    // — the loader may log by package name OR by addon id depending on
    // where the throw happens.
    const hits = log.split('\n').filter((line) => {
      if (!line.includes('"level":"warn"') && !line.includes('"level":"error"')) return false
      if (!line.includes('AddonLoader')) return false
      return line.includes(FIXTURE_PACKAGE_NAME) || line.includes(FIXTURE_ADDON_ID)
    })
    expect(hits.length, 'expected at least one warn/error entry').toBeGreaterThan(0)
  })

  it('integrations.getAvailableTypes excludes the broken addon (Fix #10)', async () => {
    if (!client) throw new Error('client not initialised')
    const types = await getAvailableIntegrationTypes(client)
    const offender = types.find((t) => t.id === FIXTURE_ADDON_ID)
    expect(offender, 'broken addon must NOT be in the picker').toBeUndefined()
  })

  it('asset endpoint resolves an icon (or 404) for the broken addon without crashing', async () => {
    if (!hub) throw new Error('hub not initialised')
    // The fallback disk-scan should answer with either the file or a 404.
    // A 5xx would indicate the asset router crashed when looking up an
    // unloaded addon — exactly what Fix #7 was about.
    const res = await fetchAsset(
      hub.port,
      `/assets/${encodeURIComponent(FIXTURE_PACKAGE_NAME)}/icon.svg`,
    )
    expect(res.status, `unexpected ${res.status} from asset router`).toBeLessThan(500)
  })

  it('uninstall succeeds and the addon is gone', async () => {
    if (!client) throw new Error('client not initialised')
    await trpcMutation(
      client.port,
      'addons.uninstallPackage',
      { packageName: FIXTURE_PACKAGE_NAME },
      client.token,
    )
    const addons = await listAddons(client)
    const stillThere = addons.find((a) => a.manifest.packageName === FIXTURE_PACKAGE_NAME)
    expect(stillThere).toBeUndefined()
  })
})
