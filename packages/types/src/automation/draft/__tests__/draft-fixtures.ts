/** The synthetic site and cases of the entity-draft benchmark, for the specs. */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import {
  type DraftFewShot,
  type DraftKind,
  type DraftSite,
  DraftSiteSchema,
} from '../draft-types.js'

const DIR = path.resolve(import.meta.dirname, '../../../../../../scripts/eval/entity-draft')

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(path.join(DIR, file), 'utf8'))
}

export const SITE: DraftSite = DraftSiteSchema.parse(readJson('fixtures/site.json'))

const CaseFileSchema = z.array(
  z.object({ id: z.string(), lang: z.string(), description: z.string(), entity: z.unknown() }),
)

export function casesOf(kind: DraftKind): z.infer<typeof CaseFileSchema> {
  return CaseFileSchema.parse(readJson(`cases/${kind}.json`))
}

export function fewShotsOf(kind: DraftKind): readonly DraftFewShot[] {
  return z
    .array(z.object({ kind: z.string(), description: z.string(), entity: z.unknown() }))
    .parse(readJson('fixtures/fewshots.json'))
    .filter((s) => s.kind === kind)
}

export function caseEntity(kind: DraftKind, id: string): unknown {
  const found = casesOf(kind).find((c) => c.id === id)
  if (found === undefined) throw new Error(`no case ${id}`)
  return found.entity
}

/** A deep copy that a test can edit through `mutate` without touching the fixture. */
export function edited(value: unknown, mutate: (copy: Record<string, unknown>) => void): unknown {
  const copy: unknown = JSON.parse(JSON.stringify(value))
  if (typeof copy !== 'object' || copy === null || Array.isArray(copy))
    throw new Error('not an object')
  const record = Object.fromEntries(Object.entries(copy))
  mutate(record)
  return record
}
