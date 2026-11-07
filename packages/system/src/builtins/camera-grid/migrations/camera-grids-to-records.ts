/**
 * The grids a pre-record install kept in the addon settings (`cameraGrids`) become `camera-grid`
 * records (planning#440 step 7, D1013). The record id IS the old row id, so the camera
 * `camera-grid-<id>` and every binding, layout and recording that names it keeps its identity.
 *
 * Rows are first normalised the way the old boot-time normaliser did (a missing or non-uuid id is
 * minted, a missing stable id is derived). The id is minted DETERMINISTICALLY from the row, so an
 * interrupted run converts the same row to the same record. Every good row is written, read back
 * equal, and an existing record is never overwritten.
 *
 * A row that still cannot be converted (nameless, malformed, a duplicate id or camera) never
 * blocks the others: the old reader skipped it and ran the rest. The legacy key is rewritten to
 * hold ONLY those raw rows (nothing reads it any more; kept for forensics), one warn per row, and
 * the migration lands as done. With no bad row the key is deleted.
 */
import { createHash } from 'node:crypto'
import {
  isInstanceEnabled,
  type MigrationApiV1,
  type MigrationProcedureResult,
  type MigrationRecordsKindV1,
} from '@camstack/types'
import { z } from 'zod'
import { newGridCameraStableId } from '../grid-camera-declarations.js'
import { GridCellSchema } from '../grid-instances.js'
import { cameraGridKind, type GridBody } from '../grid-record-kinds.js'

export const LEGACY_GRIDS_KEY = 'cameraGrids'

export interface GridMigrationPorts {
  /** The legacy list as stored; `absent` when the key was never written. */
  readLegacy(): Promise<
    { readonly kind: 'absent' } | { readonly kind: 'present'; readonly value: unknown }
  >
  /** The ids that already have a record. */
  listIds(): Promise<ReadonlySet<string>>
  /** Create the record; never replaces one. */
  putRecord(id: string, body: GridBody): Promise<void>
  /** The record as stored; `null` when there is none. */
  readRecord(id: string): Promise<GridBody | null>
  /** Delete the legacy key. Called only once every row has a record that reads back equal. */
  dropLegacyKey(): Promise<void>
  /** Rewrite the legacy key to hold only these raw rows (the ones that could not be converted). */
  keepLegacyRows(rows: readonly unknown[]): Promise<void>
  /** A row that was not copied, by id and reason (never a value). */
  warn(message: string): void
}

/**
 * The shape the settings list stored, frozen here: the migration owns what it reads. `width` and
 * `height` of rows written long ago are dropped (nothing reads them: the canvas is derived).
 */
const LegacyRowSchema = z.object({
  id: z.string().uuid(),
  cameraStableId: z.string().min(1).max(256).optional(),
  name: z.string().min(1).max(160),
  enabled: z.boolean().default(true),
  fps: z.number().int().min(1).max(60).default(10),
  publishedProfiles: z
    .array(z.enum(['high', 'mid', 'low']))
    .max(3)
    .default(['mid', 'low']),
  cells: z.array(GridCellSchema).max(16).default([]),
})

interface Draft {
  readonly id: string
  readonly body: GridBody
}

type Verdict =
  | { readonly kind: 'draft'; readonly draft: Draft }
  | { readonly kind: 'skip'; readonly reason: string }

const UUID = z.string().uuid()

/** A uuid derived from the row itself, so a rerun mints the same id for the same row. */
function mintedId(raw: object): string {
  const hex = createHash('sha1').update(JSON.stringify(raw)).digest('hex')
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function verdictOf(raw: unknown): Verdict {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'skip', reason: 'the row is not an object' }
  }
  const name: unknown = Reflect.get(raw, 'name')
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { kind: 'skip', reason: 'the row has no name' }
  }
  const rawId: unknown = Reflect.get(raw, 'id')
  const id = UUID.safeParse(rawId).success && typeof rawId === 'string' ? rawId : mintedId(raw)
  const parsed = LegacyRowSchema.safeParse({ ...raw, id, name: name.trim() })
  if (!parsed.success) return { kind: 'skip', reason: 'the row does not match the legacy shape' }
  const row = parsed.data
  const derived =
    row.cameraStableId === undefined || row.cameraStableId === newGridCameraStableId(row.id)
  return {
    kind: 'draft',
    draft: {
      id: row.id,
      body: {
        name: row.name,
        ...(derived ? {} : { cameraStableId: row.cameraStableId }),
        fps: row.fps,
        publishedProfiles: row.publishedProfiles,
        cells: row.cells,
        ...(row.enabled ? {} : { enabled: false }),
      },
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
function sameBody(a: GridBody, b: GridBody): boolean {
  const norm = (body: GridBody) => canonical({ ...body, enabled: isInstanceEnabled(body) })
  return norm(a) === norm(b)
}

function rowName(raw: unknown): string {
  if (raw === null || typeof raw !== 'object') return '(not an object)'
  const id: unknown = Reflect.get(raw, 'id')
  return typeof id === 'string' && id.length > 0 ? `'${id}'` : '(no id)'
}

export async function copyGridsToRecords(
  ports: GridMigrationPorts,
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
    const verdict = verdictOf(raw)
    if (verdict.kind === 'skip') {
      skipped.push({ raw, reason: verdict.reason })
      continue
    }
    const camera = verdict.draft.body.cameraStableId ?? newGridCameraStableId(verdict.draft.id)
    if (ids.has(verdict.draft.id) || cameras.has(camera)) {
      skipped.push({ raw, reason: 'a duplicate grid or camera' })
      continue
    }
    ids.add(verdict.draft.id)
    cameras.add(camera)
    drafts.push(verdict.draft)
  }

  // Only bad rows are left (a previous run kept them): nothing to convert, nothing to rewrite.
  if (drafts.length === 0 && skipped.length > 0) {
    ports.warn(
      `camera-grid: ${skipped.length} legacy row(s) are kept unconverted in the old list and ignored`,
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
        `camera-grid: grid '${id}' did not read back as written; the legacy list is kept`,
      )
    }
    created += 1
  }
  for (const { raw, reason } of skipped) {
    ports.warn(
      `camera-grid: row ${rowName(raw)} was not copied into records (${reason}) and is ignored`,
    )
  }
  if (skipped.length === 0) await ports.dropLegacyKey()
  else await ports.keepLegacyRows(skipped.map((entry) => entry.raw))
  return { outcome: 'done', summary: { created, kept, skipped: skipped.length } }
}

export function gridPortsOver(api: MigrationApiV1): GridMigrationPorts {
  const records: MigrationRecordsKindV1<GridBody> = api.records.kind(cameraGridKind)
  return {
    readLegacy: async () => {
      const { store } = await api.settings.read({})
      return Object.prototype.hasOwnProperty.call(store, LEGACY_GRIDS_KEY)
        ? { kind: 'present', value: store[LEGACY_GRIDS_KEY] }
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
      await api.settings.deleteKeys({ keys: [LEGACY_GRIDS_KEY] })
    },
    keepLegacyRows: async (kept) => {
      await api.settings.write({ patch: { [LEGACY_GRIDS_KEY]: [...kept] } })
    },
    warn: (message) => {
      void api.log.warn({ message })
    },
  }
}
