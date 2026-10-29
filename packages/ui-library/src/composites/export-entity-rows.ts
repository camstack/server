/**
 * The action and notification-target rows of the device export table (D968).
 *
 * An action and a notifier are list entries, never devices (D954): they are
 * merged into the SAME table as extra rows, built only from the kinds the
 * exporter answered. A kinds list that was not answered is UNKNOWN, not
 * "supports nothing" (D315) — it yields devices only and no filter entry, and
 * says nothing about what the exporter cannot do.
 *
 * Pure functions, so the rules are pinned without a DOM.
 */
import { ExportEntityKindSchema, ExposedEntitySchema } from '@camstack/types'
import { z } from 'zod'

/** The kinds this module builds rows for. A device is the table's own row. */
export type ExportEntityRowKind = 'action' | 'notifier'

export type ExportEntityRowRef =
  | { readonly kind: 'action'; readonly actionId: string }
  | { readonly kind: 'notifier'; readonly targetId: string }

export interface ExportEntityRow {
  readonly kind: ExportEntityRowKind
  /** Unique in the table and never a device id (those are numeric). */
  readonly key: string
  readonly ref: ExportEntityRowRef
  readonly name: string
  readonly exposed: boolean
}

/** The type-filter ids of the entity kinds, apart from every device type. */
export const ENTITY_FILTER_IDS: Readonly<Record<ExportEntityRowKind, string>> = {
  action: 'entity:action',
  notifier: 'entity:notifier',
}

const KindsSchema = z.array(ExportEntityKindSchema)
const NamedSchema = z.array(z.object({ id: z.string(), name: z.string() }))
const ExposedSchema = z.array(ExposedEntitySchema)

/**
 * The non-device kinds the exporter answered, or null when it did not answer
 * (unknown — never an empty set).
 */
export function supportedEntityKinds(data: unknown): ReadonlySet<ExportEntityRowKind> | null {
  const parsed = KindsSchema.safeParse(data)
  if (!parsed.success) return null
  const kinds = new Set<ExportEntityRowKind>()
  for (const kind of parsed.data) {
    if (kind === 'action' || kind === 'notifier') kinds.add(kind)
  }
  return kinds
}

export interface BuildEntityRowsInput {
  readonly kinds: ReadonlySet<ExportEntityRowKind> | null
  readonly actions: unknown
  readonly targets: unknown
  readonly exposed: unknown
}

export function buildEntityRows(input: BuildEntityRowsInput): readonly ExportEntityRow[] {
  const { kinds } = input
  if (kinds === null) return []
  const exposed = ExposedSchema.safeParse(input.exposed)
  const exposedActions = new Set<string>()
  const exposedTargets = new Set<string>()
  if (exposed.success) {
    for (const row of exposed.data) {
      if (row.entity.kind === 'action') exposedActions.add(row.entity.actionId)
      else if (row.entity.kind === 'notifier') exposedTargets.add(row.entity.targetId)
    }
  }
  const rows: ExportEntityRow[] = []
  if (kinds.has('action')) {
    const actions = NamedSchema.safeParse(input.actions)
    for (const a of actions.success ? actions.data : []) {
      rows.push({
        kind: 'action',
        key: `action:${a.id}`,
        ref: { kind: 'action', actionId: a.id },
        name: a.name,
        exposed: exposedActions.has(a.id),
      })
    }
  }
  if (kinds.has('notifier')) {
    const targets = NamedSchema.safeParse(input.targets)
    for (const t of targets.success ? targets.data : []) {
      rows.push({
        kind: 'notifier',
        key: `notifier:${t.id}`,
        ref: { kind: 'notifier', targetId: t.id },
        name: t.name,
        exposed: exposedTargets.has(t.id),
      })
    }
  }
  return rows
}

/** The type-filter ids to add beside the device types: one per SUPPORTED kind. */
export function entityFilterOptionIds(
  kinds: ReadonlySet<ExportEntityRowKind> | null,
): readonly string[] {
  if (kinds === null) return []
  const ids: string[] = []
  if (kinds.has('action')) ids.push(ENTITY_FILTER_IDS.action)
  if (kinds.has('notifier')) ids.push(ENTITY_FILTER_IDS.notifier)
  return ids
}
