import type { AddonDeploySource } from '@camstack/system'
import type { IScopedLogger } from '@camstack/types'

/**
 * Delivering an addon bundle to an agent — the single implementation.
 *
 * There used to be two. `propagateToAgents` (the hub-install broadcast) called
 * `$agent.deploy` **and** `$agent.reload`; `deployToAgent` (the `camstack deploy
 * -n <node>` path) called only `$agent.deploy`. Both reported success. The
 * second one is a write-to-disk-only deploy: the tarball lands, the install
 * manifest bumps `updatedAt`, the CLI prints `✓ <node>: <pkg>@<version>` — and
 * every runner on that node keeps executing the PREVIOUS dist until something
 * else happens to restart it.
 *
 * Reproduced on agent-a 2026-08-07 with a marker file inside `dist/`: the
 * marker was on disk 2 seconds after the `✓`, and not one of the 12 addon-runner
 * pids had been recycled. Four operators-hours were spent that day looking for a
 * stale tarball cache that does not exist — the bytes were always correct, they
 * were just never loaded.
 *
 * So delivery has three steps, not one, and both callers share them:
 *   1. `$agent.deploy`  — pull + install the bundle.
 *   2. hash check       — the agent reports the sha256 of the bytes it actually
 *                         applied; it must be the one we staged.
 *   3. `$agent.reload`  — re-instantiate the addons from the new dist, and
 *                         report which ones.
 */

/**
 * `$agent.deploy` is the INSTALL, not a control call.
 *
 * This constant used to be 30 s and said "install work is bounded well inside
 * this". On 2026-09-11 that claim cost `agent-a` an evening of running a
 * previous `addon-pipeline` dist: three deploys, three
 * `Request is timed out when call '$agent.deploy'` at exactly 30 s, while the
 * CLI printed `✓ Deployed to 1 target(s)` each time — true of the hub, silent
 * about the agent. The Mac answered the same call in under a second every time;
 * this node keeps `/data` on an shfs/FUSE mount, where unpacking the pipeline
 * bundle is minutes (the same mount makes its server `npm install` take ~15).
 *
 * `AGENT_BACKFILL_RPC_TIMEOUT_MS` had already learned this and written it down
 * for the SAME RPC. Two constants for one call drifted, and the drift is
 * invisible from the CLI: a bundle that lands while the reload never runs looks
 * exactly like a deploy that worked. `agent-deploy-timeout.spec.ts` pins the
 * relationship so they cannot separate again.
 */
export const AGENT_DEPLOY_CONTROL_TIMEOUT_MS = 300_000
/**
 * `$agent.reload` re-forks group runners and re-registers their capabilities —
 * legitimately slow on a node with a Python inference pool.
 */
export const AGENT_RELOAD_TIMEOUT_MS = 60_000

/**
 * Typed view over Moleculer's `ServiceBroker.call`. The library's published
 * types resolve to `any`, which the typed-eslint ruleset rejects; narrowing
 * once at this boundary lets every call site read as a normal typed call.
 */
export interface AgentDeliveryBroker {
  call(
    action: string,
    params: Record<string, unknown>,
    options: { nodeID: string; timeout: number },
  ): Promise<unknown>
}

export interface AgentDeliveryResult {
  readonly nodeId: string
  readonly success: boolean
  /** Package/addon id the agent reports it installed. */
  readonly addonId?: string
  /** On-disk directory the agent installed into. */
  readonly path?: string
  /** Addon declaration ids the agent re-instantiated from the new dist. */
  readonly loaded?: readonly string[]
  /**
   * Set when the agent confirmed the sha256 of the bundle it applied and it
   * matched what we staged. `undefined` means the agent runtime predates hash
   * reporting — delivery is allowed, but nothing verified the bytes end-to-end.
   */
  readonly verifiedSha256?: string
  readonly error?: string
}

interface AgentDeployResponse {
  readonly success: boolean
  readonly addonId: string
  readonly path?: string
  /** sha256 of the bundle bytes the agent actually unpacked. */
  readonly appliedSha256?: string
}

export function isAgentDeployResponse(value: unknown): value is AgentDeployResponse {
  if (value === null || typeof value !== 'object') return false
  const v = value as {
    success?: unknown
    addonId?: unknown
    path?: unknown
    appliedSha256?: unknown
  }
  if (typeof v.success !== 'boolean') return false
  if (typeof v.addonId !== 'string') return false
  if (v.path !== undefined && typeof v.path !== 'string') return false
  if (v.appliedSha256 !== undefined && typeof v.appliedSha256 !== 'string') return false
  return true
}

function readLoaded(value: unknown): readonly string[] {
  if (value === null || typeof value !== 'object') return []
  const loaded = (value as { loaded?: unknown }).loaded
  if (!Array.isArray(loaded)) return []
  return loaded.filter((id): id is string => typeof id === 'string')
}

/**
 * The delivery-window recorder. Structurally typed rather than imported as a
 * class so this module keeps no dependency on the agent-registry layer — the
 * only contract is "tell me when a delivery starts, I'll tell you when it ends".
 */
export interface DeliveryWindowLedger {
  begin(nodeId: string, packageName: string): () => void
}

export interface DeliverAddonToAgentArgs {
  readonly broker: AgentDeliveryBroker
  readonly logger: IScopedLogger
  readonly nodeId: string
  /** Package name — the on-disk dir the agent installs into. */
  readonly packageName: string
  readonly source: Extract<AddonDeploySource, { kind: 'hub-http' }>
  /**
   * Marks this node as "the hub is writing to it" for the whole deploy+reload,
   * so the addon back-fill cannot read the roster gap this delivery opens and
   * "repair" the node by installing over the bytes just shipped. Optional only
   * so unit fakes need not supply one; production always does.
   * See `core/agent/agent-delivery-ledger.ts`.
   */
  readonly deliveryLedger?: DeliveryWindowLedger
}

/**
 * Install `source` on one agent and leave it RUNNING the new code.
 *
 * Never throws: a per-node failure is returned so one unreachable agent cannot
 * abort a cluster propagation or the hub's own install.
 */
export async function deliverAddonToAgent(
  args: DeliverAddonToAgentArgs,
): Promise<AgentDeliveryResult> {
  const { broker, logger, nodeId, packageName, source } = args
  // Opened BEFORE the first byte and closed in the `finally` below — the window
  // must cover `$agent.deploy` (which evicts the package's declaration ids) AND
  // `$agent.reload` (whose re-registrations fire the reconcile), not just the
  // happy path.
  const closeWindow = args.deliveryLedger?.begin(nodeId, packageName)
  try {
    const deployRaw = await broker.call(
      '$agent.deploy',
      { addonId: packageName, source },
      { nodeID: nodeId, timeout: AGENT_DEPLOY_CONTROL_TIMEOUT_MS },
    )
    if (!isAgentDeployResponse(deployRaw)) {
      logger.warn('agent deploy: malformed deploy response', {
        meta: { nodeId, packageName },
      })
      return { nodeId, success: false, error: 'malformed deploy response' }
    }

    // The hash gate. The agent already verifies bytes+sha against the staged
    // descriptor before unpacking, so a mismatch here means the agent applied a
    // DIFFERENT bundle than the one this deploy staged — the failure mode a
    // `✓` must never be printed over. Refuse before telling it to load them.
    const applied = deployRaw.appliedSha256
    if (applied !== undefined && applied !== source.sha256) {
      logger.error('agent deploy: applied bundle hash does not match the shipped bundle', {
        meta: { nodeId, packageName, expected: source.sha256, applied },
      })
      return {
        nodeId,
        success: false,
        error: `applied bundle hash mismatch (shipped ${source.sha256}, agent applied ${applied})`,
      }
    }
    if (applied === undefined) {
      logger.warn('agent deploy: node did not report an applied bundle hash — UNVERIFIED', {
        meta: { nodeId, packageName },
      })
    }

    logger.info('agent deploy: bundle applied', {
      meta: { nodeId, packageName, path: deployRaw.path, verifiedSha256: applied },
    })

    // Reload. Without this the deploy is write-to-disk-only and the node keeps
    // running the previous dist — the whole point of this module.
    const reloadRaw = await broker.call(
      '$agent.reload',
      {},
      { nodeID: nodeId, timeout: AGENT_RELOAD_TIMEOUT_MS },
    )
    const loaded = readLoaded(reloadRaw)
    if (loaded.length === 0) {
      // Not fatal — a reload can legitimately find nothing to (re)instantiate
      // when a concurrent deploy already did it. But it is the exact shape of
      // the silent no-op, so it is never allowed to pass unlogged.
      logger.warn('agent deploy: reload loaded NOTHING — node may still run the previous code', {
        meta: { nodeId, packageName },
      })
    } else {
      logger.info('agent deploy: reloaded', { meta: { nodeId, packageName, loaded } })
    }

    return {
      nodeId,
      success: true,
      addonId: deployRaw.addonId,
      ...(deployRaw.path === undefined ? {} : { path: deployRaw.path }),
      loaded,
      ...(applied === undefined ? {} : { verifiedSha256: applied }),
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('agent deploy: FAILED', { meta: { nodeId, packageName, error: message } })
    return { nodeId, success: false, error: message }
  } finally {
    closeWindow?.()
  }
}
