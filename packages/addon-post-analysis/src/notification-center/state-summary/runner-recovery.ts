/**
 * Is a crash-looped runner RUNNING again? (D708) — the summary's recovery
 * reconcile for `addon-crash-loop`.
 *
 * The crash-loop row opens on `addon.runner-failed` (the D6 breaker giving up)
 * and closed only on an `addon.started` naming one of its addons, a node
 * liveness edge or a server update. A CORE BLOCK runner (`core-block-<id>`) is
 * not a registry addon and never emits `addon.started`: re-enabled, updated or
 * respawned, its row stayed open, and the 2026-10-06 12:00 summary still said
 * "hub — core-block-01b86c71… stopped after repeated crashes (since 4 Oct)"
 * for a block that had been running for two days.
 *
 * Events are telemetry (D8): a recovery is read from the owner's STATE, once
 * per summary, like the node directory. Only a positive answer closes a row —
 * a read that fails, or that does not name the runner, changes nothing (D49):
 *
 * - a core block runner: `core-blocks.list`, its block's `status === 'running'`;
 * - any other runner: `nodes.getNodeAddons(nodeId)`, EVERY addon the trip
 *   named reported `running`. (That method answers `[]` for an agent it could
 *   not reach — no addon found is "no evidence", never "recovered".)
 */
import { coreBlockIdFromAddonId } from '@camstack/types'
import type { NcCrashLoopRunner } from './system-state-ledger.js'

/** A runner-ish thing and its lifecycle state, as both reads answer it. */
export interface NcRunnerStatusEntry {
  readonly id: string
  readonly status: string
}

/** The two owner reads. Each may throw; a throw costs only the runners it would have answered. */
export interface NcRunnerStateReads {
  /** `core-blocks.list` — the block id and its status. */
  readonly coreBlocks: () => Promise<readonly NcRunnerStatusEntry[]>
  /** `nodes.getNodeAddons` — the addons on one node and their status. */
  readonly nodeAddons: (nodeId: string) => Promise<readonly NcRunnerStatusEntry[]>
}

export interface NcRunnerRecoveryAnswer {
  /** Keys of the crash-loop rows whose runner is PROVEN running now. */
  readonly running: ReadonlySet<string>
  /** The reads that failed, named — the caller logs them; nothing they cover was closed. */
  readonly failed: readonly string[]
}

const RUNNING = 'running'

export async function readRunningRunners(
  reads: NcRunnerStateReads,
  runners: readonly NcCrashLoopRunner[],
): Promise<NcRunnerRecoveryAnswer> {
  const running = new Set<string>()
  const failed: string[] = []
  const attempt = async <T>(what: string, read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read()
    } catch (err) {
      failed.push(`${what}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  const blockRunners = runners.filter((runner) => coreBlockIdFromAddonId(runner.runnerId) !== null)
  if (blockRunners.length > 0) {
    const blocks = await attempt('core-blocks.list', reads.coreBlocks)
    if (blocks !== null) {
      const status = new Map(blocks.map((block) => [block.id, block.status]))
      for (const runner of blockRunners) {
        const blockId = coreBlockIdFromAddonId(runner.runnerId)
        if (blockId !== null && status.get(blockId) === RUNNING) running.add(runner.key)
      }
    }
  }

  const addonRunners = runners.filter((runner) => coreBlockIdFromAddonId(runner.runnerId) === null)
  for (const nodeId of new Set(addonRunners.map((runner) => runner.nodeId))) {
    const addons = await attempt(`nodes.getNodeAddons(${nodeId})`, () => reads.nodeAddons(nodeId))
    if (addons === null) continue
    const status = new Map(addons.map((addon) => [addon.id, addon.status]))
    for (const runner of addonRunners) {
      if (runner.nodeId !== nodeId) continue
      if (runner.addonIds.every((id) => status.get(id) === RUNNING)) running.add(runner.key)
    }
  }
  return { running, failed }
}
