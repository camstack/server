import { z } from 'zod'
import { isInstanceEnabled } from '@camstack/types'
import type { TerminalBody } from './terminal-record-kinds.js'

const TerminalInstanceSchema = z.object({
  id: z.string().uuid(),
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
 * rather than allowed to make a reconciliation destructive.
 */
export function readTerminalInstances(
  raw: readonly Record<string, unknown>[],
  onInvalid?: (message: string) => void,
): readonly TerminalInstance[] {
  const ids = new Set<string>()
  const instances: TerminalInstance[] = []
  for (const value of raw) {
    const parsed = TerminalInstanceSchema.safeParse(value)
    if (!parsed.success) {
      onInvalid?.('Ignoring malformed Terminal instance configuration')
      continue
    }
    const instance = parsed.data
    if (ids.has(instance.id)) {
      onInvalid?.(`Ignoring duplicate Terminal instance ${instance.id}`)
      continue
    }
    ids.add(instance.id)
    instances.push(instance)
  }
  return instances
}

/** The raw instance a record means: the id is the record id, the switch is the one reader's. */
export function rawInstanceOfRecord(id: string, body: TerminalBody): Record<string, unknown> {
  return {
    id,
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
