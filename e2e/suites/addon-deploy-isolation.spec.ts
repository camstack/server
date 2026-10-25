/**
 * Addon-deploy isolation — a tarball upload must restart ONLY the
 * uploaded addon's group runner, never cascade into unrelated ones.
 *
 * Regression lock for commit d0208805. The bug: the /api/addons/upload
 * route called `addonBridge.reloadPackages()` which rebuilt the global
 * AddonLoader (`AddonBridge.Reloaded count=45`). That swap knocked
 * every isolated group-runner's IPC channel offline — a single
 * `camstack deploy` produced `Group-runner hub/<X> disconnected` for
 * 6+ unrelated addons. The fix dropped the redundant reloadPackages;
 * `addonRegistry.loadNewAddons()` alone does a non-destructive diff.
 *
 * The suite spawns a hub, uploads the synthetic test addon, and
 * asserts against the hub stdout log:
 *   - the upload log line names ONLY the synthetic addon in
 *     restartTargets
 *   - no `AddonBridge.Reloaded` line appears after the upload
 *   - no OTHER addon emits `Group-runner … disconnected` in the
 *     post-upload window
 *
 * Spec: docs/superpowers/specs/ (addon lifecycle hardening).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnHub, type SpawnedHub } from '../fixtures/electron.ts'
import { loginAsAdmin, type AuthorizedClient } from '../fixtures/api-client.ts'
import { buildSyntheticAddon, type SyntheticAddon } from '../fixtures/synthetic-addon.ts'
import { packAddon, uploadTarball } from '../fixtures/addon-upload.ts'

const E2E_LIVE = process.env['CAMSTACK_E2E_LIVE'] === '1'
const desc = E2E_LIVE ? describe : describe.skip

const PACKAGE_NAME = '@camstack/e2e-fixture-noop'
const ADDON_ID = 'e2e-fixture-noop'
const HUB_PORT = 4556

let hub: SpawnedHub | null = null
let client: AuthorizedClient | null = null
let v1: SyntheticAddon | null = null
const dirsToCleanup: string[] = []

beforeAll(async () => {
  if (!E2E_LIVE) return
  hub = await spawnHub({
    port: HUB_PORT,
    bootTimeoutMs: 180_000,
    env: {
      CAMSTACK_INSTALL_SOURCE: 'local',
      CAMSTACK_SKIP_ADMIN_UI_WAIT: '1',
      CAMSTACK_HUB_TCP_PORT: '6031',
    },
  })
  client = await loginAsAdmin(hub.port)
  const v1Dir = mkdtempSync(join(tmpdir(), 'camstack-e2e-iso-'))
  dirsToCleanup.push(v1Dir)
  v1 = buildSyntheticAddon({ name: PACKAGE_NAME, version: '1.0.0', dir: v1Dir })
}, 240_000)

afterAll(async () => {
  if (hub) await hub.stop()
  for (const d of dirsToCleanup.splice(0)) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true })
  }
})

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

desc('addon deploy isolation', () => {
  it('a tarball upload restarts only the target addon — no cascade', async () => {
    if (!hub || !client || !v1) throw new Error('suite not initialised')

    // Mark the stdout ring-buffer position so we only inspect lines
    // emitted by the upload + its aftermath.
    const beforeLen = hub.stdoutBuf.length

    const tgz = packAddon(v1.dir)
    const res = await uploadTarball(hub.port, client.token, tgz)
    expect(res.status, `upload body: ${res.body.slice(0, 300)}`).toBeLessThan(400)

    // Give the background restart + any (regressed) cascade time to
    // surface in the log. The fixed path settles in <5s; we wait
    // longer so a regression's cascade has every chance to appear.
    await sleep(20_000)

    const fresh = hub.stdoutBuf.slice(beforeLen)
    const text = fresh.join('\n')

    // 1. The upload log line must name ONLY the synthetic addon.
    const installLine = fresh.find((l) => l.includes('hub install OK'))
    expect(installLine, 'no "hub install OK" line found after upload').toBeDefined()
    expect(installLine).toContain(`restartTargets=["${ADDON_ID}"]`)

    // 2. No global AddonLoader rebuild — the d0208805 regression
    //    signature.
    const reloadedLines = fresh.filter((l) => /AddonBridge.*Reloaded/.test(l))
    expect(reloadedLines, 'AddonBridge.Reloaded cascade reappeared').toEqual([])

    // 3. No UNRELATED addon's group runner disconnected. The synthetic
    //    addon itself legitimately restarts, so we exclude its id; any
    //    other `Group-runner … disconnected` is the cascade bug.
    const cascadeDisconnects = fresh.filter((l) => {
      if (!/Group-runner .* disconnected/.test(l)) return false
      return !l.includes(ADDON_ID)
    })
    expect(
      cascadeDisconnects,
      `unrelated group runners disconnected after deploy:\n${cascadeDisconnects.join('\n')}`,
    ).toEqual([])

    void text
  }, 120_000)

  it('the synthetic addon is running at the deployed version after upload', async () => {
    if (!client) throw new Error('client not initialised')
    // Poll addons.list until the synthetic addon shows running.
    const { listAddons } = await import('../fixtures/api-client.ts')
    const start = Date.now()
    let state = 'missing'
    while (Date.now() - start < 30_000) {
      const addons = await listAddons(client)
      const match = addons.find((a) => a.manifest.packageName === PACKAGE_NAME)
      state = match?.process?.state ?? 'missing'
      if (state === 'running') break
      await sleep(500)
    }
    expect(state).toBe('running')
  }, 60_000)
})
