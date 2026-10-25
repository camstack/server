import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
// The hook is plain ESM; import it directly.
import { initialize, resolve } from '../framework-resolver-hook.mjs'

let frameworkDir: string

beforeAll(() => {
  // Build a fake framework dir with a resolvable @camstack/system package.
  frameworkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-'))
  const pkgDir = path.join(frameworkDir, 'node_modules', '@camstack', 'system')
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@camstack/system', version: '1.0.0', exports: './index.js' }),
  )
  fs.writeFileSync(path.join(pkgDir, 'index.js'), 'export const ok = true\n')
  initialize({ frameworkDir })
})

describe('framework-resolver-hook', () => {
  it('redirects a host-external specifier into the framework dir', async () => {
    const nextResolve = async (_spec: string, ctx: { parentURL?: string }) => ({
      url: ctx.parentURL ?? '',
      shortCircuit: true,
    })
    const result = await resolve(
      '@camstack/system',
      { parentURL: 'file:///data/addons/@camstack/addon-x/dist/index.js' },
      nextResolve,
    )
    // The hook must have anchored parentURL under frameworkDir/node_modules.
    expect(result.url).toContain(path.join(frameworkDir, 'node_modules'))
  })

  it('passes through a non-host specifier unchanged', async () => {
    const nextResolve = async (spec: string, ctx: { parentURL?: string }) => ({
      url: `RESOLVED:${spec}:${ctx.parentURL ?? ''}`,
      shortCircuit: true,
    })
    const original = 'file:///data/addons/@camstack/addon-x/dist/index.js'
    const result = await resolve('some-third-party-lib', { parentURL: original }, nextResolve)
    expect(result.url).toBe(`RESOLVED:some-third-party-lib:${original}`)
  })

  it('redirects the addon-imported native deps (sharp, node-av, node-pty, ssh2) into the framework dir', async () => {
    const nextResolve = async (_spec: string, ctx: { parentURL?: string }) => ({
      url: ctx.parentURL ?? '',
      shortCircuit: true,
    })
    for (const native of ['sharp', 'node-av', 'node-pty', 'ssh2']) {
      const result = await resolve(
        native,
        { parentURL: 'file:///data/addons/@camstack/addon-x/dist/index.js' },
        nextResolve,
      )
      expect(result.url, `${native} should resolve via framework dir`).toContain(
        path.join(frameworkDir, 'node_modules'),
      )
    }
  })

  it('does NOT redirect better-sqlite3 — an addon import falls through to its own location', async () => {
    const addonParent = 'file:///data/addons/@camstack/addon-x/dist/index.js'
    const nextResolve = async (_spec: string, ctx: { parentURL?: string }) => ({
      url: ctx.parentURL ?? '',
      shortCircuit: true,
    })
    const result = await resolve('better-sqlite3', { parentURL: addonParent }, nextResolve)
    // Falls through with the original parentURL (addon dir), NOT the framework
    // anchor — so a stray addon `import 'better-sqlite3'` fails to resolve
    // instead of being silently host-provided.
    expect(result.url).toBe(addonParent)
    expect(result.url).not.toContain(path.join(frameworkDir, 'node_modules'))
  })
})
