import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AddonDeploySource } from '@camstack/system'
import type { IScopedLogger } from '@camstack/types'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { AddonPackageService } from '../core/addon/addon-package.service'
import { isFrameworkPackage } from '../core/addon/addon-package.service.js'
import type { AddonRegistryService } from '../core/addon/addon-registry.service'
import type { AddonBridgeService } from '../core/addon-bridge/addon-bridge.service'
import type { AuthService } from '../core/auth/auth.service'
import type { MoleculerService } from '../core/moleculer/moleculer.service'
import { detectWorkspaceRoot } from '../server-root/index.js'
import type { AgentDeliveryResult } from './agent-addon-delivery.js'
import {
  type AgentDeliveryBroker,
  type DeliveryWindowLedger,
  deliverAddonToAgent,
} from './agent-addon-delivery.js'
import { DeployStageRegistry } from './deploy-stage-registry.js'
import type { ClusterBaseUrlResolver } from './hub-cluster-url.js'
import { isTarballFilename, readTarballManifest } from './tarball-manifest.js'
import { authorizeUploadRequest } from './upload-auth.js'

const deployStageRegistry = new DeployStageRegistry()

export function getDeployStageRegistry(): DeployStageRegistry {
  return deployStageRegistry
}

/**
 * One-time-token route agents pull a staged addon tgz from. Bearer token is
 * the per-deploy token minted in `DeployStageRegistry.stage()` and carried to
 * the agent in the `$agent.deploy` `hub-http` source descriptor.
 */
export function registerDeployBundleRoute(fastify: FastifyInstance): void {
  // `compress: false` — never gzip/brotli this route. The body is a large
  // binary tarball (addon bundle / model artifact) the agent pulls with undici
  // + sha256 verification. With global @fastify/compress on, the 1–2MB response
  // was Brotli-encoded and undici's BrotliDecompress aborted the stream
  // ("TypeError: terminated"), silently breaking EVERY agent-pull (addon-deploy
  // AND model distribution). Identity bytes also keep the byte-length check valid.
  fastify.get<{ Params: { id: string } }>(
    '/api/addons/deploy-bundle/:id',
    { compress: false },
    (request, reply) => {
      const auth = request.headers.authorization ?? ''
      const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''
      if (!token) {
        reply.status(401).send({ error: 'missing bearer token' })
        return
      }
      const buffer = deployStageRegistry.consume(request.params.id, token)
      if (!buffer) {
        reply
          .status(deployStageRegistry.peekExists(request.params.id) ? 401 : 404)
          .send({ error: 'bundle not available' })
        return
      }
      reply.header('content-type', 'application/octet-stream').send(buffer)
    },
  )
}

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

/**
 * Read one text field out of a multipart body, or `null`.
 *
 * Only call this AFTER the file part has been drained — see the note at the
 * call site. The plugin types the value as `unknown`, hence the narrowing.
 */
function readMultipartTextField(fields: Record<string, unknown>, name: string): string | null {
  const field = fields[name]
  if (typeof field !== 'object' || field === null || !('value' in field)) return null
  const value = (field as { value: unknown }).value
  return typeof value === 'string' ? value : null
}

type BaseUrlOrReason =
  | { readonly ok: true; readonly baseUrl: string }
  | { readonly ok: false; readonly error: string }

/** Resolve the agent-facing base URL, turning a refusal into its reason. */
async function resolveBaseUrlOrReason(resolve: ClusterBaseUrlResolver): Promise<BaseUrlOrReason> {
  try {
    return { ok: true, baseUrl: await resolve() }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function buildHubHttpSource(
  buffer: Buffer,
  hubBaseUrl: string,
): Extract<AddonDeploySource, { kind: 'hub-http' }> {
  const staged = getDeployStageRegistry().stage(buffer)
  return {
    kind: 'hub-http',
    url: `${hubBaseUrl.replace(/\/$/, '')}/api/addons/deploy-bundle/${staged.id}`,
    token: staged.token,
    sha256: staged.sha256,
    bytes: staged.bytes,
  }
}

/** What the upload route tells the agent registry (D982). */
export interface UploadConvergence {
  noteExplicitDelivery(nodeId: string, packageName: string): Promise<void>
  requestConvergence(trigger: 'hub-change'): Promise<void>
}

export async function registerAddonUploadRoute(
  fastify: FastifyInstance,
  addonBridge: AddonBridgeService,
  authService: AuthService,
  moleculer: MoleculerService,
  addonRegistry: AddonRegistryService,
  addonPackageService: AddonPackageService,
  logger: IScopedLogger,
  /**
   * The base URL agents pull the staged bundle from — the `local-network`
   * cap's cluster address (`hub-cluster-url.ts`), resolved per delivery.
   */
  resolveClusterBaseUrl: ClusterBaseUrlResolver,
  /**
   * Marks the "hub is writing to this node" window around every agent
   * delivery so the addon back-fill cannot mistake the roster gap a deploy
   * opens for a node that lost its addons. Optional so route unit tests need
   * not build one; `main.ts` always passes the AgentRegistryService's.
   */
  deliveryLedger?: DeliveryWindowLedger,
  /**
   * The D982 convergence: an explicit delivery to one node lifts its tombstone,
   * and a hub install asks for a convergence round. Optional so route unit tests
   * need not build one; `main.ts` passes the AgentRegistryService.
   */
  convergence?: UploadConvergence,
): Promise<void> {
  await fastify.register(import('@fastify/multipart'), {
    limits: { fileSize: MAX_UPLOAD_BYTES },
  })

  registerDeployBundleRoute(fastify)

  fastify.post('/api/addons/upload', async (request, reply) => {
    // Auth chain (shared with /api/server-upload): JWT (isAdmin) OR scoped
    // token whose scopes grant `create` access on the `addons` capability.
    // See upload-auth.ts for the full rationale.
    const auth = await authorizeUploadRequest({
      authHeader: request.headers.authorization,
      authService,
      addonRegistry,
    })
    if (!auth.ok) {
      return reply.status(auth.status).send({ error: auth.error })
    }

    const data = await request.file()
    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded' })
    }
    if (!isTarballFilename(data.filename)) {
      return reply.status(400).send({ error: 'File must be a .tgz or .tar.gz archive' })
    }

    // Drain the file part FIRST. `data.fields` is the plugin's live `body`
    // object, populated by busboy as parsing proceeds — so a field that sits
    // AFTER the file part in the body simply is not there yet when
    // `request.file()` resolves. Reading `nodeId` at that moment worked for a
    // small tarball (whole body in one chunk, already parsed) and silently
    // returned `undefined` for a large one.
    //
    // Cost, 2026-08-07: every `camstack deploy packages/addon-pipeline -n
    // agent-a` — a 4.9 MB tarball — read `nodeId = null` and took the HUB
    // branch. The CLI printed `✓ agent-a: @camstack/addon-pipeline@1.2.43`
    // (the label it INTENDED, never the target the hub used) and the named agent
    // was never addressed at all. It reproduced 4× and was diagnosed as a stale
    // dist. Reading the fields after the drain is the fix here; the CLI also
    // sends them BEFORE the file so this cannot depend on chunking again.
    const buffer = await data.toBuffer()

    // `data.fields[X].value` is the parsed string; we narrow defensively
    // because the multipart plugin types it as `unknown`.
    const nodeId = readMultipartTextField(data.fields, 'nodeId')
    const addonIdHint = readMultipartTextField(data.fields, 'addonId')

    // Gate: reject archives that don't expose a parseable package.json with
    // name + version. The hub installer did this implicitly via npm; the
    // agent path would otherwise fail mid-extraction with no clean rollback.
    const manifest = readTarballManifest(buffer, data.filename)
    if (!manifest) {
      return reply.status(400).send({
        error: 'Tarball missing or malformed package/package.json (name + version required)',
      })
    }

    // Branch by deployment target. `nodeId === 'hub'` (or absent) installs on
    // the hub AND broadcasts to every connected agent that can run any of
    // the package's addons (i.e. anything not marked hub-only). Any other
    // explicit `nodeId` value routes only to that agent via `$agent.deploy`.
    if (!nodeId || nodeId === 'hub') {
      return installToHub(
        reply,
        addonBridge,
        addonRegistry,
        addonPackageService,
        moleculer,
        logger,
        data.filename,
        buffer,
        resolveClusterBaseUrl,
        deliveryLedger,
        convergence,
      )
    }
    const agentAddonId = addonIdHint ?? manifest.name
    return deployToAgent(
      reply,
      moleculer,
      logger,
      nodeId,
      agentAddonId,
      buffer,
      resolveClusterBaseUrl,
      deliveryLedger,
      convergence,
    )
  })
}

interface AddonExecutionLike {
  readonly placement?: 'hub-only' | 'agent-only' | 'any-node'
}
interface CamstackAddonDeclLike {
  readonly id?: unknown
  readonly execution?: AddonExecutionLike
}

/**
 * Read the on-disk package.json and decide whether the package contains
 * anything that needs to land on agents. We deliberately read from disk
 * (rather than `addonRegistry.listAddons()`) so the function is safe to
 * call before `loadNewAddons()` and so `agent-only` addons — which the
 * hub registry intentionally skips — still show up here.
 *
 * Returns `true` if at least one addon's `execution.placement` is anything
 * other than `'hub-only'`. Absence of `execution` defaults to hub-only so
 * legacy packages don't suddenly broadcast cluster-wide.
 */
function packageHasAgentDeployable(addonsDir: string, packageName: string): boolean {
  try {
    const pkgPath = path.join(addonsDir, packageName, 'package.json')
    const parsed: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    if (parsed === null || typeof parsed !== 'object') return false
    const camstack = (parsed as { camstack?: { addons?: readonly CamstackAddonDeclLike[] } })
      .camstack
    const addons = camstack?.addons ?? []
    return addons.some((a) => {
      const placement = a.execution?.placement ?? 'hub-only'
      return placement === 'agent-only' || placement === 'any-node'
    })
  } catch {
    return false
  }
}

interface MoleculerBrokerLike extends AgentDeliveryBroker {
  registry?: {
    getNodeList?: (opts: { onlyAvailable: boolean }) => readonly { id: string }[]
  }
}

/**
 * Push `buffer` (a tarball) to every connected non-hub node and trigger a
 * `$agent.reload` so the freshly extracted dist is picked up immediately
 * without an agent restart. Agents that fail are reported per-node — one
 * unreachable agent must not block the others or the hub install.
 */
async function propagateToAgents(
  moleculer: MoleculerService,
  logger: IScopedLogger,
  packageName: string,
  buffer: Buffer,
  resolveClusterBaseUrl: ClusterBaseUrlResolver,
  deliveryLedger: DeliveryWindowLedger | undefined,
): Promise<readonly AgentDeliveryResult[]> {
  const broker = moleculer.broker as MoleculerBrokerLike
  const nodes = broker.registry?.getNodeList?.({ onlyAvailable: true }) ?? []
  // Moleculer reports both top-level nodes (`hub`, `dev-agent-0`, …) AND
  // their child per-addon runner processes (`hub/detection-pipeline`, `dev-agent-0/foo`).
  // Only the top-level agent nodes have the `$agent` service — calling
  // `$agent.deploy` on a child would hang until timeout. The hub itself
  // is excluded (it was already installed via `installToHub`).
  const allNodeIds = nodes.map((n) => n.id)
  const agentNodeIds = allNodeIds.filter((id) => id !== 'hub' && !id.includes('/'))
  logger.info('propagate: enumerated broker nodes', {
    meta: {
      packageName,
      allNodeIds,
      targetAgents: agentNodeIds,
    },
  })
  if (agentNodeIds.length === 0) return []
  const hubBaseUrl = await resolveBaseUrlOrReason(resolveClusterBaseUrl)
  if (!hubBaseUrl.ok) {
    logger.error('propagate: no hub address an agent can reach — nothing delivered', {
      meta: { packageName, targetAgents: agentNodeIds, error: hubBaseUrl.error },
    })
    return agentNodeIds.map((nodeId) => ({ nodeId, success: false, error: hubBaseUrl.error }))
  }
  const results: AgentDeliveryResult[] = []
  for (const nodeId of agentNodeIds) {
    // The hub currently only ever sends the `hub-http` source (agent streams
    // the tgz directly from this hub). The `{kind:'npm'}` source is a reserved
    // follow-up (published-addon optimization) and is intentionally not produced
    // yet. Wiring it later must also make the agent's npm path evict the addon's
    // declaration ids before `$agent.reload`, otherwise an npm update pins the
    // stale version.
    results.push(
      await deliverAddonToAgent({
        broker,
        logger,
        nodeId,
        packageName,
        source: buildHubHttpSource(buffer, hubBaseUrl.baseUrl),
        ...(deliveryLedger === undefined ? {} : { deliveryLedger }),
      }),
    )
  }
  return results
}

/**
 * Hub install path: write the tgz, refresh the manifest list, then drive the
 * registry through (a) `loadNewAddons` for brand-new addonIds and (b)
 * `restartAddon` for each addonId already tied to this package. The restart
 * branch is the hot-update story — group-hosted addons re-fork their child
 * process (fresh dist code is loaded) and in-process addons re-init in place.
 * Without this the CLI push was write-to-disk-only and required a server
 * restart to actually run the new code.
 */
async function installToHub(
  reply: FastifyReply,
  addonBridge: AddonBridgeService,
  addonRegistry: AddonRegistryService,
  addonPackageService: AddonPackageService,
  moleculer: MoleculerService,
  logger: IScopedLogger,
  filename: string,
  buffer: Buffer,
  resolveClusterBaseUrl: ClusterBaseUrlResolver,
  deliveryLedger: DeliveryWindowLedger | undefined,
  convergence: UploadConvergence | undefined,
): Promise<void> {
  const tmpDir = path.join(os.tmpdir(), `camstack-addon-upload-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const tgzPath = path.join(tmpDir, filename)
  fs.writeFileSync(tgzPath, buffer)

  try {
    const installer = addonBridge.getInstaller()
    if (!installer) {
      return reply.status(500).send({ error: 'Addon installer not available' })
    }

    // Snapshot addonIds tied to this package BEFORE installation. Used after
    // reload to distinguish "new" vs "updated". installFromTgz only writes
    // to disk; `addonRegistry.listAddons()` reflects in-memory state, so the
    // order (snapshot first vs install first) doesn't matter here — kept
    // pre-install for readability.
    const result = await installer.installFromTgz(tgzPath)
    const preInstallAddonIds = addonRegistry
      .listAddons()
      .filter((row) => row.manifest.packageName === result.name)
      .map((row) => row.manifest.id)

    // Must honour CAMSTACK_ADDONS_DIR — the runtime installs/loads addons
    // from there (e.g. /data/node_modules), NOT from CAMSTACK_DATA/addons.
    // Deriving the dir from CAMSTACK_DATA alone pointed the marker write at a
    // non-existent path → unguarded ENOENT → HTTP 500, which aborted the
    // handler before loadNewAddons()/restartAddon() ran, so uploads landed on
    // disk but never hot-reloaded. Mirrors AddonPackageService.resolveAddonsDir().
    const dataDir = path.resolve(process.env['CAMSTACK_DATA'] ?? 'camstack-data')
    const addonsDir = process.env['CAMSTACK_ADDONS_DIR'] ?? path.resolve(dataDir, 'addons')
    try {
      fs.writeFileSync(path.join(addonsDir, result.name, '.install-source'), 'upload')
    } catch (err) {
      logger.debug('Non-fatal: failed to write .install-source marker', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }

    // Framework / system packages (`camstack.system: true`, e.g. @camstack/system)
    // ship hub builtins (sqlite-settings, filesystem-storage, …) that CANNOT be
    // hot-reloaded in place — an in-process `restartAddon` leaves them
    // uninitialized ("SqliteSettingsBackend not initialized"), breaking auth +
    // settings. The new code is now on disk; a clean server restart reloads it
    // and re-runs boot initialization. The 10s restart grace lets this response
    // flush before the process exits, so the CLI sees a clean confirmation.
    if (isFrameworkPackage(result.name)) {
      // Framework live-sync is GONE (superseded by the runtime-updatable root
      // package — the hub main + its framework deps now update as ONE
      // `@camstack/server` closure via the `server-management` cap).
      //
      // Dev loop compatibility: in a workspace checkout the hub resolves the
      // framework straight from `packages/<pkg>/dist`, which the CLI rebuilt
      // BEFORE uploading — a plain restart loads the new code, no mirror
      // needed. `camstack deploy packages/system` therefore keeps working in
      // dev unchanged.
      const workspaceRoot = detectWorkspaceRoot(__dirname)
      if (workspaceRoot !== null) {
        logger.info('framework package deployed (workspace) — scheduling server restart', {
          meta: { packageName: result.name, packageVersion: result.version, workspaceRoot },
        })
        addonPackageService.restartServer(`addon-upload: ${result.name}@${result.version}`)
        return reply.send({
          success: true,
          name: result.name,
          version: result.version,
          requiresRestart: true,
          restarting: true,
          message:
            'Framework package installed — server is restarting to load it from the workspace',
        })
      }

      // Production (baked/data-root): the upload landed in the addons dir — a
      // location the hub main never loads the framework from. Direct the
      // operator to the supported path instead of pretending it went live.
      logger.warn('framework package upload REJECTED for live update (non-workspace hub)', {
        meta: { packageName: result.name, packageVersion: result.version },
      })
      return reply.status(409).send({
        success: false,
        name: result.name,
        version: result.version,
        error:
          'Framework packages no longer live-update via upload on a deployed hub. ' +
          'Update the @camstack/server root package instead (Server management → Update, ' +
          'or the server-management.applyServerUpdate cap method).',
      })
    }

    // `addonRegistry.loadNewAddons()` already runs its own fresh filesystem
    // scan, diff'ing against existing `addonEntries` — it updates metadata
    // for known addons without touching their live instances + initializes
    // only entries it hasn't seen before. The previous `addonBridge.
    // reloadPackages()` call here was redundant AND destructive: it built
    // a brand-new `AddonLoader` and replaced the global, which knocked
    // every isolated group-runner's IPC channel offline (visible as
    // `Group-runner hub/<X>-isolated disconnected` for 6+ addons after
    // a single `camstack deploy`). `loadNewAddons` alone is enough.
    const loadResult = await addonRegistry.loadNewAddons()

    // Hot-update + cluster propagation are FIRE-AND-FORGET. The upload
    // route must respond quickly so the CLI / UI sees confirmation; the
    // capability re-registration after a forked group-runner respawn can
    // legitimately take 30s–several minutes (Python pool warmup, native
    // module init, broken external deps) and we don't want operator
    // tooling to hang waiting for it. `restartAddon` and
    // `propagateToAgents` each log their own progress; operators monitor
    // status through the topology cap or the addons UI.
    const propagatable = packageHasAgentDeployable(addonsDir, result.name)
    logger.info('hub install OK', {
      meta: {
        packageName: result.name,
        packageVersion: result.version,
        loaded: loadResult.loaded,
        restartTargets: preInstallAddonIds,
        propagatable,
      },
    })
    for (const id of preInstallAddonIds) {
      void addonRegistry.restartAddon(id).then((r) => {
        if (!r.success) {
          logger.warn('background restart failed', {
            tags: { addonId: id },
            meta: { error: r.error ?? 'unknown' },
          })
        } else {
          logger.info('background restart OK', { tags: { addonId: id } })
        }
      })
    }
    if (propagatable) {
      void propagateToAgents(
        moleculer,
        logger,
        result.name,
        buffer,
        resolveClusterBaseUrl,
        deliveryLedger,
      ).then((agentResults) => {
        logger.info('propagation done', {
          meta: { packageName: result.name, agents: agentResults },
        })
        void convergence?.requestConvergence('hub-change')
      })
    } else {
      void convergence?.requestConvergence('hub-change')
    }

    return reply.send({
      success: true,
      target: 'hub',
      packageName: result.name,
      version: result.version,
      loaded: loadResult.loaded,
      restartingInBackground: preInstallAddonIds,
      propagatingToAgentsInBackground: propagatable,
      failures: loadResult.failed,
    })
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

/**
 * `camstack deploy <pkg> -n <nodeId>` — install on ONE named agent.
 *
 * Goes through the same `deliverAddonToAgent` as the cluster propagation. It
 * did not, once: this branch called `$agent.deploy` and returned success
 * without ever asking the node to load what it had just written. The bundle was
 * on disk and the node ran the old one — see `agent-addon-delivery.ts` for the
 * evidence. The response now carries what was reloaded and what was verified,
 * so the CLI can print facts instead of a bare tick.
 */
async function deployToAgent(
  reply: FastifyReply,
  moleculer: MoleculerService,
  logger: IScopedLogger,
  nodeId: string,
  addonId: string,
  buffer: Buffer,
  resolveClusterBaseUrl: ClusterBaseUrlResolver,
  deliveryLedger: DeliveryWindowLedger | undefined,
  convergence: UploadConvergence | undefined,
): Promise<void> {
  const hubBaseUrl = await resolveBaseUrlOrReason(resolveClusterBaseUrl)
  if (!hubBaseUrl.ok) {
    logger.error('agent deploy: no hub address the agent can reach — nothing delivered', {
      meta: { nodeId, addonId, error: hubBaseUrl.error },
    })
    return reply.status(502).send({ error: `Agent deploy failed: ${hubBaseUrl.error}` })
  }
  // The hub currently only ever sends the `hub-http` source (agent streams the
  // tgz directly from this hub). The `{kind:'npm'}` source is a reserved
  // follow-up (published-addon optimization) and is intentionally not produced
  // yet. Wiring it later must also make the agent's npm path evict the addon's
  // declaration ids before `$agent.reload`, otherwise an npm update pins the
  // stale version.
  const result = await deliverAddonToAgent({
    broker: moleculer.broker as AgentDeliveryBroker,
    logger,
    nodeId,
    packageName: addonId,
    source: buildHubHttpSource(buffer, hubBaseUrl.baseUrl),
    ...(deliveryLedger === undefined ? {} : { deliveryLedger }),
  })
  if (!result.success) {
    return reply.status(502).send({ error: `Agent deploy failed: ${result.error ?? 'unknown'}` })
  }
  // An operator's explicit delivery to this node lifts its tombstone (D982).
  await convergence?.noteExplicitDelivery(nodeId, addonId)
  return reply.send({
    success: true,
    target: nodeId,
    addonId: result.addonId,
    path: result.path,
    reloaded: result.loaded ?? [],
    verifiedSha256: result.verifiedSha256,
  })
}
