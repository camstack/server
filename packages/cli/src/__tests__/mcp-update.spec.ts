import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMcpRollback, runMcpUpdate, type McpUpdateDeps } from '../commands/mcp-update.js'

let home: string
let root: string
let printed: string[]
let doctorOk: boolean
let installOk: boolean
let advertised = 'sha512-GOOD'
let downloaded = 'sha512-GOOD'
let auditOutput: { ok: boolean; output: string } = { ok: true, output: '' }
let installArgs: readonly string[] = []

function deps(entry?: string): McpUpdateDeps {
  return {
    entryPath: entry ?? path.join(root, 'current', 'node_modules', 'camstack', 'dist', 'cli.js'),
    env: {},
    home,
    latestVersion: async () => '2.0.0',
    print: (l) => printed.push(l),
    run: async (_file, args) => {
      if (args.includes('install')) {
        installArgs = args
        const staged = args[args.indexOf('--prefix') + 1] ?? ''
        fs.mkdirSync(staged, { recursive: true })
        fs.writeFileSync(
          path.join(staged, 'package-lock.json'),
          JSON.stringify({ packages: { 'node_modules/camstack': { integrity: downloaded } } }),
        )
        return { ok: installOk, output: 'npm out' }
      }
      if (args.includes('view')) return { ok: true, output: advertised }
      if (args.includes('audit')) return auditOutput
      return { ok: doctorOk, output: 'doctor out' }
    },
  }
}

const target = (name: string) => fs.readlinkSync(path.join(root, name))

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-up-'))
  root = path.join(home, '.local', 'share', 'camstack')
  fs.mkdirSync(path.join(root, 'cli', '1.0.0'), { recursive: true })
  fs.symlinkSync(path.join(root, 'cli', '1.0.0'), path.join(root, 'current'), 'dir')
  fs.mkdirSync(path.join(home, '.camstack'), { recursive: true })
  fs.writeFileSync(path.join(home, '.camstack', 'hub.json'), '{"token":"keep"}', { mode: 0o600 })
  printed = []
  doctorOk = true
  installOk = true
  advertised = 'sha512-GOOD'
  downloaded = 'sha512-GOOD'
  auditOutput = { ok: true, output: '' }
  installArgs = []
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

describe('camstack mcp update / rollback', () => {
  it('a failing doctor leaves current unchanged and removes the staged dir', async () => {
    doctorOk = false
    const code = await runMcpUpdate(['2.0.0'], deps())
    expect(code).toBe(1)
    expect(target('current')).toBe(path.join(root, 'cli', '1.0.0'))
    expect(fs.existsSync(path.join(root, 'previous'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'cli', '2.0.0'))).toBe(false)
  })

  it('a good doctor switches current, keeps previous, prints the restart note', async () => {
    const code = await runMcpUpdate(['--latest'], deps())
    expect(code).toBe(0)
    expect(target('current')).toBe(path.join(root, 'cli', '2.0.0'))
    expect(target('previous')).toBe(path.join(root, 'cli', '1.0.0'))
    expect(printed.join('\n')).toMatch(/OpenCode/)
  })

  it('rollback restores previous, and the session file is never touched', async () => {
    await runMcpUpdate(['2.0.0'], deps())
    expect(await runMcpRollback(deps())).toBe(0)
    expect(target('current')).toBe(path.join(root, 'cli', '1.0.0'))
    expect(target('previous')).toBe(path.join(root, 'cli', '2.0.0'))
    expect(fs.readFileSync(path.join(home, '.camstack', 'hub.json'), 'utf8')).toBe(
      '{"token":"keep"}',
    )
  })

  it('refuses a version that is not a version (no path traversal)', async () => {
    expect(await runMcpUpdate(['../../etc'], deps())).toBe(1)
    expect(fs.existsSync(path.join(root, 'cli', '..', '..', 'etc'))).toBe(false)
  })

  it('a non-managed layout prints instructions and writes nothing', async () => {
    const code = await runMcpUpdate(['2.0.0'], deps('/usr/lib/node_modules/camstack/dist/cli.js'))
    expect(code).toBe(0)
    expect(printed.join('\n')).toMatch(/npm install -g/)
    expect(fs.existsSync(path.join(root, 'cli', '2.0.0'))).toBe(false)
  })

  it('installs with --ignore-scripts', async () => {
    await runMcpUpdate(['2.0.0'], deps())
    expect(installArgs).toContain('--ignore-scripts')
  })

  it('a tarball that does not match the registry integrity is refused and discarded', async () => {
    downloaded = 'sha512-EVIL'
    expect(await runMcpUpdate(['2.0.0'], deps())).toBe(1)
    expect(target('current')).toBe(path.join(root, 'cli', '1.0.0'))
    expect(fs.existsSync(path.join(root, 'cli', '2.0.0'))).toBe(false)
    expect(printed.join('\n')).toMatch(/integrity/)
  })

  it('an invalid registry signature is refused', async () => {
    auditOutput = { ok: false, output: '1 package has an invalid registry signature' }
    expect(await runMcpUpdate(['2.0.0'], deps())).toBe(1)
    expect(target('current')).toBe(path.join(root, 'cli', '1.0.0'))
  })

  it('rollback refuses a previous that points outside <root>/cli and runs doctor first', async () => {
    fs.symlinkSync('/tmp', path.join(root, 'previous'), 'dir')
    expect(await runMcpRollback(deps())).toBe(1)
    expect(target('current')).toBe(path.join(root, 'cli', '1.0.0'))
    fs.rmSync(path.join(root, 'previous'))
    fs.mkdirSync(path.join(root, 'cli', '0.9.0'), { recursive: true })
    fs.symlinkSync(path.join(root, 'cli', '0.9.0'), path.join(root, 'previous'), 'dir')
    doctorOk = false
    expect(await runMcpRollback(deps())).toBe(1)
    expect(target('current')).toBe(path.join(root, 'cli', '1.0.0'))
  })
})
