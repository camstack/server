/**
 * The four step kinds of a cluster update, each one VERIFIED before it says
 * `ok`. Every wait is bounded; an expiring timer is a failure with a typed
 * reason, never a loop (D6) and never a silent pass.
 */
import type {
  BackupRun,
  ClusterUpdateFailureReason,
  ServerPackageStatus,
  ServerUpdateActionResult,
} from '@camstack/types'
import {
  errText,
  type ClusterAddonUpdate,
  type ClusterBackupClient,
  type ClusterUpdateSeams,
} from './cluster-update-seams.js'

export interface StepOutcome {
  readonly status: 'ok' | 'failed' | 'skipped'
  readonly detail: string
  readonly reason?: ClusterUpdateFailureReason
  readonly packages?: readonly string[]
}

interface NotReady {
  readonly reason: ClusterUpdateFailureReason
  readonly why: string
}

type WaitResult = { readonly ok: true } | { readonly ok: false; readonly last: NotReady }

async function waitUntil(
  seams: ClusterUpdateSeams,
  timeoutMs: number,
  check: () => Promise<NotReady | null>,
): Promise<WaitResult> {
  const deadline = seams.now() + timeoutMs
  for (;;) {
    const notReady = await check()
    if (notReady === null) return { ok: true }
    if (seams.now() >= deadline) return { ok: false, last: notReady }
    await seams.sleep(seams.timeouts.pollMs)
  }
}

function failed(reason: ClusterUpdateFailureReason, detail: string): StepOutcome {
  return { status: 'failed', reason, detail }
}

// ---------------------------------------------------------------------------
// backup

/** The backup addon stamps `requestedAt` with its own clock (same host). */
const CLOCK_SLACK_MS = 5_000

const TERMINAL_RUN = new Set(['succeeded', 'failed', 'cancelled'])

/**
 * Back up before anything moves. `backup.trigger` resolves when the run ends;
 * a trigger call that drops (timeout across a long archive) is reconciled by
 * finding the run by its unique label, never by guessing from the error.
 */
export async function runBackupStep(
  seams: ClusterUpdateSeams,
  label: string,
): Promise<StepOutcome> {
  const backup = seams.getBackup()
  if (backup === null) {
    return failed(
      'backup-unavailable',
      'no backup provider is running; start one, or run the update with backup off',
    )
  }
  const startedAt = seams.now()
  try {
    const result = await backup.trigger(label)
    if (result.cancelled) return failed('backup-failed', `backup run ${result.runId} was cancelled`)
    if (result.entries.length === 0) {
      return failed('backup-failed', `backup run ${result.runId} landed at no destination`)
    }
    return {
      status: 'ok',
      detail: `backup run ${result.runId} landed at ${result.entries.length} destination(s)`,
    }
  } catch (err) {
    return reconcileBackup(seams, backup, label, startedAt, errText(err))
  }
}

/** The trigger call dropped: find the run by its label and wait for it to end. */
async function reconcileBackup(
  seams: ClusterUpdateSeams,
  backup: ClusterBackupClient,
  label: string,
  startedAt: number,
  dropped: string,
): Promise<StepOutcome> {
  let run: BackupRun | undefined
  const wait = await waitUntil(seams, seams.timeouts.serverMs, async () => {
    try {
      const runs = await backup.listRuns()
      run = runs.find((r) => r.label === label && r.requestedAt >= startedAt - CLOCK_SLACK_MS)
    } catch (readErr) {
      return {
        reason: 'backup-failed',
        why: `runs unreadable: ${errText(readErr)}`,
      }
    }
    if (run === undefined) return { reason: 'backup-failed', why: `trigger failed: ${dropped}` }
    if (!TERMINAL_RUN.has(run.state)) {
      return {
        reason: 'backup-failed',
        why: `run ${run.id} still ${run.state}`,
      }
    }
    return null
  })
  if (!wait.ok || run === undefined) {
    return failed('backup-failed', wait.ok ? `trigger failed: ${dropped}` : wait.last.why)
  }
  if (run.state !== 'succeeded' || run.completedDestinationIds.length === 0) {
    return failed(
      'backup-failed',
      `backup run ${run.id} ended ${run.state}${run.error ? `: ${run.error}` : ''}`,
    )
  }
  return {
    status: 'ok',
    detail: `backup run ${run.id} landed at ${run.completedDestinationIds.length} destination(s)`,
  }
}

// ---------------------------------------------------------------------------
// servers

/** The node runs `target`, settled, online, with its capabilities registered. */
export async function nodeNotReady(
  seams: ClusterUpdateSeams,
  nodeId: string | null,
  target: string,
): Promise<NotReady | null> {
  let status: ServerPackageStatus
  try {
    status = await seams.readServerStatus(nodeId)
  } catch (err) {
    return {
      reason: 'status-unreadable',
      why: `status unreadable (${errText(err)})`,
    }
  }
  if (status.runningVersion !== target) {
    return {
      reason: 'server-not-on-target',
      why: `still running ${status.runningVersion ?? 'unknown'}, target ${target}`,
    }
  }
  if (status.restartRequired === true) {
    return { reason: 'server-not-on-target', why: 'restart still required' }
  }
  if (status.updateState !== 'idle') {
    return {
      reason: 'server-not-on-target',
      why: `update state ${status.updateState}`,
    }
  }
  if (nodeId === null) return null
  const topology = await seams.readTopology()
  const node = topology.find((n) => n.id === nodeId)
  if (node === undefined) return { reason: 'server-not-on-target', why: 'absent from the topology' }
  if (!node.isOnline) return { reason: 'server-not-on-target', why: 'not online yet' }
  const capless =
    node.capabilitiesRegistered === false ||
    (node.capabilitiesRegistered === undefined && node.capabilityCount === 0)
  if (capless) {
    return {
      reason: 'node-capless',
      why: 'online on the target but registered no capabilities',
    }
  }
  return null
}

/** Did the apply answer say "this will not happen"? */
function refusal(result: ServerUpdateActionResult): string | null {
  if (result.outcome === 'already-current') return null
  if (result.outcome === 'refused' || result.outcome === 'failed' || !result.accepted) {
    const blockers = (result.blockers ?? []).map((b) => `${b.addonId}: ${b.reason}`).join('; ')
    return `${result.outcome ?? 'not accepted'}: ${result.reason ?? result.error ?? result.message}${blockers ? ` [would refuse to start: ${blockers}]` : ''}`
  }
  return null
}

/**
 * Apply the target on one node and wait until it RUNS it. A dropped call is
 * the expected path while the node restarts under it — the wait decides.
 * For the hub this wait is normally cut short by the hub's own restart; the
 * resumed job verifies it (`verifyServerStep`).
 */
export async function runServerStep(
  seams: ClusterUpdateSeams,
  nodeId: string | null,
  target: string,
): Promise<StepOutcome> {
  const name = nodeId ?? 'hub'
  let note = ''
  try {
    const result = await seams.applyServerUpdate(nodeId, target)
    const refused = refusal(result)
    if (refused !== null) return failed('server-refused', `${name} refused the update (${refused})`)
    note = result.outcome ?? ''
  } catch (err) {
    note = `no reply (${errText(err)}); expected while the node restarts`
  }
  return verifyServerStep(seams, nodeId, target, note)
}

export async function verifyServerStep(
  seams: ClusterUpdateSeams,
  nodeId: string | null,
  target: string,
  note: string,
): Promise<StepOutcome> {
  const name = nodeId ?? 'hub'
  const wait = await waitUntil(seams, seams.timeouts.serverMs, () =>
    nodeNotReady(seams, nodeId, target),
  )
  if (!wait.ok) return failed(wait.last.reason, `${name} did not reach ${target}: ${wait.last.why}`)
  return {
    status: 'ok',
    detail: `${name} runs ${target}${nodeId === null ? '' : ', capabilities registered'}${note ? ` (${note})` : ''}`,
  }
}

// ---------------------------------------------------------------------------
// addons

/**
 * Update every stale addon on the hub, then verify that the hub runs each new
 * version and that every online agent holding the package matches it.
 * `updatePackage` answers `{success:false}` instead of throwing on some
 * failures; that is a failure here too.
 */
export async function runAddonsStep(seams: ClusterUpdateSeams): Promise<StepOutcome> {
  let updates: readonly ClusterAddonUpdate[]
  try {
    updates = await seams.listAddonUpdates()
  } catch (err) {
    return failed('addon-update-failed', `addon updates unreadable: ${errText(err)}`)
  }
  const packages = updates.map((u) => `${u.name} ${u.currentVersion} -> ${u.latestVersion}`)
  if (updates.length === 0)
    return { status: 'skipped', detail: 'no addon update pending', packages }
  const done: ClusterAddonUpdate[] = []
  for (const u of updates) {
    let error: string | null
    try {
      const result = await seams.updateAddon(u.name, u.latestVersion)
      error = result.success ? null : (result.error ?? 'update failed')
    } catch (err) {
      error = errText(err)
    }
    if (error !== null) {
      const already =
        done.length > 0 ? `; already updated: ${done.map((d) => d.name).join(', ')}` : ''
      return {
        ...failed(
          'addon-update-failed',
          `hub failed to update ${u.name} to ${u.latestVersion}: ${error}${already}`,
        ),
        packages,
      }
    }
    done.push(u)
  }
  const wait = await waitUntil(seams, seams.timeouts.addonsMs, () =>
    addonsNotConverged(seams, done),
  )
  if (!wait.ok) {
    return {
      ...failed(wait.last.reason, `${done.length} addon(s) updated on the hub; ${wait.last.why}`),
      packages,
    }
  }
  return {
    status: 'ok',
    detail: `${done.length} addon(s) updated on the hub and matched on every online agent`,
    packages,
  }
}

async function addonsNotConverged(
  seams: ClusterUpdateSeams,
  done: readonly ClusterAddonUpdate[],
): Promise<NotReady | null> {
  let rows
  try {
    rows = await seams.readInstallations()
  } catch (err) {
    return {
      reason: 'addons-not-converged',
      why: `installations unreadable (${errText(err)})`,
    }
  }
  const behind: string[] = []
  for (const u of done) {
    const hub = rows.find((r) => r.isHub && r.packageName === u.name)
    if (hub === undefined || hub.version !== u.latestVersion) {
      return {
        reason: 'addons-not-converged',
        why: `${u.name} is ${hub?.version ?? 'absent'} on the hub, expected ${u.latestVersion}`,
      }
    }
    for (const r of rows) {
      if (r.isHub || !r.isOnline || r.packageName !== u.name) continue
      if (r.version !== u.latestVersion)
        behind.push(`${r.nodeId}/${u.name}=${r.version ?? 'absent'}`)
    }
  }
  if (behind.length > 0) {
    return {
      reason: 'addons-not-converged',
      why: `agents behind the hub: ${behind.join(', ')}`,
    }
  }
  return null
}
