/**
 * Per-node addon update suite.
 *
 * Exercises the per-node `addons` cap methods: `listUpdates`,
 * `updatePackage` and `forceRefresh` now accept an optional `nodeId`.
 * When `nodeId` targets a connected agent, the hub orchestrates the
 * operation on that agent's behalf — the agent has no npm runtime:
 *   - `listUpdates`/`forceRefresh` — the hub reads the agent's
 *     installed roster via `$agent.status` and diffs it against npm.
 *   - `updatePackage` — the hub `npm pack`s the resolved version and
 *     pushes the tarball to the agent via `$agent.deploy` +
 *     `$agent.reload`.
 *
 * Backend: `server/backend/src/api/core/cap-providers.ts`
 * (`buildAddonsProvider` — `isHubNode`, `fetchAgentInstalledPackages`)
 * and `server/backend/src/core/addon/addon-package.service.ts`
 * (`checkUpdatesForInstalled`, `packPackage`).
 *
 * Isolation: the suite uses a unique cluster secret + non-default
 * hub/agent/verdaccio ports + isolated mktemp data dirs so it never
 * collides with a developer's running `dev:full` cluster (which holds
 * the default ports). An explicit `CAMSTACK_HUB_ADDRESS` on the agent
 * disables UDP discovery — the agent connects ONLY to the test hub.
 *
 * Gated behind `CAMSTACK_E2E_LIVE=1` like every other live suite.
 *
 * Test flow:
 *   1. Verdaccio: publish the synthetic addon at 1.0.0 and 1.1.0. The
 *      manifest declares `placement: 'agent-only'` so it never runs on
 *      the hub.
 *   2. Spawn the hub (verdaccio registry, unique cluster ports/secret).
 *   3. Spawn an agent connected to that hub.
 *   4. Install 1.0.0 onto the AGENT via `updatePackage({ nodeId })` —
 *      this exercises the hub→`$agent.deploy` push path itself.
 *   5. Per-node `listUpdates`: the agent reports 1.0.0 → 1.1.0; the
 *      hub reports the synthetic addon NOT present (proves node-scope).
 *   6. Per-node `updatePackage` to 1.1.0; `getNodeAddons` confirms the
 *      agent now runs 1.1.0.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnHub, type SpawnedHub } from '../fixtures/electron.ts'
import { spawnAgent, type SpawnedAgent } from '../fixtures/agent.ts'
import {
  loginAsAdmin,
  trpcQuery,
  trpcMutation,
  type AuthorizedClient,
} from '../fixtures/api-client.ts'
import { spawnVerdaccio, publishFixture, type SpawnedVerdaccio } from '../fixtures/verdaccio.ts'
import { buildSyntheticAddon, type SyntheticAddon } from '../fixtures/synthetic-addon.ts'

const E2E_LIVE = process.env['CAMSTACK_E2E_LIVE'] === '1'
const desc = E2E_LIVE ? describe : describe.skip

// ── Unique per-suite identifiers ────────────────────────────────────────
// All ports + the cluster secret are deliberately off the dev defaults
// (hub 4443 / tcp 6000 / udp 4445 / verdaccio 4873 / agent 4444).
const PACKAGE_NAME = '@camstack/e2e-fixture-noop'
const ADDON_ID = 'e2e-fixture-noop'
const AGENT_NODE_ID = 'e2e-agent-update-0'

const HUB_HTTP_PORT = 4561
const HUB_TCP_PORT = 6051
const VERDACCIO_PORT = 4887
const AGENT_STATUS_PORT = 4547

// Repo `packages/` dir — the agent boots its required packages
// (@camstack/core, addon-pipeline, addon-agent-ui) from here as
// `bundled` rather than pulling from npm. Without this the agent
// would try to `npm install` the agent runtime packages, which are
// NOT published to the test verdaccio, and hang on retries.
const REPO_PACKAGES_DIR = resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'packages')

interface SuiteState {
  registry: SpawnedVerdaccio
  hub: SpawnedHub
  agent: SpawnedAgent
  client: AuthorizedClient
}

let registryRef: SpawnedVerdaccio | null = null
let hubRef: SpawnedHub | null = null
let agentRef: SpawnedAgent | null = null
let state: SuiteState | null = null
const dirsToCleanup: string[] = []

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

// ── Domain helpers (typed wrappers over the raw tRPC client) ────────────

interface PackageUpdateLite {
  readonly name: string
  readonly currentVersion: string
  readonly latestVersion: string
}

async function listUpdatesForNode(
  client: AuthorizedClient,
  nodeId: string | undefined,
): Promise<readonly PackageUpdateLite[]> {
  return trpcQuery<readonly PackageUpdateLite[]>(
    client.port,
    'addons.listUpdates',
    nodeId === undefined ? {} : { nodeId },
    client.token,
  )
}

interface NodeAddonEntryLite {
  readonly id: string
  readonly status: string
  readonly version?: string
  readonly packageName?: string
}

async function getNodeAddons(
  client: AuthorizedClient,
  nodeId: string,
): Promise<readonly NodeAddonEntryLite[]> {
  return trpcQuery<readonly NodeAddonEntryLite[]>(
    client.port,
    'nodes.getNodeAddons',
    { nodeId },
    client.token,
  )
}

async function updatePackageOnNode(
  client: AuthorizedClient,
  input: { name: string; version?: string; nodeId?: string },
): Promise<unknown> {
  return trpcMutation<unknown>(client.port, 'addons.updatePackage', input, client.token)
}

/**
 * Poll `getNodeAddons` until the synthetic addon reports the desired
 * version. The agent's `$agent.deploy` + `$agent.reload` push is
 * asynchronous, so the version flips a beat after `updatePackage`
 * returns. Returns the observed version (or 'missing') on timeout.
 */
async function waitForAgentAddonVersion(
  client: AuthorizedClient,
  nodeId: string,
  desiredVersion: string,
  timeoutMs: number,
): Promise<string> {
  const start = Date.now()
  let observed = 'missing'
  while (Date.now() - start < timeoutMs) {
    const addons = await getNodeAddons(client, nodeId)
    const match = addons.find((a) => a.packageName === PACKAGE_NAME || a.id === ADDON_ID)
    observed = match?.version ?? 'missing'
    if (observed === desiredVersion) return observed
    await sleep(1_000)
  }
  return observed
}

// ── Setup / teardown ────────────────────────────────────────────────────

beforeAll(async () => {
  if (!E2E_LIVE) return

  // 1. Verdaccio + synthetic addon at two versions. `agent-only`
  //    placement ensures the addon is never loaded on the hub — that
  //    is what makes the node-scope assertion in step 5 meaningful.
  registryRef = await spawnVerdaccio({ port: VERDACCIO_PORT })
  const v1Dir = mkdtempSync(join(tmpdir(), 'camstack-e2e-agentupd-v1-'))
  const v2Dir = mkdtempSync(join(tmpdir(), 'camstack-e2e-agentupd-v2-'))
  dirsToCleanup.push(v1Dir, v2Dir)
  const v1: SyntheticAddon = buildSyntheticAddon({
    name: PACKAGE_NAME,
    version: '1.0.0',
    placement: 'agent-only',
    dir: v1Dir,
  })
  const v2: SyntheticAddon = buildSyntheticAddon({
    name: PACKAGE_NAME,
    version: '1.1.0',
    placement: 'agent-only',
    dir: v2Dir,
  })
  await publishFixture(registryRef, v1.dir)
  await publishFixture(registryRef, v2.dir)

  // 2. Hub — verdaccio registry, unique cluster ports + secret.
  hubRef = await spawnHub({
    port: HUB_HTTP_PORT,
    bootTimeoutMs: 180_000,
    env: {
      CAMSTACK_NPM_REGISTRY: registryRef.url,
      CAMSTACK_HUB_TCP_PORT: String(HUB_TCP_PORT),
      // Framework/required packages aren't on the test verdaccio —
      // bootstrap them from the local workspace, same as the other
      // verdaccio-backed suites.
      CAMSTACK_INSTALL_SOURCE: 'local',
      CAMSTACK_SKIP_ADMIN_UI_WAIT: '1',
    },
  })
  const client = await loginAsAdmin(hubRef.port)

  // 3. Agent — connects EXPLICITLY to the hub's TCP endpoint (disables
  //    UDP discovery) and is PAIRED with the hub by the fixture (D857).
  agentRef = await spawnAgent({
    nodeId: AGENT_NODE_ID,
    hubAddress: `127.0.0.1:${HUB_TCP_PORT}`,
    hubClient: client,
    statusPort: AGENT_STATUS_PORT,
    readyTimeoutMs: 90_000,
    env: {
      // Boot the agent's required runtime packages from the workspace
      // `packages/` dir (offline, fast) instead of npm — the agent
      // runtime packages are not on the test verdaccio.
      CAMSTACK_BUNDLED_ADDONS_DIR: REPO_PACKAGES_DIR,
    },
  })

  state = { registry: registryRef, hub: hubRef, agent: agentRef, client }
}, 300_000)

afterAll(async () => {
  if (agentRef) {
    try {
      await agentRef.stop()
    } catch {
      /* */
    }
    agentRef = null
  }
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

// ── Scenarios ───────────────────────────────────────────────────────────

desc('per-node addon updates — listUpdates + updatePackage on an agent', () => {
  it('the spawned agent appears online in the hub topology', async () => {
    if (!state) throw new Error('suite state not initialised')
    const nodes = await trpcQuery<readonly { id: string; isHub: boolean; isOnline: boolean }[]>(
      state.client.port,
      'nodes.topology',
      undefined,
      state.client.token,
    )
    const agentNode = nodes.find((n) => n.id === AGENT_NODE_ID)
    expect(agentNode, `agent "${AGENT_NODE_ID}" not in topology`).toBeDefined()
    expect(agentNode!.isHub).toBe(false)
    expect(agentNode!.isOnline).toBe(true)
  }, 60_000)

  it('installs synthetic addon 1.0.0 onto the agent via per-node updatePackage', async () => {
    if (!state) throw new Error('suite state not initialised')

    // `updatePackage` to an agent triggers the hub→`$agent.deploy`
    // push. The synthetic addon has no prior install on the agent, so
    // this is the cold-install path of the per-node update feature.
    await updatePackageOnNode(state.client, {
      name: PACKAGE_NAME,
      version: '1.0.0',
      nodeId: AGENT_NODE_ID,
    })

    const observed = await waitForAgentAddonVersion(state.client, AGENT_NODE_ID, '1.0.0', 45_000)
    expect(observed, 'agent should run synthetic addon @ 1.0.0 after deploy').toBe('1.0.0')
  }, 120_000)

  it('per-node listUpdates is genuinely node-scoped: agent sees 1.0.0 → 1.1.0, hub does not', async () => {
    if (!state) throw new Error('suite state not initialised')

    // Agent-scoped check — the hub reads the agent roster via
    // `$agent.status` and diffs it against verdaccio.
    const agentUpdates = await listUpdatesForNode(state.client, AGENT_NODE_ID)
    const agentMatch = agentUpdates.find((u) => u.name === PACKAGE_NAME)
    expect(
      agentMatch,
      `agent listUpdates should report an update for ${PACKAGE_NAME}; got: ${JSON.stringify(agentUpdates)}`,
    ).toBeDefined()
    expect(agentMatch!.currentVersion).toBe('1.0.0')
    expect(agentMatch!.latestVersion).toBe('1.1.0')

    // Hub-scoped check — the synthetic addon is `agent-only`, so it is
    // NOT installed on the hub and must NOT surface in a hub update
    // check. This proves the call is genuinely node-scoped rather than
    // a hub-wide check wearing a `nodeId` label.
    const hubUpdates = await listUpdatesForNode(state.client, 'hub')
    expect(
      hubUpdates.find((u) => u.name === PACKAGE_NAME),
      `hub listUpdates must NOT contain ${PACKAGE_NAME} (it is agent-only)`,
    ).toBeUndefined()

    // Same expectation for the no-nodeId (implicit hub) form.
    const defaultUpdates = await listUpdatesForNode(state.client, undefined)
    expect(
      defaultUpdates.find((u) => u.name === PACKAGE_NAME),
      `default listUpdates must NOT contain ${PACKAGE_NAME}`,
    ).toBeUndefined()
  }, 90_000)

  it('forceRefresh is node-scoped and live (bypasses cache)', async () => {
    if (!state) throw new Error('suite state not initialised')
    const refreshed = await trpcMutation<readonly PackageUpdateLite[]>(
      state.client.port,
      'addons.forceRefresh',
      { nodeId: AGENT_NODE_ID },
      state.client.token,
    )
    const match = refreshed.find((u) => u.name === PACKAGE_NAME)
    expect(
      match,
      `forceRefresh for the agent should report ${PACKAGE_NAME}; got: ${JSON.stringify(refreshed)}`,
    ).toBeDefined()
    expect(match!.latestVersion).toBe('1.1.0')
  }, 90_000)

  it('per-node updatePackage upgrades the agent from 1.0.0 to 1.1.0', async () => {
    if (!state) throw new Error('suite state not initialised')

    await updatePackageOnNode(state.client, {
      name: PACKAGE_NAME,
      version: '1.1.0',
      nodeId: AGENT_NODE_ID,
    })

    const observed = await waitForAgentAddonVersion(state.client, AGENT_NODE_ID, '1.1.0', 45_000)
    expect(observed, 'agent should run synthetic addon @ 1.1.0 after per-node update').toBe('1.1.0')

    // After the upgrade, the agent roster should report no further
    // update for the synthetic addon (it is now at the published latest).
    const updatesAfter = await listUpdatesForNode(state.client, AGENT_NODE_ID)
    expect(
      updatesAfter.find((u) => u.name === PACKAGE_NAME),
      `after upgrade to 1.1.0 the agent should have no pending update for ${PACKAGE_NAME}`,
    ).toBeUndefined()
  }, 120_000)
})
