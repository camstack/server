/**
 * `check-addon-dist-footprint` — the BUILT-addon guard. Fixtures stand in for
 * `packages/<pkg>/dist`: an addon entry requiring a chunk, one of them naming
 * the cap schema graph or hoarding heap.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { probeClosure } from '../check-runner-dist-barrel-free.js'
import {
  allowedGrowthMb,
  DEFAULT_MAX_GROWTH_MB,
  discoverAddonEntries,
  filesNamingForbidden,
  stripJsComments,
  validateBudgets,
} from '../check-addon-dist-footprint.js'

const dirs: string[] = []

function tmp(files: Readonly<Record<string, string>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-footprint-'))
  dirs.push(dir)
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), body)
  }
  return dir
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('the static refusal', () => {
  it('flags a file whose code names ALL_CAPABILITY_DEFINITIONS', () => {
    const dir = tmp({ 'a.js': 'const defs = ALL_CAPABILITY_DEFINITIONS.map((d) => d.name)' })
    expect(filesNamingForbidden([path.join(dir, 'a.js')])).toEqual([path.join(dir, 'a.js')])
  })

  it('ignores a comment that names it, and a longer identifier that merely contains it', () => {
    const dir = tmp({
      'a.js':
        '// used to read ALL_CAPABILITY_DEFINITIONS\n/* ALL_CAPABILITY_DEFINITIONS */\nconst x = 1',
      'b.js': 'const ALL_CAPABILITY_DEFINITIONS_COUNT = 3',
    })
    expect(filesNamingForbidden([path.join(dir, 'a.js'), path.join(dir, 'b.js')])).toEqual([])
  })

  it('keeps a URL slash pair from swallowing the rest of the line', () => {
    expect(
      stripJsComments('const u = "https://x.test"; use(ALL_CAPABILITY_DEFINITIONS)'),
    ).toContain('ALL_CAPABILITY_DEFINITIONS')
  })
})

describe('the runtime budget', () => {
  it('a heap-hungry addon grows the heap past the default over the bare runner', () => {
    const dir = tmp({
      'runner.js': 'module.exports = 1',
      'fat-addon.js':
        'globalThis.keep = Array.from({ length: 3e6 }, (_, i) => ({ i, s: "x" + i }))',
      'lean-addon.js': 'module.exports = { ok: true }',
    })
    const runner = path.join(dir, 'runner.js')
    const base = probeClosure(runner, [runner]).heapUsedMb
    const fat = probeClosure(runner, [path.join(dir, 'fat-addon.js')]).heapUsedMb - base
    const lean = probeClosure(runner, [path.join(dir, 'lean-addon.js')]).heapUsedMb - base
    expect(fat).toBeGreaterThan(DEFAULT_MAX_GROWTH_MB)
    expect(lean).toBeLessThan(DEFAULT_MAX_GROWTH_MB)
  })

  it('a budget raises the ceiling for the addon that holds it, no other', () => {
    const budgets = { 'p:a': { maxGrowthMb: 90, reason: 'a legitimately heavy addon, measured' } }
    expect(allowedGrowthMb('p:a', budgets)).toBe(90)
    expect(allowedGrowthMb('p:b', budgets)).toBe(DEFAULT_MAX_GROWTH_MB)
  })
})

describe('budget hygiene', () => {
  const known = new Set(['p:a'])

  it('accepts a budget above the default with a reason', () => {
    expect(
      validateBudgets(
        { 'p:a': { maxGrowthMb: 90, reason: 'holds the ONNX session cache' } },
        known,
      ),
    ).toEqual([])
  })

  it('rejects a budget for an addon that does not exist, one without a reason, one not above the default', () => {
    const problems = validateBudgets(
      {
        'p:gone': { maxGrowthMb: 90, reason: 'a legitimately heavy addon, once' },
        'p:a': { maxGrowthMb: 40, reason: '' },
      },
      known,
    )
    expect(problems).toHaveLength(3)
    expect(problems.join('\n')).toMatch(/names no addon/)
    expect(problems.join('\n')).toMatch(/needs a reason/)
    expect(problems.join('\n')).toMatch(/must exceed the default/)
  })
})

describe('addon discovery', () => {
  it('reads <package>:<id> and the resolved entry from camstack.addons[], skipping the in-hub system package', () => {
    const dir = tmp({
      'packages/addon-x/package.json': JSON.stringify({
        camstack: { addons: [{ id: 'x', entry: './dist/index.js' }, { id: 'uionly' }] },
      }),
      'packages/system/package.json': JSON.stringify({
        camstack: { addons: [{ id: 'device-manager', entry: './dist/dm.js' }] },
      }),
    })
    expect(discoverAddonEntries(dir)).toEqual([
      { key: 'addon-x:x', entry: path.join(dir, 'packages/addon-x/dist/index.js') },
    ])
  })
})
