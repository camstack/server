/**
 * The Terminals a pre-record install kept in the addon settings (`terminalInstances`) become
 * `terminals` records (planning#440 step 7, D1013). The record id IS the old instance id, so the
 * camera `terminal-camera-instance-<id>` and everything that names it keeps its identity; a
 * stable id that is not derivable from the id (an adopted legacy monitor) is carried on the body.
 *
 * Every good row is converted BEFORE any is written, each write is read back equal, and a record
 * that already exists is never overwritten. A row that cannot be converted (malformed, a duplicate
 * id or camera) never blocks the others: the old reader skipped it and ran the rest. The legacy key
 * is rewritten to hold ONLY those raw rows (nothing reads it any more; kept for forensics), one warn
 * per row, and the migration lands as done. With no bad row the key is deleted.
 */
import {
  type MigrationApiV1,
  type MigrationProcedureResult,
  type MigrationRecordsKindV1,
} from '@camstack/types'
import { z } from 'zod'
import {
  newTerminalCameraStableId,
  type TerminalBody,
  terminalInstancesKind,
} from '../terminal-record-kinds.js'

export const LEGACY_TERMINAL_INSTANCES_KEY = 'terminalInstances'

export interface TerminalMigrationPorts {
  /** The legacy list as stored; `absent` when the key was never written. */
  readLegacy(): Promise<
    { readonly kind: 'absent' } | { readonly kind: 'present'; readonly value: unknown }
  >
  /** The ids that already have a record. */
  listIds(): Promise<ReadonlySet<string>>
  /** Create the record; never replaces one. */
  putRecord(id: string, body: TerminalBody): Promise<void>
  /** The record as stored; `null` when there is none. */
  readRecord(id: string): Promise<TerminalBody | null>
  /** Delete the legacy key. Called only once every row has a record that reads back equal. */
  dropLegacyKey(): Promise<void>
  /** Rewrite the legacy key to hold only these raw rows (the ones that could not be converted). */
  keepLegacyRows(rows: readonly unknown[]): Promise<void>
  /** A row that was not copied, by id and reason (never a value). */
  warn(message: string): void
}

/** The shape the settings list stored, frozen here: the migration owns what it reads. */
const LegacyRowSchema = z.object({
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

interface Draft {
  readonly id: string
  readonly body: TerminalBody
}

function draftOf(raw: unknown): Draft | string {
  const parsed = LegacyRowSchema.safeParse(raw)
  if (!parsed.success) return 'the row does not match the legacy shape'
  const row = parsed.data
  const derived = row.cameraStableId === newTerminalCameraStableId(row.id)
  return {
    id: row.id,
    body: {
      name: row.name,
      nodeId: row.nodeId,
      profileId: row.profileId,
      profileLabel: row.profileLabel,
      ...(derived ? {} : { cameraStableId: row.cameraStableId }),
      executable: row.executable,
      args: row.args,
      cwd: row.cwd,
      environment: row.environment,
      profileSettings: row.profileSettings,
      ...(row.enabled ? {} : { enabled: false }),
    },
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : 1))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Absent `enabled` means on, so the two spellings of "on" read back as equal. */
function sameBody(a: TerminalBody, b: TerminalBody): boolean {
  const norm = (body: TerminalBody) => canonical({ ...body, enabled: body.enabled !== false })
  return norm(a) === norm(b)
}

function rowName(raw: unknown): string {
  if (raw === null || typeof raw !== 'object') return '(not an object)'
  const id: unknown = Reflect.get(raw, 'id')
  return typeof id === 'string' && id.length > 0 ? `'${id}'` : '(no id)'
}

export async function copyTerminalsToRecords(
  ports: TerminalMigrationPorts,
): Promise<MigrationProcedureResult> {
  const legacy = await ports.readLegacy()
  if (legacy.kind === 'absent' || !Array.isArray(legacy.value)) {
    return { outcome: 'already-done', summary: { reason: 'no-legacy-data' } }
  }
  const rows: readonly unknown[] = legacy.value

  const drafts: Draft[] = []
  const skipped: { readonly raw: unknown; readonly reason: string }[] = []
  const ids = new Set<string>()
  const cameras = new Set<string>()
  for (const raw of rows) {
    const draft = draftOf(raw)
    if (typeof draft === 'string') {
      skipped.push({ raw, reason: draft })
      continue
    }
    const camera = draft.body.cameraStableId ?? newTerminalCameraStableId(draft.id)
    if (ids.has(draft.id) || cameras.has(camera)) {
      skipped.push({ raw, reason: 'a duplicate instance or camera' })
      continue
    }
    ids.add(draft.id)
    cameras.add(camera)
    drafts.push(draft)
  }

  // Only bad rows are left (a previous run kept them): nothing to convert, nothing to rewrite.
  if (drafts.length === 0 && skipped.length > 0) {
    ports.warn(
      `terminal: ${skipped.length} legacy row(s) are kept unconverted in the old list and ignored`,
    )
    return { outcome: 'already-done', summary: { skipped: skipped.length } }
  }

  const have = await ports.listIds()
  let created = 0
  let kept = 0
  for (const { id, body } of drafts) {
    if (have.has(id)) {
      kept += 1
      continue
    }
    await ports.putRecord(id, body)
    const back = await ports.readRecord(id)
    if (back === null || !sameBody(back, body)) {
      throw new Error(
        `terminal: instance '${id}' did not read back as written; the legacy list is kept`,
      )
    }
    created += 1
  }
  for (const { raw, reason } of skipped) {
    ports.warn(
      `terminal: row ${rowName(raw)} was not copied into records (${reason}) and is ignored`,
    )
  }
  if (skipped.length === 0) await ports.dropLegacyKey()
  else await ports.keepLegacyRows(skipped.map((entry) => entry.raw))
  return { outcome: 'done', summary: { created, kept, skipped: skipped.length } }
}

/** The slice of the migration API these ports use. */
export type TerminalPortsApi = Pick<MigrationApiV1, 'settings' | 'log' | 'records'>

export function terminalPortsOver(api: TerminalPortsApi): TerminalMigrationPorts {
  const records: MigrationRecordsKindV1<TerminalBody> = api.records.kind(terminalInstancesKind)
  return {
    readLegacy: async () => {
      const { store } = await api.settings.read({})
      return Object.prototype.hasOwnProperty.call(store, LEGACY_TERMINAL_INSTANCES_KEY)
        ? { kind: 'present', value: store[LEGACY_TERMINAL_INSTANCES_KEY] }
        : { kind: 'absent' }
    },
    listIds: async () => {
      const out = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await records.query({
          limit: 500,
          ...(cursor === undefined ? {} : { cursor }),
        })
        for (const row of page.records) out.add(row.id)
        cursor = page.nextCursor ?? undefined
      } while (cursor !== undefined)
      return out
    },
    putRecord: async (id, body) => {
      await records.put({ id, data: body, ifRev: 0 })
    },
    readRecord: async (id) => (await records.get({ id }))?.data ?? null,
    dropLegacyKey: async () => {
      await api.settings.deleteKeys({ keys: [LEGACY_TERMINAL_INSTANCES_KEY] })
    },
    keepLegacyRows: async (kept) => {
      await api.settings.write({ patch: { [LEGACY_TERMINAL_INSTANCES_KEY]: [...kept] } })
    },
    warn: (message) => {
      void api.log.warn({ message })
    },
  }
}
