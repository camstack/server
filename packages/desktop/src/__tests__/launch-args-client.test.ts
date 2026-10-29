/**
 * The Electron shell and the Windows service supervisor are THIN launchers: they
 * run the closure's launch-args module and apply what it printed. These specs pin
 * the parsing, the closure-first lookup, the fail-open behaviour, and that both
 * launch surfaces really go through the module instead of carrying a formula.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  launchArgsCandidates,
  parseLaunchOutput,
  resolveLaunchArgs,
  type ResolveLaunchArgsOptions,
} from '../launch-args-client'

const GOOD =
  'arg --max-old-space-size=2048\nenv CAMSTACK_HEAP_CEILING_SOURCE=computed\nsource computed\n'

describe('parseLaunchOutput', () => {
  it('reads args, env and the source', () => {
    expect(parseLaunchOutput(GOOD)).toEqual({
      args: ['--max-old-space-size=2048'],
      env: { CAMSTACK_HEAP_CEILING_SOURCE: 'computed' },
      source: 'computed',
      notes: [],
    })
  })

  it('relays a warning', () => {
    expect(
      parseLaunchOutput('warn ignoring the heap override 10\nsource computed\n').notes,
    ).toEqual(['launch-args: ignoring the heap override 10'])
  })

  it('drops anything that is not a plain flag or a safe env', () => {
    const r = parseLaunchOutput(
      'arg --ok=1\narg --x; rm -rf /\narg notaflag\nenv LD_PRELOAD=/x.so\nenv PATH=/x\n' +
        'env NODE_OPTIONS=--inspect\nenv EVIL=a b\nenv fine=1\nenv MALLOC_ARENA_MAX=2\nsource v8-default\n',
    )
    expect(r.args).toEqual(['--ok=1'])
    expect(r.env).toEqual({ MALLOC_ARENA_MAX: '2' })
  })

  it('garbage with no source line is NO plan, with one note', () => {
    const r = parseLaunchOutput('Segmentation fault\narg --max-old-space-size=2048\n')
    expect(r.source).toBeNull()
    expect(r.notes.filter((n) => n.includes('no usable plan'))).toHaveLength(1)
    expect(r.args).toEqual([])
  })
})

describe('resolveLaunchArgs', () => {
  const closureModule = join(
    '/data',
    'server-root',
    'current',
    'node_modules',
    '@camstack',
    'server',
    'dist',
    'launch-args.js',
  )
  const seedModule = join('/app', 'dist', 'launch-args.js')
  const base: ResolveLaunchArgsOptions = {
    role: 'agent',
    dataDir: '/data',
    starterPath: '/app/dist/starter.js',
    nodeExecPath: '/usr/bin/node',
    runAsElectron: false,
    env: { PATH: '/usr/bin' },
    fileExists: () => true,
    run: () => GOOD,
  }

  it('looks in the active closure first, then beside the starter', () => {
    expect(launchArgsCandidates('/data', '/app/dist/starter.js')).toEqual([
      closureModule,
      seedModule,
    ])
  })

  it('runs the closure module with the role and the data dir', () => {
    const run = vi.fn<NonNullable<ResolveLaunchArgsOptions['run']>>(() => GOOD)
    const r = resolveLaunchArgs({ ...base, run })
    expect(run).toHaveBeenCalledWith(
      '/usr/bin/node',
      [closureModule, '--role', 'agent'],
      expect.objectContaining({ CAMSTACK_DATA: '/data' }),
    )
    expect(r.args).toEqual(['--max-old-space-size=2048'])
  })

  it('falls back to the seed module when the closure has none', () => {
    const run = vi.fn<NonNullable<ResolveLaunchArgsOptions['run']>>(() => GOOD)
    resolveLaunchArgs({ ...base, run, fileExists: (f) => f === seedModule })
    expect(run.mock.calls[0]?.[1][0]).toBe(seedModule)
  })

  it('runs Electron-as-Node when asked', () => {
    const run = vi.fn<NonNullable<ResolveLaunchArgsOptions['run']>>(() => GOOD)
    resolveLaunchArgs({ ...base, run, runAsElectron: true })
    expect(run.mock.calls[0]?.[2]).toMatchObject({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('fails open when the module is missing', () => {
    const r = resolveLaunchArgs({ ...base, fileExists: () => false })
    expect(r.args).toEqual([])
    expect(r.notes).toEqual(['launch-args module not found — no extra node args'])
  })

  it('fails open when the module throws or times out', () => {
    const r = resolveLaunchArgs({
      ...base,
      run: () => {
        throw new Error('spawnSync node ETIMEDOUT\nstack…')
      },
    })
    expect(r.args).toEqual([])
    expect(r.notes).toEqual(['launch-args failed (spawnSync node ETIMEDOUT) — no extra node args'])
  })

  it('fails open on garbage', () => {
    const r = resolveLaunchArgs({ ...base, run: () => '<html>502</html>' })
    expect(r.args).toEqual([])
    expect(r.source).toBeNull()
  })
})

describe('every launch surface goes through the module', () => {
  const read = (rel: string): string => readFileSync(join(__dirname, rel), 'utf8')

  it('the Electron shell applies the module output as argv and env', () => {
    const main = read('../main.ts')
    expect(main).toMatch(/resolveLaunchArgs\(/)
    expect(main).toMatch(/nodeArgs: launch\.args/)
    expect(main).toMatch(/\.\.\.launch\.env/)
    expect(main).not.toMatch(/max-old-space-size|agentHeapNodeArgs/)
  })

  it('the Windows service supervisor applies it on every relaunch', () => {
    const supervisor = read('../windows-service/service-supervisor-main.ts')
    expect(supervisor).toMatch(/resolveLaunchArgs\(/)
    expect(supervisor).toMatch(/spawn\(process\.execPath, \[\.\.\.launch\.args, starter\]/)
    expect(supervisor).not.toMatch(/max-old-space-size|agentHeapNodeArgs|totalmem/)
  })
})
