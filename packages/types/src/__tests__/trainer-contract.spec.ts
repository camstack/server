/**
 * The trainer contract has two halves — these zod schemas and the trainer's
 * pydantic models, exported as JSON Schema under `hf/camstack-trainer/schemas/`
 * (D805, D807). This pins them to each other: same fields, same required set,
 * for job.json, result.json and the nested blocks the hub reads. A field added
 * on one side only fails here, not on the first real cloud run.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  TrainingCatalogDraftSchema,
  TrainingJobSpecSchema,
  TrainingResultFileSchema,
  TrainingResultSchema,
} from '../training/trainer-contract.js'

interface JsonSchemaObject {
  readonly properties?: Record<string, unknown>
  readonly required?: readonly string[]
  readonly $defs?: Record<string, JsonSchemaObject>
}

function load(name: string): JsonSchemaObject {
  const url = new URL(
    `../../../../hf/camstack-trainer/schemas/${name}.schema.json`,
    import.meta.url,
  )
  return JSON.parse(readFileSync(url, 'utf8')) as JsonSchemaObject
}

function zodKeys(schema: z.ZodObject): { readonly all: string[]; readonly required: string[] } {
  const shape = schema.shape
  const all = Object.keys(shape).toSorted()
  const required = all.filter((k) => !shape[k]?.safeParse(undefined).success)
  return { all, required: required.toSorted() }
}

function jsonKeys(schema: JsonSchemaObject): {
  readonly all: string[]
  readonly required: string[]
} {
  return {
    all: Object.keys(schema.properties ?? {}).toSorted(),
    required: [...(schema.required ?? [])].toSorted(),
  }
}

describe('trainer contract parity (zod ↔ the trainer JSON Schema)', () => {
  it('job.json has the same fields, all required', () => {
    expect(zodKeys(TrainingJobSpecSchema)).toEqual(jsonKeys(load('job')))
  })

  it('result.json has the same fields and the same required set', () => {
    expect(zodKeys(TrainingResultSchema)).toEqual(jsonKeys(load('result')))
  })

  it('a file row and a catalog draft match the trainer', () => {
    const defs = load('result').$defs ?? {}
    expect(zodKeys(TrainingResultFileSchema).all).toEqual(jsonKeys(defs['FileRow'] ?? {}).all)
    expect(zodKeys(TrainingCatalogDraftSchema).all).toEqual(
      jsonKeys(defs['CatalogEntryDraft'] ?? {}).all,
    )
  })
})
