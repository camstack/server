/**
 * The trainable bases carry the pipeline catalog's measured floors (D739) and
 * root-supply floors (D741) as COPIES — addons never import each other. This
 * holds the copies equal to the catalog source, so a re-measurement that
 * forgets this table fails here instead of judging a fine-tune against a
 * stale baseline.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BASE_MODELS } from '../orchestrator/base-models.js'

const CATALOG = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../addon-pipeline/src/detection-pipeline/registry/model-catalogs.ts',
  ),
  'utf8',
)

/** `'<id>': { person: 0.6, vehicle: 0.4, animal: 0.55 }` rows of a catalog table. */
function catalogRow(table: string, id: string): Record<string, number> | null {
  const start = CATALOG.indexOf(`const ${table}`)
  const body = CATALOG.slice(start, CATALOG.indexOf('\n}\n', start))
  const quoted = new RegExp(`^\\s*'?${id.replaceAll('-', '\\-')}'?: \\{([^}]*)\\}`, 'm').exec(body)
  if (quoted === null) return null
  const out: Record<string, number> = {}
  for (const pair of (quoted[1] ?? '').split(',')) {
    const [k, v] = pair.split(':').map((s) => s.trim().replaceAll("'", ''))
    if (k && v) out[k] = Number(v)
  }
  return out
}

describe('trainable base models', () => {
  it.each(
    BASE_MODELS.map((m) => [m.modelId, m] as const),
  )('%s carries the catalog floors', (id, model) => {
    expect(model.baselineFloors).toEqual(catalogRow('OBJECT_DETECTION_CLASS_FLOORS', id))
  })

  it.each(
    BASE_MODELS.map((m) => [m.modelId, m] as const),
  )('%s carries the catalog root-supply floors', (id, model) => {
    expect(model.suppliedLabelFloors).toEqual(catalogRow('ROOT_SUPPLIED_LABEL_FLOORS', id) ?? {})
    expect(model.suppliedLabelFloorsInt8).toEqual(
      catalogRow('ROOT_SUPPLIED_LABEL_FLOORS', `${id}-int8`) ?? {},
    )
  })

  it('recommends exactly one base', () => {
    expect(BASE_MODELS.filter((m) => m.recommended).map((m) => m.modelId)).toEqual(['yolov9m-640'])
  })
})
