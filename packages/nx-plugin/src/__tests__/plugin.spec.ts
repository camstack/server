import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createNodesV2 } from '../plugin.js'

/**
 * Auto-inference plugin tests. The Nx createNodesV2 contract is a
 * tuple `[glob, factory]` where the factory is called with the list
 * of paths that matched the glob. We invoke the factory directly with
 * synthesized fixtures — no need to spin up a real Nx workspace.
 */

const [, factory] = createNodesV2

interface FactoryResult {
  projects: Record<string, { name: string; targets: Record<string, unknown> }>
}

async function runFactory(
  workspaceRoot: string,
  configFiles: string[],
): Promise<readonly (readonly [string, FactoryResult])[]> {
  const ctx = { workspaceRoot, nxJsonConfiguration: {}, configFiles } as never
  const result = await factory(configFiles, {} as never, ctx)
  return result as readonly (readonly [string, FactoryResult])[]
}

describe('createNodesV2 auto-inference', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-plugin-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function writePkg(relPath: string, content: object): void {
    const abs = path.join(root, relPath)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, JSON.stringify(content))
  }

  it('attaches a `deploy` target to any package that declares camstack.addons', async () => {
    writePkg('packages/addon-foo/package.json', {
      name: '@camstack/addon-foo',
      camstack: {
        addons: [{ id: 'foo', name: 'Foo', entry: './dist/foo.js' }],
      },
    })
    const out = await runFactory(root, ['packages/addon-foo/package.json'])
    expect(out).toHaveLength(1)
    const [, payload] = out[0]!
    const project = Object.values(payload.projects)[0]
    expect(project).toBeDefined()
    expect(project!.name).toBe('@camstack/addon-foo')
    const deploy = project!.targets.deploy as Record<string, unknown>
    expect(deploy.executor).toBe('@camstack/nx-plugin:deploy')
    expect(deploy.dependsOn).toEqual(['build'])
    expect(deploy.cache).toBe(false)
  })

  it('skips packages without camstack.addons', async () => {
    writePkg('packages/regular-lib/package.json', {
      name: '@scope/regular-lib',
      description: 'no camstack manifest',
    })
    const out = await runFactory(root, ['packages/regular-lib/package.json'])
    expect(out).toHaveLength(0)
  })

  it('skips packages with empty camstack.addons array', async () => {
    writePkg('packages/empty/package.json', {
      name: '@camstack/empty',
      camstack: { addons: [] },
    })
    const out = await runFactory(root, ['packages/empty/package.json'])
    expect(out).toHaveLength(0)
  })

  it('skips packages with malformed JSON (does NOT fail boot)', async () => {
    const abs = path.join(root, 'packages/broken/package.json')
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, '{ malformed')
    const out = await runFactory(root, ['packages/broken/package.json'])
    expect(out).toHaveLength(0)
  })

  it('uses the package "name" field as the project name', async () => {
    writePkg('addons/x/package.json', {
      name: '@org/scoped-name',
      camstack: { addons: [{ id: 'x', name: 'X', entry: './e' }] },
    })
    const out = await runFactory(root, ['addons/x/package.json'])
    const [, payload] = out[0]!
    const project = Object.values(payload.projects)[0]
    expect(project!.name).toBe('@org/scoped-name')
  })

  it('skips packages without a `name` field even when camstack.addons is present', async () => {
    writePkg('packages/anon/package.json', {
      // intentionally no name
      camstack: { addons: [{ id: 'anon', name: 'Anon', entry: './e' }] },
    })
    const out = await runFactory(root, ['packages/anon/package.json'])
    expect(out).toHaveLength(0)
  })

  it('handles multiple matching configs in a single invocation', async () => {
    writePkg('packages/a/package.json', {
      name: '@camstack/a',
      camstack: { addons: [{ id: 'a', name: 'A', entry: './e' }] },
    })
    writePkg('packages/b/package.json', {
      name: '@camstack/b',
      camstack: { addons: [{ id: 'b', name: 'B', entry: './e' }] },
    })
    writePkg('packages/c/package.json', {
      name: '@camstack/c-lib',
      // no manifest — should be skipped
    })
    const out = await runFactory(root, [
      'packages/a/package.json',
      'packages/b/package.json',
      'packages/c/package.json',
    ])
    expect(out).toHaveLength(2)
    const names = out.map(([, p]) => Object.values(p.projects)[0]!.name).toSorted()
    expect(names).toEqual(['@camstack/a', '@camstack/b'])
  })
})
