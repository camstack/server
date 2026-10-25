/**
 * `model_floors` — the measured confidence floors of a model, from the
 * committed tables (`docs/benchmarks/model-floors.json` for root detectors,
 * `classifier-floors.json` for classifiers), with the method and the rule that
 * produced them (D739). Local, read-only: no hub.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const DETECTOR_FILE = path.join('docs', 'benchmarks', 'model-floors.json')
const CLASSIFIER_FILE = path.join('docs', 'benchmarks', 'classifier-floors.json')
const DECISION = 'docs/decisions/index.md#D739 (floor defaults are measured per model)'

export type ModelFloorsResult =
  | {
      readonly found: true
      readonly table: 'detector' | 'classifier'
      readonly modelId: string
      readonly floors: unknown
      readonly method: unknown
      readonly decision: string
      readonly source: string
    }
  | {
      readonly found: false
      readonly modelId: string
      readonly nearest: readonly string[]
      readonly knownModels: readonly string[]
      readonly decision: string
    }

function readTable(root: string, file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object`)
  }
  return Object.fromEntries(Object.entries(parsed))
}

export function modelFloors(root: string, modelId: string): ModelFloorsResult {
  const tables = [
    { table: 'detector', file: DETECTOR_FILE } as const,
    { table: 'classifier', file: CLASSIFIER_FILE } as const,
  ]
  const known: string[] = []
  for (const { table, file } of tables) {
    const rows = readTable(root, file)
    const hit = rows[modelId]
    if (modelId !== '_about' && hit !== undefined) {
      return {
        found: true,
        table,
        modelId,
        floors: hit,
        method: rows['_about'] ?? null,
        decision: DECISION,
        source: file,
      }
    }
    known.push(...Object.keys(rows).filter((k) => !k.startsWith('_')))
  }
  const needle = modelId.toLowerCase()
  const nearest = known.filter(
    (k) => k.toLowerCase().includes(needle) || needle.includes(k.toLowerCase()),
  )
  return {
    found: false,
    modelId,
    nearest: nearest.slice(0, 10),
    knownModels: known,
    decision: DECISION,
  }
}
