/**
 * #681 — the Docker image and the desktop build install `@camstack/server` with
 * a bare `npm install`; `scripts/closure-pins-install.mjs` resolves the version
 * once and writes the tarball's `closure-pins.json` as root `overrides` first.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pinClosureInstall } from '../closure-pins-install.mjs'

const ROOT = path.resolve(__dirname, '../..')
const PINS = { '@trpc/server': '11.18.0', sharp: '0.35.2' }

function makeTarball(files: Readonly<Record<string, string>>): Buffer {
  const blocks: Buffer[] = []
  for (const [name, body] of Object.entries(files)) {
    const header = Buffer.alloc(512)
    header.write(`package/${name}`, 0, 'utf8')
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
    blocks.push(header, Buffer.from(body, 'utf8'), Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(blocks))
}

interface Calls {
  readonly args: string[][]
}

/** Fake npm: `view` answers the version, `pack` drops `tgz` (or fails when null). */
function fakeNpm(tgz: Buffer | null, calls: Calls) {
  return async (args: readonly string[]): Promise<{ stdout: string }> => {
    calls.args.push([...args])
    if (args[0] === 'view') return { stdout: '"9.9.9"\n' }
    if (args[0] === 'pack') {
      if (tgz === null) throw new Error('E404')
      const dest = args[args.indexOf('--pack-destination') + 1]!
      fs.writeFileSync(path.join(dest, 'server-9.9.9.tgz'), tgz)
      return { stdout: '' }
    }
    throw new Error(`unexpected npm ${args[0]}`)
  }
}

describe('closure-pins-install', () => {
  let dir: string
  let logs: string[]
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pins-install-'))
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'hub', version: '1.0.0' }))
    logs = []
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const manifest = () => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))

  it('writes the shipped pins as overrides and packs the SAME version it resolved', async () => {
    const calls: Calls = { args: [] }
    const run = fakeNpm(makeTarball({ 'closure-pins.json': JSON.stringify(PINS) }), calls)
    const out = await pinClosureInstall({ dir, run, log: (m: string) => logs.push(m) })
    expect(out).toEqual({ version: '9.9.9', pinned: true })
    expect(manifest().overrides).toEqual(PINS)
    expect(calls.args.filter((a) => a[0] === 'view')).toHaveLength(1)
    expect(calls.args.find((a) => a[0] === 'pack')![1]).toBe('@camstack/server@9.9.9')
  })

  it('installs unpinned, with a named reason, when the tarball ships no file', async () => {
    const run = fakeNpm(makeTarball({ 'package.json': '{}' }), { args: [] })
    const out = await pinClosureInstall({ dir, run, log: (m: string) => logs.push(m) })
    expect(out.pinned).toBe(false)
    expect(manifest().overrides).toBeUndefined()
    expect(logs.join('\n')).toContain('UNPINNED: entry-missing')
  })

  it('refuses an invalid file and says it was shipped', async () => {
    const run = fakeNpm(makeTarball({ 'closure-pins.json': '{"sharp":"^1.0.0"}' }), { args: [] })
    const out = await pinClosureInstall({ dir, run, log: (m: string) => logs.push(m) })
    expect(out.pinned).toBe(false)
    expect(manifest().overrides).toBeUndefined()
    expect(logs.join('\n')).toContain('non-exact-version (shipped file refused)')
  })

  it('does not fail when the pack itself fails', async () => {
    const out = await pinClosureInstall({
      dir,
      run: fakeNpm(null, { args: [] }),
      log: (m: string) => logs.push(m),
    })
    expect(out.pinned).toBe(false)
    expect(logs.join('\n')).toContain('pack failed')
  })

  describe('the real CLI entry under node (no vitest transpile)', () => {
    let bin: string
    beforeEach(() => {
      bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pins-bin-'))
    })
    afterEach(() => fs.rmSync(bin, { recursive: true, force: true }))

    function runCli() {
      return spawnSync(process.execPath, [path.join(ROOT, 'scripts/closure-pins-install.mjs'), dir, 'latest'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`, CLOSURE_PINS_RETRY_MS: '1' },
      })
    }
    function stubNpm(body: string): void {
      const file = path.join(bin, 'npm')
      fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`)
      fs.chmodSync(file, 0o755)
    }

    it('exits 0 and prints the tag as the only stdout line when npm view fails', () => {
      stubNpm('process.stderr.write("E503\\n"); process.exit(1)')
      const r = runCli()
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('latest\n')
      expect(r.stderr).toContain('UNPINNED: cannot resolve @camstack/server@latest after 3 attempts')
      expect(manifest().overrides).toBeUndefined()
    })

    it('loads the .ts parser through type stripping, writes overrides, prints one version line, no warning', () => {
      const tgz = path.join(bin, 'fixture.tgz')
      fs.writeFileSync(tgz, makeTarball({ 'closure-pins.json': JSON.stringify(PINS) }))
      stubNpm(`
const fs = require('node:fs'), path = require('node:path')
const a = process.argv.slice(2)
if (a[0] === 'view') { console.log('"9.9.9"'); process.exit(0) }
if (a[0] === 'pack') { fs.copyFileSync(${JSON.stringify(tgz)}, path.join(a[a.indexOf('--pack-destination') + 1], 'server-9.9.9.tgz')); process.exit(0) }
process.exit(1)`)
      const r = runCli()
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('9.9.9\n')
      expect(manifest().overrides).toEqual(PINS)
      expect(r.stderr).toContain('pinned: 2 third-party versions')
      expect(r.stderr).not.toContain('MODULE_TYPELESS_PACKAGE_JSON')
    })
  })

  it('the Dockerfile and the desktop stage install through the helper', () => {
    const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
    expect(docker).toContain('closure-pins-install.mjs')
    expect(docker).not.toMatch(/npm install[^\n]*@camstack\/server@latest/)
    const stage = fs.readFileSync(path.join(ROOT, 'packages/desktop/scripts/stage-deps.mjs'), 'utf8')
    expect(stage).toContain('closure-pins-install.mjs')
  })
})
