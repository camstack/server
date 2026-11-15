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
  deviceTemplateParamChoices,
  deviceTemplateParamValuesSchema,
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

describe('parameter value sources', () => {
  const entryOf = (name: string) => DEVICE_TEMPLATE_CATALOGUE.find((item) => item.name === name)
  const paramOf = (name: string, param: string) =>
    entryOf(name)?.params.find((item) => item.name === param)

  it('parses each kind and refuses an unknown or malformed one', () => {
    const parse = (v: unknown): boolean => deviceTemplateParamValuesSchema.safeParse(v).success
    expect(parse({ kind: 'units-of-field' })).toBe(true)
    expect(parse({ kind: 'choices', options: [{ value: 'HH:mm', labelKey: 'k' }] })).toBe(true)
    expect(parse({ kind: 'range', min: 0, max: 4, step: 1 })).toBe(true)
    expect(parse({ kind: 'nope' })).toBe(false)
    expect(parse({ kind: 'choices', options: [] })).toBe(false)
    expect(parse({ kind: 'range', min: 0, max: 4, step: 0 })).toBe(false)
  })

  it('declares sources on unit, time, round and trunc, and every entry still parses', () => {
    expect(paramOf('unit', 'symbol')?.values?.kind).toBe('units-of-field')
    expect(paramOf('time', 'pattern')?.values?.kind).toBe('choices')
    expect(paramOf('round', 'digits')?.values).toEqual({
      kind: 'range',
      min: 0,
      max: 4,
      step: 1,
    })
    expect(paramOf('trunc', 'digits')?.values?.kind).toBe('range')
    for (const item of DEVICE_TEMPLATE_CATALOGUE) {
      expect(deviceTemplateCatalogueEntrySchema.safeParse(item).success).toBe(true)
    }
  })

  it('narrows units to the dimension of the field unit', () => {
    const groups = deviceTemplateParamChoices({ kind: 'units-of-field' }, '°C')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.group).toBe('temperature')
    const values = groups[0]?.choices.map((c) => c.value) ?? []
    expect(values).toEqual(expect.arrayContaining(['°C', '°F', 'K']))
    expect(values).not.toContain('hPa')
  })

  it('lists every unit grouped by dimension when the field unit is unknown or absent', () => {
    for (const unit of [undefined, 'furlongs']) {
      const groups = deviceTemplateParamChoices({ kind: 'units-of-field' }, unit)
      expect(groups.length).toBeGreaterThan(5)
      expect(groups.map((g) => g.group)).toEqual(
        expect.arrayContaining(['temperature', 'pressure']),
      )
    }
  })

  it('expands a range and carries a label for every time pattern', () => {
    const digits = deviceTemplateParamChoices(paramOf('round', 'digits')?.values)
    expect(digits[0]?.choices.map((c) => c.value)).toEqual(['0', '1', '2', '3', '4'])
    const patterns = deviceTemplateParamChoices(paramOf('time', 'pattern')?.values)
    const first = patterns[0]?.choices ?? []
    expect(first.map((c) => c.value)).toContain('HH:mm')
    for (const choice of first) {
      expect(DEVICE_TEMPLATE_CATALOGUE_TEXT[choice.labelKey ?? '']?.en).toBeTruthy()
      expect(DEVICE_TEMPLATE_CATALOGUE_TEXT[choice.labelKey ?? '']?.it).toBeTruthy()
    }
  })
})
