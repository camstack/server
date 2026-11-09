/**
 * Two shape changes of a stored remote, both owned by core-blocks (it owns the
 * `remote` key of the per-device store and the `templates` kind).
 *
 * 1. `power: { mode }` leaves the configuration. What a Power key and an
 *    explicit on / off do is derived from the bindings now; the stored field is
 *    dropped and nothing else in the config is touched.
 * 2. The four colour keys have ONE set of roles. A remote that bound
 *    `custom:color_a..d` (Samsung's lettering) is renamed to
 *    `custom:color_red|green|yellow|blue` in its bindings, its custom buttons and
 *    the steps of its sequence sources; a stored layout's button with such a role
 *    takes the matching tone and keeps its letter on the key (`showLegend`).
 *
 * The stored value is read as loosely typed JSON on purpose: it is the OLD shape,
 * which `RemoteConfigSchema` no longer describes. Every key this migration does
 * not name is written back exactly as it was, and a rerun finds nothing to do.
 */
import {
  type IScopedLogger,
  type MigrationProcedureResult,
  type RecordKindHandle,
  RemoteLayoutPayloadSchema,
  type RemoteLayoutButton,
} from '@camstack/types'
import { z } from 'zod'
import { readAllRows } from '../../../records/read-all-rows.js'
import type { TemplateRowBody } from '../record-kinds.js'

export const REMOTE_POWER_DROP_ID = 'core-blocks/2026-11-09-remote-power-mode-drop'
export const REMOTE_COLOUR_ROLES_ID = 'core-blocks/2026-11-09-remote-colour-roles'

/** A stored `template` row as the migration reads it. */
export interface StoredTemplateRow {
  readonly id: string
  readonly rev: number
  readonly data: TemplateRowBody
}

export interface RemoteMigrationPorts {
  /** Every device that has a stored remote, with the raw value. Throws when it cannot be read in full. */
  listStoredRemotes(): Promise<readonly { readonly deviceId: number; readonly raw: unknown }[]>
  /** Replace the stored remote of a device. */
  replaceStoredRemote(deviceId: number, raw: Record<string, unknown>): Promise<void>
  listTemplateRows(): Promise<readonly StoredTemplateRow[]>
  replaceTemplateRow(id: string, data: TemplateRowBody, ifRev: number): Promise<void>
  /** A device had both a lettered colour key and its colour role: the lettered one was kept under a new key. */
  warnCollision(deviceId: number, keys: readonly string[]): void
}

/** The device settings view the real ports need. */
export interface RemoteDeviceStores {
  listDeviceStoreIds(): Promise<readonly number[]>
  readDeviceStoreBatch(
    deviceIds: readonly number[],
  ): Promise<ReadonlyMap<number, Record<string, unknown>>>
  writeDeviceStore(deviceId: number, patch: Record<string, unknown>): Promise<void>
}

/** The key of the per-device store that holds the remote (`REMOTE_STORE_KEY` of remote-wiring). */
const STORE_KEY = 'remote'

export function remoteMigrationPortsOver(
  stores: RemoteDeviceStores,
  templates: RecordKindHandle<TemplateRowBody>,
  logger: IScopedLogger,
): RemoteMigrationPorts {
  return {
    listStoredRemotes: async () => {
      const ids = await stores.listDeviceStoreIds()
      if (ids.length === 0) return []
      const batch = await stores.readDeviceStoreBatch(ids)
      return ids.flatMap((deviceId) => {
        const raw = batch.get(deviceId)?.[STORE_KEY]
        return raw === undefined ? [] : [{ deviceId, raw }]
      })
    },
    replaceStoredRemote: async (deviceId, raw) => {
      await stores.writeDeviceStore(deviceId, { [STORE_KEY]: raw })
      logger.info('remote migration: a stored remote was rewritten', { tags: { deviceId } })
    },
    listTemplateRows: async () => {
      const rows = await readAllRows(templates)
      return rows.map((row) => ({ id: row.id, rev: row.rev, data: row.data }))
    },
    replaceTemplateRow: async (id, data, ifRev) => {
      await templates.put({ id, data }, { ifRev })
    },
    warnCollision: (deviceId, keys) => {
      logger.warn(
        `remote migration: ${keys.join(', ')} had a code and so did its colour role; the lettered one is kept as <key>_kept`,
        { tags: { deviceId } },
      )
    },
  }
}

const StoredRemoteSchema = z.looseObject({
  bindings: z.record(z.string(), z.unknown()).optional(),
  customButtons: z.array(z.looseObject({ key: z.string() })).optional(),
  sources: z.array(z.unknown()).optional(),
})
type StoredRemote = z.infer<typeof StoredRemoteSchema>

const StoredSequenceSchema = z.looseObject({
  kind: z.literal('sequence'),
  steps: z.array(z.string()),
})

/** Samsung's lettered keys and the colour each one always was. */
const LETTER_TO_COLOUR: Readonly<Record<string, 'red' | 'green' | 'yellow' | 'blue'>> = {
  color_a: 'red',
  color_b: 'green',
  color_c: 'yellow',
  color_d: 'blue',
}
const LETTER_OF_KEY: Readonly<Record<string, string>> = {
  color_a: 'A',
  color_b: 'B',
  color_c: 'C',
  color_d: 'D',
}
const CUSTOM = 'custom:'

function newKeyOf(key: string): string | null {
  const colour = LETTER_TO_COLOUR[key]
  return colour === undefined ? null : `color_${colour}`
}

function withoutKeys(
  record: Readonly<Record<string, unknown>>,
  drop: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !drop.has(key)))
}

/** The remote without `power`, or null when it never had it. */
export function withoutPowerMode(raw: unknown): Record<string, unknown> | null {
  const parsed = StoredRemoteSchema.safeParse(raw)
  if (!parsed.success || !('power' in parsed.data)) return null
  return withoutKeys(parsed.data, new Set(['power']))
}

/**
 * The lettered keys of a remote that already has the colour role of the same colour:
 * both carry a code, so the lettered one is kept under a fresh key instead of
 * being dropped.
 */
function collidingKeys(remote: StoredRemote): ReadonlySet<string> {
  const bound = new Set(Object.keys(remote.bindings ?? {}))
  const buttons = new Set((remote.customButtons ?? []).map((b) => b.key))
  const out = new Set<string>()
  for (const key of Object.keys(LETTER_TO_COLOUR)) {
    const target = newKeyOf(key)
    if (target === null) continue
    const hasOld = bound.has(`${CUSTOM}${key}`) || buttons.has(key)
    const hasNew = bound.has(`${CUSTOM}${target}`) || buttons.has(target)
    if (hasOld && hasNew) out.add(key)
  }
  return out
}

/** Where a lettered key goes: its colour key, or `<key>_kept` when the colour key is taken. */
function keyAfter(key: string, kept: ReadonlySet<string>): string | null {
  if (kept.has(key)) return `${key}_kept`
  return newKeyOf(key)
}

function roleAfter(role: string, kept: ReadonlySet<string>): string | null {
  if (!role.startsWith(CUSTOM)) return null
  const key = keyAfter(role.slice(CUSTOM.length), kept)
  return key === null ? null : `${CUSTOM}${key}`
}

function renameBindings(
  bindings: Readonly<Record<string, unknown>>,
  kept: ReadonlySet<string>,
): Record<string, unknown> | null {
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [role, binding] of Object.entries(bindings)) {
    const next = roleAfter(role, kept)
    if (next === null) {
      out[role] = binding
      continue
    }
    changed = true
    out[next] = binding
  }
  return changed ? out : null
}

function renameCustomButtons(
  buttons: NonNullable<StoredRemote['customButtons']>,
  kept: ReadonlySet<string>,
): NonNullable<StoredRemote['customButtons']> | null {
  const keys = new Set(buttons.map((b) => b.key))
  let changed = false
  const out: NonNullable<StoredRemote['customButtons']> = []
  for (const button of buttons) {
    const next = keyAfter(button.key, kept)
    if (next === null) {
      out.push(button)
      continue
    }
    changed = true
    // A colour button already stored under the target key is the newer one; the
    // lettered button only goes when the colour role is free (the `_kept` key always is).
    if (!keys.has(next) || kept.has(button.key)) out.push({ ...button, key: next })
  }
  return changed ? out : null
}

function renameSourceSteps(
  sources: readonly unknown[],
  kept: ReadonlySet<string>,
): unknown[] | null {
  let changed = false
  const out = sources.map((source) => {
    const sequence = StoredSequenceSchema.safeParse(source)
    if (!sequence.success) return source
    const steps = sequence.data.steps.map((step) => roleAfter(step, kept) ?? step)
    if (steps.every((step, i) => step === sequence.data.steps[i])) return source
    changed = true
    return { ...sequence.data, steps }
  })
  return changed ? out : null
}

export interface RenamedRemote {
  readonly remote: Record<string, unknown>
  /** The lettered keys kept under a `_kept` key because their colour role was already in use. */
  readonly collisions: readonly string[]
}

/** The remote with the colour roles renamed, or null when it binds none of the lettered ones. */
export function withColourRoles(raw: unknown): RenamedRemote | null {
  const parsed = StoredRemoteSchema.safeParse(raw)
  if (!parsed.success) return null
  const kept = collidingKeys(parsed.data)
  const bindings =
    parsed.data.bindings === undefined ? null : renameBindings(parsed.data.bindings, kept)
  const customButtons =
    parsed.data.customButtons === undefined
      ? null
      : renameCustomButtons(parsed.data.customButtons, kept)
  const sources =
    parsed.data.sources === undefined ? null : renameSourceSteps(parsed.data.sources, kept)
  if (bindings === null && customButtons === null && sources === null) return null
  return {
    remote: {
      ...parsed.data,
      ...(bindings === null ? {} : { bindings }),
      ...(customButtons === null ? {} : { customButtons }),
      ...(sources === null ? {} : { sources }),
    },
    collisions: [...kept],
  }
}

function recolouredButton(button: RemoteLayoutButton): RemoteLayoutButton | null {
  if (!button.role.startsWith(CUSTOM)) return null
  const oldKey = button.role.slice(CUSTOM.length)
  const colour = LETTER_TO_COLOUR[oldKey]
  const role = roleAfter(button.role, new Set())
  if (colour === undefined || role === null) return null
  return {
    ...button,
    role,
    tone: colour,
    // The letter the plastic prints stays on the key.
    label: button.label ?? LETTER_OF_KEY[oldKey] ?? colour,
    showLegend: true,
  }
}

/** The layout with its lettered colour keys on the colour roles, or null when it has none. */
export function withColourButtons(payload: unknown): unknown {
  const parsed = RemoteLayoutPayloadSchema.safeParse(payload)
  if (!parsed.success) return null
  let changed = false
  const buttons = parsed.data.buttons.map((button) => {
    const next = recolouredButton(button)
    if (next === null) return button
    changed = true
    return next
  })
  return changed ? { ...parsed.data, buttons } : null
}

export async function dropRemotePowerMode(
  ports: RemoteMigrationPorts,
): Promise<MigrationProcedureResult> {
  const remotes = await ports.listStoredRemotes()
  let devices = 0
  for (const { deviceId, raw } of remotes) {
    const next = withoutPowerMode(raw)
    if (next === null) continue
    await ports.replaceStoredRemote(deviceId, next)
    devices += 1
  }
  return devices === 0
    ? { outcome: 'already-done', summary: { devices: 0 } }
    : { outcome: 'done', summary: { devices } }
}

export async function renameRemoteColourRoles(
  ports: RemoteMigrationPorts & { now(): number },
): Promise<MigrationProcedureResult> {
  const remotes = await ports.listStoredRemotes()
  let devices = 0
  for (const { deviceId, raw } of remotes) {
    const next = withColourRoles(raw)
    if (next === null) continue
    if (next.collisions.length > 0) ports.warnCollision(deviceId, next.collisions)
    await ports.replaceStoredRemote(deviceId, next.remote)
    devices += 1
  }
  let templates = 0
  for (const row of await ports.listTemplateRows()) {
    if (row.data.kind !== 'remote') continue
    const payload = withColourButtons(row.data.payload)
    if (payload === null) continue
    const updatedAt = Math.max(row.data.updatedAt + 1, ports.now())
    await ports.replaceTemplateRow(row.id, { ...row.data, payload, updatedAt }, row.rev)
    templates += 1
  }
  return devices === 0 && templates === 0
    ? { outcome: 'already-done', summary: { devices: 0, templates: 0 } }
    : { outcome: 'done', summary: { devices, templates } }
}
