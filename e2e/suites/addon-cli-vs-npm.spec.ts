/**
 * Addon CLI-vs-npm version-interaction suite (Phase 4 — scenarios 1+3).
 *
 * Exercises the two distinct install codepaths on the hub:
 *
 *   • CLI  = POST .tgz to /api/addons/upload (the wire format
 *            `camstack deploy` produces).
 *   • npm  = tRPC `addons.installPackage` → AddonInstaller runs
 *            `npm install --registry $CAMSTACK_NPM_REGISTRY`.
 *
 * Both ultimately write into `${CAMSTACK_DATA}/addons/<pkg>/`. The
 * spec at docs/superpowers/specs/2026-05-14-addon-cli-vs-npm-test-suite-design.md
 * documents 5 scenarios; this file lands #1 + #3 (the CLI-wins paths).
 * #2 (policy lock-in) lands in a follow-up; #4 (update-available) +
 * #5 (idempotency) close out the suite.
 *
 * Setup is shared: ONE verdaccio + ONE hub for the whole suite; each
 * scenario uninstalls the test package in afterEach so the next one
 * starts clean. Versions 1.0.0 + 2.0.0 are published to verdaccio
 * up-front; the hub picks one or the other depending on which entry
 * point we call.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnHub, type SpawnedHub } from '../fixtures/electron.ts'
import {
  loginAsAdmin,
  listAddons,
  trpcMutation,
  fetchHealth,
  type AuthorizedClient,
} from '../fixtures/api-client.ts'
import { spawnVerdaccio, publishFixture, type SpawnedVerdaccio } from '../fixtures/verdaccio.ts'
import { buildSyntheticAddon, type SyntheticAddon } from '../fixtures/synthetic-addon.ts'
import { packAddon, uploadTarball } from '../fixtures/addon-upload.ts'

const E2E_LIVE = process.env['CAMSTACK_E2E_LIVE'] === '1'
const desc = E2E_LIVE ? describe : describe.skip

const PACKAGE_NAME = '@camstack/e2e-fixture-noop'
const HUB_PORT = 4546
const VERDACCIO_PORT = 4882

interface SuiteState {
  registry: SpawnedVerdaccio
  hub: SpawnedHub
  client: AuthorizedClient
  v1: SyntheticAddon
  v2: SyntheticAddon
}

// Shared hub across the suite. We deliberately share — if the hub
// crashes after one scenario, that's a REAL bug surfaced by the test
// matrix and the user wants it fixed at the source, not papered over
// with per-test isolation. The afterEach below uninstalls the
// synthetic package so each scenario starts from "absent".
let registryRef: SpawnedVerdaccio | null = null
let hubRef: SpawnedHub | null = null
let state: SuiteState | null = null
const dirsToCleanup: string[] = []

beforeAll(async () => {
  if (!E2E_LIVE) return
  registryRef = await spawnVerdaccio({ port: VERDACCIO_PORT })
  const v1Dir = mkdtempSync(join(tmpdir(), 'camstack-e2e-v1-'))
  const v2Dir = mkdtempSync(join(tmpdir(), 'camstack-e2e-v2-'))
  dirsToCleanup.push(v1Dir, v2Dir)
  const v1 = buildSyntheticAddon({ name: PACKAGE_NAME, version: '1.0.0', dir: v1Dir })
  const v2 = buildSyntheticAddon({ name: PACKAGE_NAME, version: '2.0.0', dir: v2Dir })
  await publishFixture(registryRef, v1.dir)

  hubRef = await spawnHub({
    port: HUB_PORT,
    env: {
      CAMSTACK_NPM_REGISTRY: registryRef.url,
      CAMSTACK_HUB_TCP_PORT: '6011',
      // REQUIRED_PACKAGES aren't on the verdaccio fixture (only the
      // synthetic e2e-fixture-noop is). Bootstrap them via the
      // workspace `'local'` copy mode — same path Electron-bundled
      // builds use. The synthetic addon still goes through the npm
      // installer against the test verdaccio.
      CAMSTACK_INSTALL_SOURCE: 'local',
      // Skip the 60s admin-ui registration wait in main.ts. E2e tests
      // don't serve the SPA, and the wait pushes boot past the
      // spawnHub timeout. Production keeps the poll so the SPA is
      // served immediately on cold boot.
      CAMSTACK_SKIP_ADMIN_UI_WAIT: '1',
    },
  })
  const client = await loginAsAdmin(hubRef.port)
  state = { registry: registryRef, hub: hubRef, client, v1, v2 }
}, 180_000)

afterAll(async () => {
  if (hubRef) {
    try {
      await hubRef.stop()
    } catch {
      /* */
    }
    hubRef = null
  }
  if (registryRef) {
    try {
      await registryRef.stop()
    } catch {
      /* */
    }
    registryRef = null
  }
  for (const d of dirsToCleanup.splice(0)) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true })
  }
  state = null
})

afterEach(async () => {
  // Reset state between scenarios. If the hub already died, dump its
  // stderr tail so the next scenario's ECONNREFUSED has context — the
  // raw stderr is what we need to root-cause the bug.
  if (!state) return
  if (state.hub.proc.exitCode !== null) {
    const tail = state.hub.stderrBuf.slice(-30).join('\n')
    throw new Error(
      `Hub died unexpectedly between scenarios. exitCode=${state.hub.proc.exitCode}\nstderr tail:\n${tail}`,
    )
  }
  try {
    await trpcMutation(
      state.client.port,
      'addons.uninstallPackage',
      { packageName: PACKAGE_NAME },
      state.client.token,
    )
    // Poll for absence — uninstall is async on the hub side.
    const start = Date.now()
    while (Date.now() - start < 15_000) {
      const list = await listAddons(state.client)
      if (!list.find((a) => a.manifest.packageName === PACKAGE_NAME)) break
      await sleep(400)
    }
  } catch {
    // Allowed — package may not be installed.
  }
})

async function waitForState(
  c: AuthorizedClient,
  packageName: string,
  desiredState: 'running',
  timeoutMs: number,
): Promise<string> {
  const start = Date.now()
  let last = 'missing'
  while (Date.now() - start < timeoutMs) {
    const addons = await listAddons(c)
    const match = addons.find((a) => a.manifest.packageName === packageName)
    last = match?.process?.state ?? 'missing'
    if (last === desiredState) return last
    await sleep(400)
  }
  return last
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

/**
 * Installed on-disk version reported by `${CAMSTACK_DATA}/addons/<scope>/<name>/package.json`.
 * We round-trip through the filesystem rather than `addons.list` to catch
 * cases where the installer wrote the package but the loader rejected
 * it — the test wants to see WHAT got installed, not just whether the
 * runtime liked it.
 */
function readInstalledVersion(hubDataDir: string, packageName: string): string | null {
  const segments = packageName.startsWith('@')
    ? [
        packageName.slice(0, packageName.indexOf('/')),
        packageName.slice(packageName.indexOf('/') + 1),
      ]
    : [packageName]
  const pkgJsonPath = join(hubDataDir, 'addons', ...segments, 'package.json')
  if (!existsSync(pkgJsonPath)) return null
  const parsed = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as { version?: string }
  return parsed.version ?? null
}

// ── Scenarios ───────────────────────────────────────────────────────────

desc('addon CLI-vs-npm — scenarios 1+3', () => {
  it('scenario 3: npm install v1.0.0, then CLI upload v2.0.0 → CLI wins', async () => {
    if (!state) throw new Error('suite state not initialised')

    // Step 1 — npm install via tRPC (resolves @camstack/e2e-fixture-noop
    // against verdaccio, finds 1.0.0 since that's the only published version).
    await trpcMutation(
      state.client.port,
      'addons.installPackage',
      { packageName: PACKAGE_NAME },
      state.client.token,
    )
    const stateAfterNpm = await waitForState(state.client, PACKAGE_NAME, 'running', 30_000)
    expect(stateAfterNpm, 'addon should reach running after npm install').toBe('running')
    expect(readInstalledVersion(state.hub.dataDir, PACKAGE_NAME)).toBe('1.0.0')

    // Step 2 — CLI deploy v2.0.0 via tarball upload (the wire format
    // `camstack deploy` produces). Hub should swap v1 for v2 in-place.
    const tgz = packAddon(state.v2.dir)
    const res = await uploadTarball(state.hub.port, state.client.token, tgz)
    expect(res.status, `upload body: ${res.body.slice(0, 300)}`).toBeLessThan(400)

    // Step 3 — the addon should still reach `running`, but at v2.0.0 now.
    const stateAfterCli = await waitForState(state.client, PACKAGE_NAME, 'running', 30_000)
    expect(stateAfterCli).toBe('running')
    expect(readInstalledVersion(state.hub.dataDir, PACKAGE_NAME)).toBe('2.0.0')
  }, 120_000)

  it('scenario 1: CLI upload v2.0.0 first, then npm install (still resolves v1.0.0 on registry)', async () => {
    if (!state) throw new Error('suite state not initialised')

    // Diagnostic: probe HTTP and dump stderr+stdout if anything is
    // wrong. The previous shared-hub variant intermittently lost its
    // HTTP server between scenarios (process technically alive but
    // listener closed); a plain `exitCode` check missed that case.
    const probe = await fetchHealth(state.hub.port).catch(
      (err) =>
        ({
          status: 0,
          body: null,
          err: err instanceof Error ? err.message : String(err),
        }) as { status: number; body: unknown; err?: string },
    )
    if (probe.status !== 200) {
      const stderrTail = state.hub.stderrBuf.slice(-80).join('\n')
      const stdoutTail = state.hub.stdoutBuf.slice(-40).join('\n')
      throw new Error(
        `Hub unhealthy between scenarios. exitCode=${state.hub.proc.exitCode} killed=${state.hub.proc.killed}\n` +
          `probe status=${probe.status} err=${'err' in probe ? probe.err : 'n/a'}\n` +
          `--- stderr tail ---\n${stderrTail}\n` +
          `--- stdout tail ---\n${stdoutTail}`,
      )
    }

    // Step 1 — CLI deploy v2.0.0 cold (no prior install).
    const tgz = packAddon(state.v2.dir)
    const res = await uploadTarball(state.hub.port, state.client.token, tgz)
    expect(res.status, `upload body: ${res.body.slice(0, 300)}`).toBeLessThan(400)
    const stateAfterCli = await waitForState(state.client, PACKAGE_NAME, 'running', 30_000)
    expect(stateAfterCli).toBe('running')
    expect(readInstalledVersion(state.hub.dataDir, PACKAGE_NAME)).toBe('2.0.0')

    // Step 2 — npm install. Verdaccio still only has 1.0.0 published;
    // operator clicks "install latest" expecting an update but instead
    // the registry's latest is BEHIND the locally-deployed version.
    // The current policy is what this test locks in — whatever happens
    // (downgrade / no-op / error), future code changes that flip the
    // outcome will break this assertion loudly.
    await trpcMutation(
      state.client.port,
      'addons.installPackage',
      { packageName: PACKAGE_NAME },
      state.client.token,
    )
    const stateAfterNpm = await waitForState(state.client, PACKAGE_NAME, 'running', 30_000)
    expect(stateAfterNpm).toBe('running')

    // Lock in the observed policy: today's installer overwrites with
    // whatever `npm install` resolves, so the registry's 1.0.0 wins
    // over the locally-deployed 2.0.0. If we ever swap to "refuse
    // downgrade" semantics, this expect flips and forces the spec to
    // be revisited.
    const versionAfter = readInstalledVersion(state.hub.dataDir, PACKAGE_NAME)
    expect(['1.0.0', '2.0.0']).toContain(versionAfter)
    // Surface the actual outcome in the failure message — easier than
    // grep'ing the log when the policy changes.
    expect
      .soft(versionAfter, `installer policy is "${versionAfter}" wins on conflict`)
      .toBe('1.0.0')
  }, 120_000)
})
