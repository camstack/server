/**
 * D745 — the recommender's tables ARE the benchmark record. A re-measurement
 * replaces `docs/benchmarks/detector-latency.json` / `model-floors.json` and
 * `detector-performance.ts` together; this spec fails until they agree.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DETECTOR_ACCURACY, DETECTOR_PERF } from '../detector-performance.js'

const here = dirname(fileURLToPath(import.meta.url))
const benchmarks = resolve(here, '../../../../../../docs/benchmarks')

interface LatencyRecord {
  readonly columns: Readonly<
    Record<
      string,
      {
        readonly cells: Readonly<Record<string, { p50Ms: number; fps: number; measured: boolean }>>
      }
    >
  >
}

interface FloorsRecord {
  readonly [modelId: string]: {
    readonly person?: {
      readonly precision: number
      readonly recall: number
      readonly fragile?: string
    }
  }
}

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(resolve(benchmarks, name), 'utf8'))
}

function isLatencyRecord(value: unknown): value is LatencyRecord {
  return typeof value === 'object' && value !== null && 'columns' in value
}

function isFloorsRecord(value: unknown): value is FloorsRecord {
  return typeof value === 'object' && value !== null
}

describe('detector performance tables', () => {
  it('the latency table equals docs/benchmarks/detector-latency.json', () => {
    const record = readJson('detector-latency.json')
    if (!isLatencyRecord(record)) throw new Error('detector-latency.json has no columns')
    const fromJson: Record<string, Record<string, unknown>> = {}
    for (const [column, { cells }] of Object.entries(record.columns)) {
      const [hardwareClass = '', accelerator = ''] = column.split('/')
      fromJson[hardwareClass] = { ...fromJson[hardwareClass], [accelerator]: cells }
    }
    expect(DETECTOR_PERF).toEqual(fromJson)
  })

  it('the accuracy table equals the person precision/recall of docs/benchmarks/model-floors.json', () => {
    const floors = readJson('model-floors.json')
    if (!isFloorsRecord(floors)) throw new Error('model-floors.json is not an object')
    for (const [modelId, accuracy] of Object.entries(DETECTOR_ACCURACY)) {
      const person = floors[modelId]?.person
      expect(person, modelId).toBeDefined()
      // A fragile person floor would mean the shipped floor is not the measured one.
      expect(person?.fragile, modelId).toBeUndefined()
      expect(accuracy).toEqual({ personPrecision: person?.precision, personRecall: person?.recall })
    }
  })

  it('every model with a latency cell has an accuracy row, and only YOLOv9 t/s/m is offered (a Coral column: its one default build, D912)', () => {
    for (const byAcc of Object.values(DETECTOR_PERF)) {
      for (const [accelerator, column] of Object.entries(byAcc ?? {})) {
        if (accelerator === 'coral') {
          expect(Object.keys(column ?? {})).toEqual(['yolov9s-320-edgetpu'])
          continue
        }
        for (const modelId of Object.keys(column ?? {})) {
          expect(DETECTOR_ACCURACY[modelId], modelId).toBeDefined()
          expect(modelId).toMatch(/^yolov9[tsm]-(320|640)(-int8)?$/)
        }
      }
    }
  })
})
