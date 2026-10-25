/**
 * `check-runner-dist-barrel-free` — the BUILT-output guard. Fixtures stand in
 * for a dist directory: a runner entry requiring chunks, one of them carrying
 * the schema graph the way the inlined `@camstack/types` barrel does.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  distClosure,
  GUARDED_DIST_ENTRIES,
  MAX_SCHEMA_CALLS,
  probeClosure,
  schemaHeavyFiles,
} from '../check-runner-dist-barrel-free.js'

const dirs: string[] = []

function dist(files: Readonly<Record<string, string>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-barrel-'))
  dirs.push(dir)
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body)
  return dir
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const BARREL = `const z = require('zod');\n${'z.object({});\n'.repeat(MAX_SCHEMA_CALLS + 50)}`

describe('closure walk over built files', () => {
  it('follows require, static import, re-export and dynamic import', () => {
    const dir = dist({
      'runner.js': 'require("./a.js"); import("./b.js")',
      'a.js': 'export { x } from "./c.js"',
      'b.js': 'import "./d.js"',
      'c.js': '',
      'd.js': '',
      'unrelated.js': BARREL,
    })
    const closure = distClosure(path.join(dir, 'runner.js')).map((f) => path.basename(f))
    expect(closure.sort()).toEqual(['a.js', 'b.js', 'c.js', 'd.js', 'runner.js'])
  })
})

describe('the schema-graph marker', () => {
  it('flags a chunk carrying the barrel reached through a shared chunk', () => {
    const dir = dist({
      'runner.js': 'require("./shared.js")',
      'shared.js': 'require("./dist-x.js")',
      'dist-x.js': BARREL,
    })
    const hits = schemaHeavyFiles(distClosure(path.join(dir, 'runner.js')))
    expect(hits.map((h) => path.basename(h.file))).toEqual(['dist-x.js'])
  })

  it('lets a file with a few schema calls through', () => {
    const dir = dist({ 'runner.js': 'const s = z.object({ a: z.string() })' })
    expect(schemaHeavyFiles([path.join(dir, 'runner.js')])).toEqual([])
  })
})

describe('the runtime probe', () => {
  it('loads the entry and the closure, survives the runner exiting on missing env, and reports memory', () => {
    const dir = dist({
      'runner.js': 'require("./chunk.js"); if (!process.env.NOPE) process.exit(1)',
      'chunk.js': 'module.exports = 1',
    })
    const entry = path.join(dir, 'runner.js')
    const probe = probeClosure(entry, distClosure(entry))
    expect(probe.rssMb).toBeGreaterThan(10)
    expect(probe.heapUsedMb).toBeGreaterThan(0)
    expect(probe.heapUsedMb).toBeLessThan(30)
  })

  it('actually loads the entry: a heap-hungry entry shows up in the number', () => {
    const dir = dist({ 'runner.js': 'globalThis.keep = new Array(4e6).fill("x".repeat(8))' })
    const entry = path.join(dir, 'runner.js')
    const probe = probeClosure(entry, [entry])
    expect(probe.heapUsedMb).toBeGreaterThan(20)
  })
})

describe('which built entries are guarded', () => {
  it('covers addon-utils, which seven hub runners load, as well as the runner', () => {
    expect(GUARDED_DIST_ENTRIES).toEqual(['addon-runner', 'addon-utils'])
  })

  it('an addon-utils-shaped entry that reaches the barrel through a shared chunk is flagged', () => {
    const dir = dist({
      'addon-utils.js': 'require("./custom-action-registry-x.js")',
      'custom-action-registry-x.js': 'require("./dist-y.js")',
      'dist-y.js': BARREL,
    })
    const hits = schemaHeavyFiles(distClosure(path.join(dir, 'addon-utils.js')))
    expect(hits.map((h) => path.basename(h.file))).toEqual(['dist-y.js'])
  })
})
