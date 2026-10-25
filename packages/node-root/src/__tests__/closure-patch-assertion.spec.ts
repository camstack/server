/**
 * `findUnappliedClosurePatches` — the fail-closed half of D478.
 *
 * The defect it exists for: `@camstack/server`'s `postinstall` applies the
 * patches that cannot be bundled, and it is best-effort, so a skipped patch
 * used to be indistinguishable from an applied one. Production ran `werift`
 * unpatched on three nodes for eight weeks that way. These cases pin the ONE
 * distinction that matters — a closure whose markers are absent is named, and
 * one that carries no payload at all is not (a pre-D478 release must stay
 * installable, or there is no recovery path).
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findUnappliedClosurePatches } from '../root-single-copy.js'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

interface Closure {
  readonly dir: string
}

function makeClosure(opts: {
  readonly manifest?: unknown
  /** `null` ⇒ do not create the package at all. */
  readonly weriftIndex?: string | null
}): Closure {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-patch-'))
  made.push(dir)
  const payload = path.join(dir, 'node_modules', '@camstack', 'server', 'dist', 'closure-patches')
  if (opts.manifest !== undefined) {
    fs.mkdirSync(payload, { recursive: true })
    fs.writeFileSync(path.join(payload, 'patch-reach.json'), JSON.stringify(opts.manifest))
  }
  if (opts.weriftIndex !== null && opts.weriftIndex !== undefined) {
    const lib = path.join(dir, 'node_modules', 'werift', 'lib')
    fs.mkdirSync(lib, { recursive: true })
    fs.writeFileSync(path.join(lib, 'index.mjs'), opts.weriftIndex)
  }
  return { dir }
}

const MANIFEST = {
  patches: [
    {
      patch: 'werift+0.22.9.patch',
      package: 'werift',
      version: '0.22.9',
      reach: 'closure-postinstall',
      markers: { 'lib/index.mjs': ['RTP_HISTORY_SIZE = 4096'] },
    },
    {
      patch: 'moleculer+0.15.0.patch',
      package: 'moleculer',
      reach: 'bundled',
      markers: ['rest.buffer.byteLength'],
    },
  ],
}

describe('findUnappliedClosurePatches', () => {
  it('names the marker that did not land, with its file', () => {
    const closure = makeClosure({
      manifest: MANIFEST,
      weriftIndex: 'var RTP_HISTORY_SIZE = 128;\n',
    })
    expect(findUnappliedClosurePatches(closure.dir)).toEqual([
      'werift/lib/index.mjs: RTP_HISTORY_SIZE = 4096',
    ])
  })

  it('accepts a closure where the patch landed', () => {
    const closure = makeClosure({
      manifest: MANIFEST,
      weriftIndex: 'var RTP_HISTORY_SIZE = 4096;\n',
    })
    expect(findUnappliedClosurePatches(closure.dir)).toEqual([])
  })

  it('ignores a bundled patch — its marker lives in a dist, not in node_modules', () => {
    // The `moleculer` entry declares a marker and no per-file map. If this
    // function ever started reading those it would fail every closure, since
    // the closure's own `node_modules/moleculer` is unpatched BY DESIGN (it is
    // loaded for `Errors` and never parses a frame).
    const closure = makeClosure({
      manifest: MANIFEST,
      weriftIndex: 'var RTP_HISTORY_SIZE = 4096;\n',
    })
    fs.mkdirSync(path.join(closure.dir, 'node_modules', 'moleculer'), { recursive: true })
    expect(findUnappliedClosurePatches(closure.dir)).toEqual([])
  })

  it('accepts a closure that carries no patch payload — a pre-D478 release', () => {
    const closure = makeClosure({ weriftIndex: 'var RTP_HISTORY_SIZE = 128;\n' })
    expect(findUnappliedClosurePatches(closure.dir)).toEqual([])
  })

  it('accepts a closure that does not carry the patched package at all', () => {
    const closure = makeClosure({ manifest: MANIFEST, weriftIndex: null })
    expect(findUnappliedClosurePatches(closure.dir)).toEqual([])
  })

  it('accepts a closure whose manifest is corrupt rather than refusing every update', () => {
    const closure = makeClosure({ weriftIndex: 'var RTP_HISTORY_SIZE = 128;\n' })
    const payload = path.join(
      closure.dir,
      'node_modules',
      '@camstack',
      'server',
      'dist',
      'closure-patches',
    )
    fs.mkdirSync(payload, { recursive: true })
    fs.writeFileSync(path.join(payload, 'patch-reach.json'), '{ not json')
    expect(findUnappliedClosurePatches(closure.dir)).toEqual([])
  })
})
