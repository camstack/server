/**
 * The grids a pre-record install kept in the addon settings (`cameraGrids`) become `camera-grid`
 * records (planning#440 step 7, D1013). The record id IS the old row id, so the camera
 * `camera-grid-<id>` and every binding, layout and recording that names it keeps its identity; a
 * stable id that is not derivable from the id is carried on the body.
 *
 * Every row is converted BEFORE any is written, each write is read back equal, a record that
 * already exists is never overwritten, and the legacy key is deleted only when every row is
 * accounted for. A nameless row was always ignored (and dropped at boot) by the reader, so it is
 * counted and warned, not copied; any other row that cannot be converted keeps the key where it is
 * and fails the step, so it is tried again and the row is never guessed at.
 */
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
  | { readonly kind: 'nameless' }
  | { readonly kind: 'unconverted'; readonly reason: string }

function verdictOf(raw: unknown): Verdict {
  if (raw === null || typeof raw !== 'object') {
    return { kind: 'unconverted', reason: 'the row is not an object' }
  }
  const name: unknown = Reflect.get(raw, 'name')
  if (typeof name !== 'string' || name.trim().length === 0) return { kind: 'nameless' }
  const parsed = LegacyRowSchema.safeParse(raw)
  if (!parsed.success)
    return { kind: 'unconverted', reason: 'the row does not match the legacy shape' }
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
  const ids = new Set<string>()
  const cameras = new Set<string>()
  let unconverted = 0
  let nameless = 0
  for (const raw of rows) {
    const verdict = verdictOf(raw)
    if (verdict.kind === 'nameless') {
      nameless += 1
      ports.warn(
        `camera-grid: row ${rowName(raw)} has no name and was always ignored; it is not copied`,
      )
      continue
    }
    const duplicate =
      verdict.kind === 'draft' &&
      (ids.has(verdict.draft.id) ||
        cameras.has(verdict.draft.body.cameraStableId ?? newGridCameraStableId(verdict.draft.id)))
    if (verdict.kind === 'unconverted' || duplicate) {
      unconverted += 1
      ports.warn(
        `camera-grid: row ${rowName(raw)} was not copied into records (${
          verdict.kind === 'unconverted' ? verdict.reason : 'a duplicate grid or camera'
        }); the legacy list is kept and the migration is not done`,
      )
      continue
    }
    ids.add(verdict.draft.id)
    cameras.add(verdict.draft.body.cameraStableId ?? newGridCameraStableId(verdict.draft.id))
    drafts.push(verdict.draft)
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
  if (unconverted > 0) {
    throw new Error(
      `camera-grid: ${unconverted} legacy grid(s) could not be copied into records and the legacy list is kept (${created} created, ${kept} kept)`,
    )
  }
  await ports.dropLegacyKey()
  return { outcome: 'done', summary: { created, kept, nameless } }
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
    warn: (message) => {
      void api.log.warn({ message })
    },
  }
}
