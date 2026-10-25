import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readModelLabels } from '../engine-factory.js'
import type { ModelCatalogEntry } from '@camstack/types'

/** Minimal entry — `readModelLabels` reads only `extraFiles`. */
function entryWithLabels(filename: string | null): ModelCatalogEntry {
  const base: ModelCatalogEntry = {
    id: 'x',
    name: 'x',
    description: 'x',
    formats: {},
    inputSize: { width: 224, height: 224 },
    labels: [],
  }
  if (filename === null) return base
  return {
    ...base,
    extraFiles: [{ url: 'http://x', filename, sizeMB: 0.01 }],
  }
}

describe('readModelLabels — dict + flat-array label file formats', () => {
  let dir: string

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labels-'))
    // Newer metadata-carrying format: { "labels": [...], ...preprocess... }
    fs.writeFileSync(
      path.join(dir, 'animal-classifier-labels.json'),
      JSON.stringify({
        labels: ['bird', 'cat', 'cow', 'deer', 'dog', 'horse', 'sheep', 'squirrel'],
        num_classes: 8,
        preprocess: { normalize: 'imagenet' },
      }),
    )
    // Legacy flat array.
    fs.writeFileSync(
      path.join(dir, 'legacy-labels.json'),
      JSON.stringify(['alpha', 'beta', 'gamma']),
    )
    // Malformed shape (object without a labels array).
    fs.writeFileSync(path.join(dir, 'bad-labels.json'), JSON.stringify({ foo: 1 }))
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('extracts the `.labels` array from the metadata-object format', () => {
    const labels = readModelLabels(dir, entryWithLabels('animal-classifier-labels.json'))
    expect(labels).toEqual(['bird', 'cat', 'cow', 'deer', 'dog', 'horse', 'sheep', 'squirrel'])
  })

  it('accepts a legacy flat string[] label file', () => {
    const labels = readModelLabels(dir, entryWithLabels('legacy-labels.json'))
    expect(labels).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('returns undefined when the entry declares no -labels.json extraFile', () => {
    expect(readModelLabels(dir, entryWithLabels(null))).toBeUndefined()
  })

  it('returns undefined when the labels file is missing on disk', () => {
    expect(readModelLabels(dir, entryWithLabels('does-not-exist-labels.json'))).toBeUndefined()
  })

  it('returns undefined for an unrecognised label shape', () => {
    expect(readModelLabels(dir, entryWithLabels('bad-labels.json'))).toBeUndefined()
  })
})
