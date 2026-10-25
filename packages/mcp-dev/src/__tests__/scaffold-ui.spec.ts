import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { unifiedDiff } from '../diff.js'
import { scaffoldCapability } from '../caps/scaffold.js'
import { kebabOf, patchBarrel, scaffoldUiComponent } from '../ui/scaffold.js'

let root: string
const COMPOSITES = path.join('packages', 'ui-library', 'src', 'composites')

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-ui-'))
  fs.mkdirSync(path.join(dir, COMPOSITES), { recursive: true })
  fs.mkdirSync(path.join(dir, 'packages', 'ui-library', 'src', 'primitives'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, COMPOSITES, 'index.ts'),
    "export { Existing } from './existing'\n",
  )
  fs.writeFileSync(
    path.join(dir, 'packages', 'ui-library', 'src', 'primitives', 'index.ts'),
    "export * from './button'\n",
  )
  fs.mkdirSync(path.join(dir, 'docs', 'reference'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'docs', 'reference', 'ui-components.json'),
    JSON.stringify({ entries: [{ name: 'TrackStrip' }, { name: 'Button' }] }),
  )
  return dir
}

beforeEach(() => {
  root = makeWorkspace()
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('scaffold_ui_component', () => {
  it('names a kebab file from a PascalCase name', () => {
    expect(kebabOf('TrackTimeline')).toBe('track-timeline')
    expect(kebabOf('HTTPBadge')).toBe('http-badge')
  })

  it('a dry run writes NOTHING and shows a diff per file, plus similar existing components', () => {
    const r = scaffoldUiComponent(root, { name: 'TrackTimeline', tier: 'composite' })
    expect(r.status).toBe('dry-run')
    if (r.status === 'refused') throw new Error(r.reason)
    expect(r.files.map((f) => f.path)).toEqual([
      path.join(COMPOSITES, 'track-timeline.tsx'),
      path.join(COMPOSITES, '__tests__', 'track-timeline.test.tsx'),
      path.join(COMPOSITES, 'index.ts'),
    ])
    expect(r.files[0]?.diff).toContain('+export function TrackTimeline')
    expect(r.files[2]?.diff).toContain("+export { TrackTimeline } from './track-timeline'")
    expect(r.files[2]?.diff).toMatch(/^ export \{ Existing \}/m)
    expect(r.similarExisting).toContain('TrackStrip')
    expect(fs.existsSync(path.join(root, COMPOSITES, 'track-timeline.tsx'))).toBe(false)
    expect(fs.readFileSync(path.join(root, COMPOSITES, 'index.ts'), 'utf8')).toBe(
      "export { Existing } from './existing'\n",
    )
  })

  it('apply writes the component, the spec and the barrel line', () => {
    const r = scaffoldUiComponent(root, { name: 'TrackTimeline', tier: 'composite', apply: true })
    expect(r.status).toBe('applied')
    expect(fs.existsSync(path.join(root, COMPOSITES, 'track-timeline.tsx'))).toBe(true)
    expect(fs.existsSync(path.join(root, COMPOSITES, '__tests__', 'track-timeline.test.tsx'))).toBe(
      true,
    )
    expect(fs.readFileSync(path.join(root, COMPOSITES, 'index.ts'), 'utf8')).toContain(
      "export { TrackTimeline } from './track-timeline'",
    )
  })

  it('a primitive uses the export-star barrel of its tier', () => {
    expect(patchBarrel("export * from './a'\n", 'primitive', 'Chip', 'chip')).toBe(
      "export * from './a'\nexport * from './chip'\n",
    )
  })

  it('refuses to overwrite and refuses a second apply', () => {
    scaffoldUiComponent(root, { name: 'TrackTimeline', tier: 'composite', apply: true })
    const again = scaffoldUiComponent(root, {
      name: 'TrackTimeline',
      tier: 'composite',
      apply: true,
    })
    expect(again.status).toBe('refused')
  })

  it('never overwrites a file that exists even when the barrel does not export it', () => {
    const file = path.join(root, COMPOSITES, 'orphan.tsx')
    fs.writeFileSync(file, 'hand-written')
    const r = scaffoldUiComponent(root, { name: 'Orphan', tier: 'composite', apply: true })
    expect(r.status).toBe('refused')
    expect(fs.readFileSync(file, 'utf8')).toBe('hand-written')
  })

  it('writes are confined to the workspace: a symlinked tier dir pointing out is refused', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-outside-'))
    fs.rmSync(path.join(root, COMPOSITES), { recursive: true })
    fs.symlinkSync(outside, path.join(root, COMPOSITES))
    fs.writeFileSync(path.join(outside, 'index.ts'), '')
    const r = scaffoldUiComponent(root, { name: 'Escape', tier: 'composite', apply: true })
    expect(r).toMatchObject({ status: 'refused' })
    expect(fs.readdirSync(outside)).toEqual(['index.ts'])
    fs.rmSync(outside, { recursive: true, force: true })
  })
})

describe('scaffold_capability — dry run shows a diff, and is confined', () => {
  function capWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-cap-'))
    const caps = path.join(dir, 'packages', 'types', 'src', 'capabilities')
    fs.mkdirSync(caps, { recursive: true })
    fs.writeFileSync(
      path.join(caps, 'index.ts'),
      [
        "export { motionCapability } from './motion.cap.js'",
        '',
        'export type AnyCapability =',
        '  | typeof motionCapability',
        '',
        "export type CapabilityName = AnyCapability['name']",
        '',
      ].join('\n'),
    )
    return dir
  }

  it('does not write on a dry run, and carries the index diff', () => {
    const dir = capWorkspace()
    const r = scaffoldCapability({
      workspaceRoot: dir,
      name: 'door-lock',
      archetype: 'system-singleton',
    })
    expect(r.dryRun).toBe(true)
    expect(r.files.find((f) => f.action === 'patch')?.diff).toContain(
      '+  | typeof doorLockCapability',
    )
    expect(r.files[0]?.diff).toContain('+++ b/packages/types/src/capabilities/door-lock.cap.ts')
    expect(
      fs.existsSync(path.join(dir, 'packages', 'types', 'src', 'capabilities', 'door-lock.cap.ts')),
    ).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('unifiedDiff', () => {
  it('shows only changed hunks with context', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n')
    const after = ['a', 'b', 'c', 'X', 'e', 'f', 'g', 'h'].join('\n')
    const d = unifiedDiff('f.txt', before, after)
    expect(d).toContain('-d')
    expect(d).toContain('+X')
    expect(d).not.toContain('\n h')
  })
  it('is empty when nothing changed', () => {
    expect(unifiedDiff('f', 'a\nb', 'a\nb')).toBe('')
  })
})
