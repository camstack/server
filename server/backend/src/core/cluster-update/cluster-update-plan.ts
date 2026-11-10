/**
 * What a cluster update WOULD do: read every node from the topology (never
 * from a remembered list), resolve the target, and lay out the steps. Reads
 * only. A read that failed is a reason, never "up to date" (D315, D393).
 */
import {
  compareVersions,
  type ClusterUpdateOptions,
  type ClusterUpdatePlan,
  type ClusterUpdateStep,
  type ServerPackageStatus,
} from '@camstack/types'
import { errText, type ClusterUpdateSeams } from './cluster-update-seams.js'

/** Does a node running `status` need the target? Unknown running = yes. */
export function needsServer(status: ServerPackageStatus, target: string): boolean {
  if (status.restartRequired === true) return true
  const running = status.runningVersion
  return running === null || compareVersions(running, target) < 0
}

function isBusy(status: ServerPackageStatus): boolean {
  return status.updateState === 'staging' || status.updateState === 'pending-restart'
}

function blocked(
  blocker: NonNullable<ClusterUpdatePlan['blocker']>,
  detail: string,
  target: string | null,
  steps: readonly ClusterUpdateStep[] = [],
  skippedOffline: readonly string[] = [],
): ClusterUpdatePlan {
  return {
    targetVersion: target,
    steps,
    skippedOffline,
    blocker,
    blockerDetail: detail,
  }
}

function backupStep(options: ClusterUpdateOptions): ClusterUpdateStep {
  return options.backup === false
    ? {
        kind: 'backup',
        status: 'skipped',
        detail: 'backup opted out by the caller',
      }
    : {
        kind: 'backup',
        status: 'pending',
        detail: 'back up before touching any node',
      }
}

/** Plan the update. `null` blocker = it can start. */
export async function readClusterUpdatePlan(
  seams: ClusterUpdateSeams,
  options: ClusterUpdateOptions,
): Promise<ClusterUpdatePlan> {
  let hubStatus: ServerPackageStatus
  try {
    hubStatus = await seams.readServerStatus(null)
  } catch (err) {
    return blocked('status-unreadable', `the hub's status is unreadable: ${errText(err)}`, null)
  }
  const target = options.version ?? hubStatus.latestVersion ?? null
  if (target === null) {
    return blocked(
      'no-target',
      'the hub has no registry check yet (latestVersion is null): run a check or pass a version',
      null,
    )
  }
  const topology = await seams.readTopology()
  const offline = topology.filter((n) => !n.isHub && !n.isOnline).map((n) => n.id)
  const busy: string[] = []
  if (isBusy(hubStatus)) busy.push(`hub (${hubStatus.updateState})`)

  const hubStep: ClusterUpdateStep = needsServer(hubStatus, target)
    ? {
        kind: 'hub-server',
        nodeId: 'hub',
        status: 'pending',
        fromVersion: hubStatus.runningVersion,
        detail: `${hubStatus.runningVersion ?? 'unknown'} -> ${target}`,
      }
    : {
        kind: 'hub-server',
        nodeId: 'hub',
        status: 'skipped',
        fromVersion: hubStatus.runningVersion,
        detail: `already on ${hubStatus.runningVersion ?? target}`,
      }

  const agentSteps: ClusterUpdateStep[] = []
  for (const node of topology) {
    if (node.isHub || !node.isOnline) continue
    let status: ServerPackageStatus | null = null
    try {
      status = await seams.readServerStatus(node.id)
    } catch {
      status = null
    }
    if (status !== null && isBusy(status)) busy.push(`${node.id} (${status.updateState})`)
    if (status === null || needsServer(status, target)) {
      agentSteps.push({
        kind: 'agent-server',
        nodeId: node.id,
        status: 'pending',
        fromVersion: status?.runningVersion ?? null,
        detail:
          status === null
            ? `status unreadable now; read again when its turn comes`
            : `${status.runningVersion ?? 'unknown'} -> ${target}`,
      })
    }
  }

  let addonUpdates: readonly {
    name: string
    currentVersion: string
    latestVersion: string
  }[] = []
  if (options.addons !== false) {
    try {
      addonUpdates = await seams.listAddonUpdates()
    } catch (err) {
      seams.logger.warn('Cluster update plan: addon updates unreadable', {
        meta: { error: errText(err) },
      })
    }
  }
  const addonsStep: ClusterUpdateStep =
    options.addons === false
      ? {
          kind: 'addons',
          status: 'skipped',
          detail: 'addons opted out by the caller',
        }
      : {
          kind: 'addons',
          status: 'pending',
          detail:
            addonUpdates.length > 0
              ? `${addonUpdates.length} addon(s) behind; the list is read again after the servers`
              : 'no addon update pending now; read again after the servers',
          packages: addonUpdates.map((u) => `${u.name} ${u.currentVersion} -> ${u.latestVersion}`),
        }

  const steps = [backupStep(options), hubStep, ...agentSteps, addonsStep]
  if (busy.length > 0) {
    return blocked(
      'node-busy',
      `a node is mid-update: ${busy.join(', ')}; wait for it to settle`,
      target,
      steps,
      offline,
    )
  }
  if (hubStep.status === 'skipped' && agentSteps.length === 0 && addonUpdates.length === 0) {
    return blocked(
      'nothing-to-do',
      `every online node runs ${target} and no addon update is pending`,
      target,
      steps,
      offline,
    )
  }
  return {
    targetVersion: target,
    steps,
    skippedOffline: offline,
    blocker: null,
    blockerDetail: null,
  }
}
