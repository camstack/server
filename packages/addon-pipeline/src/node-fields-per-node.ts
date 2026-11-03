/**
 * Fields that were stored ONCE for the cluster but are facts of ONE node become node settings
 * (D986): a node's row is `<addonId>.<key>@<nodeId>` carrying `nodeId`, and a node never falls
 * back to a bare row. The engine's ledger holds one row per migration id for the whole cluster
 * and ignores `meta.scope`, so a migration cannot run once per node: the ONE plan writes the
 * rows of every node in `ports.nodeIds()`, and a node that joins later starts from the schema
 * default (the rule for any node setting).
 *
 * A bare row is COPIED (the bare row stays for a release) and a value already on a node row is
 * never overwritten (a seed never overwrites).
 *
 * Twins: two keys that carried one fact. The survivor is the key the code keeps reading; the
 * loser folds in only when the survivor is unset. Both set and different is a decision only the
 * operator can take, so the plan throws and writes nothing. A loser is never deleted: its row
 * is renamed `<key>~superseded` (a node row `<key>~superseded@<nodeId>`), so its value stays on
 * disk, unreachable by the live key, recoverable by hand.
 *
 * Idempotent: with every node row copied and every loser parked the plan is empty.
 */
import { type MigrationPlan, preconditionOf, type StoredKeyRead } from '@camstack/types'

/** The canonical settings table: one row per key, id `<addonId>.<key>`. */
export const ADDON_SETTINGS_TABLE = 'addon-settings'

export const SUPERSEDED_SUFFIX = '~superseded'

export interface NodeFieldTwin {
  /** The key the code keeps reading. */
  readonly survivor: string
  /** The key that folds into the survivor and is then parked. */
  readonly loser: string
}

export interface NodeFieldsPorts {
  /**
   * The addon's rows as stored (markers kept, nothing resolved), for each of `keys` that has
   * a row; a key without one is left out. Throws when the store cannot be read.
   */
  readStored(keys: readonly string[]): Promise<Readonly<Record<string, unknown>>>
  /** Every node the field is copied to. Throws when the cluster's nodes cannot be listed. */
  nodeIds(): Promise<readonly string[]>
}

export const nodeKeyOf = (key: string, nodeId: string): string => `${key}@${nodeId}`

const isSet = (value: unknown): boolean => value !== undefined && value !== null

/** The row as the settings writer stores it, node rows carrying `nodeId`. */
function rowOf(
  addonId: string,
  key: string,
  value: unknown,
  nodeId: string | null,
): Record<string, unknown> {
  return nodeId === null ? { addonId, key, value } : { addonId, key, value, nodeId }
}

/** A twin the plan cannot fold without choosing a value for the operator. */
export class NodeFieldTwinConflictError extends Error {
  constructor(readonly conflicts: readonly string[]) {
    super(
      `twin settings disagree, nothing was written (set one value and retry): ${conflicts.join('; ')}`,
    )
    this.name = 'NodeFieldTwinConflictError'
  }
}

interface PlanState {
  readonly stored: Readonly<Record<string, unknown>>
  readonly addonId: string
  readonly sets: Record<string, Record<string, unknown>>
  readonly deletes: Record<string, Record<string, unknown>>
  readonly conflicts: string[]
}

const idOf = (state: PlanState, key: string): string => `${state.addonId}.${key}`

function copyPlain(state: PlanState, key: string, nodeId: string): void {
  const target = nodeKeyOf(key, nodeId)
  if (!(key in state.stored) || target in state.stored) return
  state.sets[idOf(state, target)] = rowOf(state.addonId, target, state.stored[key], nodeId)
}

function park(state: PlanState, key: string, nodeId: string | null): void {
  const from = nodeId === null ? key : nodeKeyOf(key, nodeId)
  if (!(from in state.stored)) return
  const parked =
    nodeId === null ? `${key}${SUPERSEDED_SUFFIX}` : nodeKeyOf(`${key}${SUPERSEDED_SUFFIX}`, nodeId)
  state.deletes[idOf(state, from)] = rowOf(state.addonId, from, state.stored[from], nodeId)
  if (!(parked in state.stored)) {
    state.sets[idOf(state, parked)] = rowOf(state.addonId, parked, state.stored[from], nodeId)
  }
}

function foldTwin(state: PlanState, twin: NodeFieldTwin, nodeId: string): void {
  const survivorKey = nodeKeyOf(twin.survivor, nodeId)
  const survivor = state.stored[survivorKey] ?? state.stored[twin.survivor]
  const loser = state.stored[nodeKeyOf(twin.loser, nodeId)] ?? state.stored[twin.loser]
  if (isSet(survivor) && isSet(loser) && JSON.stringify(survivor) !== JSON.stringify(loser)) {
    state.conflicts.push(
      `${twin.survivor}=${JSON.stringify(survivor)} vs ${twin.loser}=${JSON.stringify(loser)} on ${nodeId}`,
    )
    return
  }
  const folded = isSet(survivor) ? survivor : loser
  if (isSet(folded) && !(survivorKey in state.stored)) {
    state.sets[idOf(state, survivorKey)] = rowOf(state.addonId, survivorKey, folded, nodeId)
  }
  park(state, twin.loser, nodeId)
}

export async function planNodeFields(
  addonId: string,
  plain: readonly string[],
  twins: readonly NodeFieldTwin[],
  ports: NodeFieldsPorts,
): Promise<MigrationPlan> {
  const nodes = await ports.nodeIds()
  const names = [...plain, ...twins.flatMap((t) => [t.survivor, t.loser])]
  const stored = await ports.readStored([
    ...names,
    ...nodes.flatMap((nodeId) => names.map((key) => nodeKeyOf(key, nodeId))),
  ])
  const state: PlanState = { stored, addonId, sets: {}, deletes: {}, conflicts: [] }
  for (const nodeId of nodes) {
    for (const key of plain) copyPlain(state, key, nodeId)
    for (const twin of twins) {
      // A survivor kept as a bare row copies like a plain field; the twin fold sees the copy.
      foldTwin(state, twin, nodeId)
    }
  }
  if (state.conflicts.length > 0) throw new NodeFieldTwinConflictError(state.conflicts)
  for (const twin of twins) park(state, twin.loser, null)
  const setIds = Object.keys(state.sets)
  const deleteIds = Object.keys(state.deletes)
  if (setIds.length === 0 && deleteIds.length === 0) return { edits: [] }
  const created = new Set(setIds)
  return {
    edits: [
      ...(setIds.length === 0
        ? []
        : [
            {
              op: 'setKeys' as const,
              scope: ADDON_SETTINGS_TABLE,
              values: state.sets,
              // Every target row was absent when the plan read; a row that appeared since refuses it.
              precondition: preconditionOf(Object.fromEntries(setIds.map((id) => [id, null]))),
            },
          ]),
      ...(deleteIds.length === 0
        ? []
        : [
            {
              op: 'deleteKeys' as const,
              scope: ADDON_SETTINGS_TABLE,
              keys: deleteIds.filter((id) => !created.has(id)),
              precondition: preconditionOf(
                Object.fromEntries(
                  deleteIds.filter((id) => !created.has(id)).map((id) => [id, state.deletes[id]]),
                ),
              ),
            },
          ]),
    ],
  }
}

/**
 * The port's read over an addon's three-way key read: each of `keys` that has a row, raw. A key
 * the store could not answer for throws, so the migration fails instead of treating a failed read
 * as "nothing to copy".
 */
export async function readRawKeys(
  read: (key: string) => Promise<StoredKeyRead>,
  addonId: string,
  keys: readonly string[],
): Promise<Record<string, unknown>> {
  const found: Record<string, unknown> = {}
  for (const key of keys) {
    const answer = await read(key)
    if (answer.kind === 'unreadable') {
      throw new Error(`${addonId}: the setting ${key} cannot be read (${answer.reason})`)
    }
    if (answer.kind === 'present') found[key] = answer.value
  }
  return found
}

/**
 * Every node the hub knows (online or not) plus this one. A node the directory does not list
 * yet is this one while it boots. Throws when the directory cannot be read: a copy that missed
 * a node must fail, not report done.
 */
export async function clusterNodeIds(
  directory: () => Promise<{ readonly nodes: readonly { readonly id: string }[] }>,
  localNodeId: string | undefined,
): Promise<readonly string[]> {
  const listed = (await directory()).nodes.map((node) => node.id)
  const self = (localNodeId ?? 'hub').split('/')[0] ?? 'hub'
  return [...new Set([self === '' ? 'hub' : self, ...listed])]
}
