import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEVICE_TEMPLATE_CATALOGUE,
  DEVICE_TEMPLATE_CATALOGUE_TEXT,
  deviceTemplateCallableBounds,
  deviceTemplateCatalogueEntrySchema,
  deviceTemplateFilterMaxParams,
  deviceTemplateFilterNames,
} from '../device-template-catalogue.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const TEMPLATE = 'packages/system/src/builtins/device-manager/device-template'
const WORKER = path.join(ROOT, TEMPLATE, 'template-worker.ts')
const FILTERS = path.join(ROOT, TEMPLATE, 'template-filters.ts')
const GRAMMAR = path.join(ROOT, TEMPLATE, 'template-grammar.ts')
const RENDERER = path.join(ROOT, TEMPLATE, 'template-renderer.ts')

/** The argument caps the grammar enforced before they were derived. */
const HISTORIC_MAX: Readonly<Record<string, number>> = {
  unit: 2,
  round: 1,
  trunc: 1,
  onoff: 0,
  default: 2,
  since: 0,
  ago: 0,
  format: 1,
  upper: 0,
  lower: 0,
  title: 0,
  capitalize: 0,
  trim: 0,
  abs: 0,
  int: 1,
  float: 1,
  length: 0,
  d: 2,
  join: 1,
  replace: 3,
  first: 0,
  last: 0,
  sort: 2,
  reverse: 0,
  sum: 0,
  string: 0,
  list: 0,
  truncate: 3,
  time: 1,
}

function namesIn(source: string, pattern: RegExp): readonly string[] {
  return [...source.matchAll(pattern)].map((match) => match[1] ?? '')
}

function builtinNames(source: string): ReadonlySet<string> {
  const block = /const BUILTIN_FILTERS[\s\S]*?=\s*\[([\s\S]*?)\]/.exec(source)?.[1] ?? ''
  return new Set(namesIn(block, /'([a-z]+)'/g))
}

function customFilterNames(source: string): ReadonlySet<string> {
  const block = /filters:\s*\{([\s\S]*?)\n {4}\}/.exec(source)?.[1] ?? ''
  return new Set(namesIn(block, /^\s*([a-z]+):/gm))
}

/** `unitFilter` → `unit`, `makeSinceFilter` → `since`. */
function catalogueNameOf(fn: string): string | undefined {
  if (fn === 'rangeGlobal') return 'range'
  const made = /^make([A-Z][a-z]+)Filter$/.exec(fn)
  if (made?.[1] !== undefined) return made[1].toLowerCase()
  const plain = /^([a-z]+)Filter$/.exec(fn)
  return plain?.[1]
}

describe('device template catalogue', () => {
  it('parses every entry and has English and Italian for each key', () => {
    const parsed = deviceTemplateCatalogueEntrySchema.array().parse([...DEVICE_TEMPLATE_CATALOGUE])
    expect(parsed).toHaveLength(DEVICE_TEMPLATE_CATALOGUE.length)
    const names = new Set<string>()
    for (const item of DEVICE_TEMPLATE_CATALOGUE) {
      expect(names.has(item.name)).toBe(false)
      names.add(item.name)
      expect(DEVICE_TEMPLATE_CATALOGUE_TEXT[item.descriptionKey]?.en).toBeTruthy()
      expect(DEVICE_TEMPLATE_CATALOGUE_TEXT[item.descriptionKey]?.it).toBeTruthy()
      expect(DEVICE_TEMPLATE_CATALOGUE_TEXT[item.exampleKey]?.en).toBeTruthy()
      expect(DEVICE_TEMPLATE_CATALOGUE_TEXT[item.exampleKey]?.it).toBeTruthy()
    }
  })

  it('derives the historic argument caps, with no second list in the grammar', () => {
    expect(deviceTemplateFilterMaxParams()).toEqual(HISTORIC_MAX)
    expect(deviceTemplateFilterNames()).toEqual(Object.keys(HISTORIC_MAX))
    const grammar = readFileSync(GRAMMAR, 'utf8')
    const renderer = readFileSync(RENDERER, 'utf8')
    expect(grammar).not.toMatch(/unit:\s*2/)
    expect(grammar).not.toContain('device-template-catalogue')
    expect(renderer).toContain('deviceTemplateFilterMaxParams')
  })

  it('matches every filter implementation and every builtin the worker keeps', () => {
    const worker = readFileSync(WORKER, 'utf8')
    const filters = readFileSync(FILTERS, 'utf8')
    const builtins = builtinNames(worker)
    const custom = customFilterNames(worker)
    const implemented = new Set<string>()
    for (const fn of namesIn(filters, /export function (\w+)/g)) {
      const name = catalogueNameOf(fn)
      if (name !== undefined) implemented.add(name)
    }
    const catalogueFilters = DEVICE_TEMPLATE_CATALOGUE.filter((item) => item.kind === 'filter').map(
      (item) => item.name,
    )
    for (const name of catalogueFilters) {
      expect(builtins.has(name) || custom.has(name)).toBe(true)
      if (custom.has(name)) expect(implemented.has(name === 'd' ? 'default' : name)).toBe(true)
    }
    for (const name of builtins) expect(catalogueFilters).toContain(name)
    for (const name of custom) expect(catalogueFilters).toContain(name)
    for (const name of implemented) {
      if (name === 'range') {
        expect(
          DEVICE_TEMPLATE_CATALOGUE.some((item) => item.kind === 'global' && item.name === name),
        ).toBe(true)
      } else {
        expect(catalogueFilters).toContain(name)
      }
    }
    expect(deviceTemplateCallableBounds()).toEqual([{ name: 'range', min: 1, max: 3 }])
    expect(custom.has('range')).toBe(false)
  })
})
