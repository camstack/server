/**
 * #681 — the Docker image and the desktop build install `@camstack/server` with
 * a bare `npm install`; `scripts/closure-pins-install.mjs` resolves the version
 * once and writes the tarball's `closure-pins.json` as root `overrides` first.
 */
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

  it('the Dockerfile and the desktop stage install through the helper', () => {
    const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
    expect(docker).toContain('closure-pins-install.mjs')
    expect(docker).not.toMatch(/npm install[^\n]*@camstack\/server@latest/)
    const stage = fs.readFileSync(path.join(ROOT, 'packages/desktop/scripts/stage-deps.mjs'), 'utf8')
    expect(stage).toContain('closure-pins-install.mjs')
  })
})
