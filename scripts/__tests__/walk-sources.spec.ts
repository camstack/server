import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { stripComments, walkSources } from '../lib/walk-sources.js'

describe('stripComments', () => {
  it('blanks block and line comments and keeps every line number', () => {
    const src =
      'const a = 1 /* gone\n   still gone */\nconst b = 2 // tail\n// whole line\nconst c = 3\n'
    const out = stripComments(src)
    expect(out.split('\n').length).toBe(src.split('\n').length)
    expect(out).not.toContain('gone')
    expect(out).not.toContain('tail')
    expect(out.split('\n')[4]).toBe('const c = 3')
  })

  it('does not treat the // inside a URL literal as a comment', () => {
    const src = "const u = 'https://example.test/x' // real comment\n"
    const out = stripComments(src)
    expect(out).toContain("'https://example.test/x'")
    expect(out).not.toContain('real comment')
  })

  it('a docblock quoting a banned token is not a hit; the code line still is', () => {
    const src = '/** reads /sys/fs/cgroup in prose */\nconst p = "/sys/fs/cgroup/memory"\n'
    const lines = stripComments(src).split('\n')
    expect(lines[0]).not.toContain('/sys/fs/cgroup')
    expect(lines[1]).toContain('/sys/fs/cgroup')
  })
})

describe('walkSources', () => {
  let repo: string
  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-sources-'))
    execFileSync('git', ['init', '-q', repo])
    const put = (rel: string, body: string): void => {
      const full = path.join(repo, rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, body)
    }
    put('packages/a/src/x.ts', 'export const x = 1 // note\n')
    put('packages/a/src/__tests__/x.spec.ts', 'export const s = 1\n')
    put('packages/a/src/y.d.ts', 'export declare const y: number\n')
    put('packages/a/README.md', '# a\n')
    put('server/b/src/z.tsx', 'export const z = 1\n')
    put('packages/a/src/untracked.ts', 'export const u = 1\n')
    put(
      'packages/addon-pipeline-orchestrator/assets/viewer/_expo/static/js/web/index-abc.js',
      'var DeviceNativeShadowChanged="device.native-shadow-changed"\n',
    )
    put('packages/addon-pipeline-orchestrator/assets/viewer/embed/assets/index-C65.js', 'var a=1\n')
    // A hand-written file beside the bundle is SOURCE, and must still be judged.
    put(
      'packages/addon-pipeline-orchestrator/assets/viewer/serve-config.js',
      'export const c = 1\n',
    )
    execFileSync('git', [
      '-C',
      repo,
      'add',
      'packages/a/src/x.ts',
      'packages/a/src/__tests__/x.spec.ts',
      'packages/a/src/y.d.ts',
      'packages/a/README.md',
      'server/b/src/z.tsx',
      'packages/addon-pipeline-orchestrator/assets/viewer/_expo/static/js/web/index-abc.js',
      'packages/addon-pipeline-orchestrator/assets/viewer/embed/assets/index-C65.js',
      'packages/addon-pipeline-orchestrator/assets/viewer/serve-config.js',
    ])
  })
  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true })
  })

  it('lists only TRACKED files under the roots, filtered by extension, with stripped code', () => {
    const files = walkSources(repo, ['packages', 'server'])
    const rels = files.map((f) => f.rel).toSorted()
    expect(rels).toEqual([
      'packages/a/src/x.ts',
      'packages/addon-pipeline-orchestrator/assets/viewer/serve-config.js',
      'server/b/src/z.tsx',
    ])
    const x = files.find((f) => f.rel === 'packages/a/src/x.ts')
    expect(x?.source).toContain('// note')
    expect(x?.code).not.toContain('note')
  })

  it('keeps specs and .d.ts when asked, and scans other extensions when asked', () => {
    const rels = walkSources(repo, ['packages'], {
      extensions: ['.ts', '.md'],
      includeTests: true,
      includeDeclarations: true,
    })
      .map((f) => f.rel)
      .toSorted()
    expect(rels).toEqual([
      'packages/a/README.md',
      'packages/a/src/__tests__/x.spec.ts',
      'packages/a/src/x.ts',
      'packages/a/src/y.d.ts',
    ])
  })

  // The committed viewer web bundle is BUILD OUTPUT of another repository: a
  // minified file that inlines every enum member it imports. Two source guards
  // went red on it the day a viewer pin first bundled an owner-only name — a
  // verdict about a file nobody here writes. A guard about TEXT (a leaked key)
  // still asks for it explicitly.
  it('skips tracked build output unless asked for it', () => {
    const bundle =
      'packages/addon-pipeline-orchestrator/assets/viewer/_expo/static/js/web/index-abc.js'
    expect(walkSources(repo, ['packages']).map((f) => f.rel)).not.toContain(bundle)
    expect(
      walkSources(repo, ['packages'], { includeBuildOutput: true }).map((f) => f.rel),
    ).toContain(bundle)
  })

  it('skips only the exact bundle paths, never a hand-written file beside them', () => {
    const rels = walkSources(repo, ['packages']).map((f) => f.rel)
    expect(rels).not.toContain(
      'packages/addon-pipeline-orchestrator/assets/viewer/embed/assets/index-C65.js',
    )
    expect(rels).toContain('packages/addon-pipeline-orchestrator/assets/viewer/serve-config.js')
  })

  it('a root that does not exist contributes nothing rather than throwing', () => {
    expect(walkSources(repo, ['apps'])).toEqual([])
  })
})
