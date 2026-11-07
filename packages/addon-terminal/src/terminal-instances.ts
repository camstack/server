import { z } from 'zod'
import { isInstanceEnabled } from '@camstack/types'
import { newTerminalCameraStableId, type TerminalBody } from './terminal-record-kinds.js'

const TerminalInstanceSchema = z.object({
  id: z.string().uuid(),
  cameraStableId: z.string().min(1).max(256),
  nodeId: z.string().min(1).max(256),
  profileId: z.string().min(1).max(64),
  profileLabel: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  enabled: z.boolean(),
  executable: z.string().max(1024).default(''),
  args: z.array(z.string().max(2048)).max(64).default([]),
  cwd: z.string().max(1024).default(''),
  environment: z.array(z.string().max(4096)).max(64).default([]),
  profileSettings: z.record(z.string(), z.unknown()).default({}),
})

export type TerminalInstance = z.infer<typeof TerminalInstanceSchema>

export function environmentEntriesToRecord(
  entries: readonly string[],
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const entry of entries) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    out[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return out
}

export function environmentRecordToEntries(
  env: Readonly<Record<string, string>> | undefined,
): readonly string[] {
  if (env === undefined) return []
  return Object.entries(env).map(([name, value]) => `${name}=${value}`)
}

/**
 * Config is operator-writable, so malformed or duplicate rows are ignored
 * rather than allowed to make declaration reconciliation destructive.
 */
export function readTerminalInstances(
  raw: readonly Record<string, unknown>[],
  onInvalid?: (message: string) => void,
): readonly TerminalInstance[] {
  const ids = new Set<string>()
  const stableIds = new Set<string>()
  const instances: TerminalInstance[] = []
  for (const value of raw) {
    const parsed = TerminalInstanceSchema.safeParse(value)
    if (!parsed.success) {
      onInvalid?.('Ignoring malformed Terminal instance configuration')
      continue
    }
    const instance = parsed.data
    if (ids.has(instance.id) || stableIds.has(instance.cameraStableId)) {
      onInvalid?.(`Ignoring duplicate Terminal instance ${instance.id}`)
      continue
    }
    ids.add(instance.id)
    stableIds.add(instance.cameraStableId)
    instances.push(instance)
  }
  return instances
}

export { newTerminalCameraStableId }

/** The raw instance a record means: the id is the record id, the switch is the one reader's. */
export function rawInstanceOfRecord(id: string, body: TerminalBody): Record<string, unknown> {
  return {
    id,
    cameraStableId: body.cameraStableId ?? newTerminalCameraStableId(id),
    nodeId: body.nodeId,
    profileId: body.profileId,
    profileLabel: body.profileLabel,
    name: body.name,
    enabled: isInstanceEnabled(body),
    executable: body.executable,
    args: body.args,
    cwd: body.cwd,
    environment: body.environment,
    profileSettings: body.profileSettings,
  }
}

/** A record that names a node and a profile can work; a fresh row waiting for its form cannot. */
export function isTerminalBodyConfigured(body: TerminalBody): boolean {
  return body.nodeId.length > 0 && body.profileId.length > 0
}

export interface LegacyTerminalCameraCandidate {
  readonly stableId: string
  readonly nodeId: string
  readonly profileId: string
  readonly profileLabel: string
  readonly name: string
  readonly adoptable: boolean
}

/** A device row the legacy-camera scan can classify. */
export interface LegacyTerminalCameraRow {
  readonly id: number
  readonly stableId: string
  readonly name: string
  readonly config: Readonly<Record<string, unknown>>
}

/** Identity of a candidate row that was dropped for want of a `nodeId`. */
export interface LegacyTerminalCameraSkip {
  readonly deviceId: number
  readonly stableId: string
}

/**
 * Legacy automatic cameras are migration candidates only. A tombstone is
 * durable deletion intent, so a lingering failed device removal must never
 * make that camera adoptable again.
 *
 * ## `config` is load-bearing — this read can never be `projection: 'slim'`
 *
 * `nodeId`, `profileId` and `profileLabel` all live in the device's `config`,
 * and a row without `nodeId` is skipped. The slim projection returns
 * `config: {}` for every row, so a slim answer here is shape-identical to a
 * fleet that has no legacy cameras — the whole migration section disappears
 * and nothing says why. `legacy-camera-read-shape.spec.ts` is the arm on that.
 *
 * `onSkipped` is why the disappearance would now be visible: a row that LOOKS
 * like a legacy camera (`terminal-camera-*`, not an instance camera, not
 * tombstoned, not already adopted) but carries no `nodeId` is reported with
 * its numeric device id, so the caller can log it per-camera. Rows that are
 * not candidates at all are silent — a fleet of 1 017 devices must not
 * produce 1 017 lines to say none of them is a Terminal monitor.
 */
export function listLegacyTerminalCameraCandidates(
  rows: readonly LegacyTerminalCameraRow[],
  instanceStableIds: ReadonlySet<string>,
  tombstones: ReadonlySet<string>,
  onSkipped?: (skip: LegacyTerminalCameraSkip) => void,
): readonly LegacyTerminalCameraCandidate[] {
  const legacy: LegacyTerminalCameraCandidate[] = []
  for (const row of rows) {
    if (
      tombstones.has(row.stableId) ||
      instanceStableIds.has(row.stableId) ||
      row.stableId.startsWith('terminal-camera-instance-') ||
      !row.stableId.startsWith('terminal-camera-')
    ) {
      continue
    }
    const nodeId = typeof row.config.nodeId === 'string' ? row.config.nodeId : null
    if (!nodeId) {
      onSkipped?.({ deviceId: row.id, stableId: row.stableId })
      continue
    }
    const profileId = typeof row.config.profileId === 'string' ? row.config.profileId : 'monitor'
    const profileLabel =
      typeof row.config.profileLabel === 'string'
        ? row.config.profileLabel
        : profileId === 'monitor'
          ? 'BTM'
          : profileId
    legacy.push({
      stableId: row.stableId,
      nodeId,
      profileId,
      profileLabel,
      name: row.name,
      adoptable: profileId === 'monitor' && row.stableId === `terminal-camera-${nodeId}`,
    })
  }
  return legacy
}

/** Serializes config read-modify-write operations and their reconciliation. */
export class TerminalInstanceMutationQueue {
  private tail: Promise<void> = Promise.resolve()

  async run<T>(mutation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release: (() => void) | undefined
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await mutation()
    } finally {
      release?.()
    }
  }
}

/**
 * Coalesces periodic/config reconciliation requests onto the same serialized
 * lane as instance mutations. A pass never applies a declaration snapshot
 * concurrently with a create/delete/enable write.
 */
export class TerminalInstanceReconcileCoordinator {
  private dirty = false
  private running: Promise<void> | null = null

  constructor(private readonly queue: TerminalInstanceMutationQueue) {}

  request(apply: () => Promise<void>): Promise<void> {
    this.dirty = true
    if (this.running) return this.running
    const running = this.queue.run(async () => {
      while (this.dirty) {
        this.dirty = false
        await apply()
      }
    })
    this.running = running.finally(() => {
      this.running = null
    })
    return this.running
  }
}

export interface AbsentNodeOutcome {
  /** Instances whose node was absent on THIS read and the previous one. */
  readonly confirmed: readonly TerminalInstance[]
  /** Instance ids whose node is absent on this read — the streak to carry. */
  readonly absentNow: ReadonlySet<string>
}

/**
 * Instances bound to a node the cluster no longer lists at all.
 *
 * An OFFLINE node is still in the topology; a FORGOTTEN or renamed one is not.
 * Such an instance is NEVER removed on its own: it is the operator's
 * configuration, and the node may have come back under another id. It is
 * reported (alert, `nodeInCluster: false`) once two consecutive reads agree
 * (D49), and stays until the operator re-points or deletes it.
 */
export function instancesOnAbsentNodes(
  instances: readonly TerminalInstance[],
  knownNodeIds: ReadonlySet<string>,
  absentBefore: ReadonlySet<string>,
): AbsentNodeOutcome {
  const absentNow = new Set<string>()
  const confirmed: TerminalInstance[] = []
  for (const instance of instances) {
    if (knownNodeIds.has(instance.nodeId)) continue
    absentNow.add(instance.id)
    if (absentBefore.has(instance.id)) confirmed.push(instance)
  }
  return { confirmed, absentNow }
}
