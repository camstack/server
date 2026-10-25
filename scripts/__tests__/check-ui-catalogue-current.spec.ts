/**
 * The catalogue drift guard, on a throwaway workspace: a stale committed file
 * fails, a current one passes, and the viewer kit is indexed when the
 * submodule is there and CARRIED (not dropped) when it is not.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildViewerEntries,
  CATALOGUE_PATH,
  catalogueDrift,
  regenerateCatalogue,
} from '../ui/lib/ui-catalogue.js'

let root = ''

function write(rel: string, text: string): void {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

function commit(): void {
  write(CATALOGUE_PATH, regenerateCatalogue(root).text)
}

function withViewerKit(): void {
  write(
    'camstack/src/components/ui/Chip.tsx',
    [
      'interface ChipProps { readonly label: string }',
      '/** A small chip. */',
      'export function Chip({ label }: ChipProps) { return label }',
      '',
    ].join('\n'),
  )
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-catalogue-'))
  write('packages/ui-library/src/index.ts', "export * from './primitives/badge.js'\n")
  write(
    'packages/ui-library/src/primitives/badge.tsx',
    [
      'interface BadgeProps { readonly tone?: string }',
      '/** A badge. */',
      'export function Badge({ tone }: BadgeProps) { return tone }',
      '',
    ].join('\n'),
  )
  write(
    'packages/ui-library/src/tailwind/camstack-theme.css',
    '@theme {\n  --color-surface: #111111;\n}\n',
  )
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('catalogueDrift', () => {
  it('passes when the committed file is what the sources produce', () => {
    commit()
    expect(catalogueDrift(root).stale).toBe(false)
  })

  it('fails when a library export changed after the file was committed', () => {
    commit()
    write(
      'packages/ui-library/src/primitives/badge.tsx',
      'export function Badge2() { return null }\n',
    )
    const drift = catalogueDrift(root)
    expect(drift.stale).toBe(true)
    expect(drift.message).toContain('npm run ui:catalogue')
  })

  it('fails when no catalogue is committed at all', () => {
    expect(catalogueDrift(root).stale).toBe(true)
  })
})

describe('the viewer kit', () => {
  it('is indexed when the submodule is present', () => {
    withViewerKit()
    expect(buildViewerEntries(root)?.map((e) => e.name)).toEqual(['Chip'])
    commit()
    const drift = catalogueDrift(root)
    expect(drift.stale).toBe(false)
    expect(drift.viewerSource).toBe('indexed')
  })

  it('is stale when a viewer component changed', () => {
    withViewerKit()
    commit()
    write('camstack/src/components/ui/Chip.tsx', 'export function Chip2() { return null }\n')
    expect(catalogueDrift(root).stale).toBe(true)
  })

  it('is carried, and said to be, when the submodule is absent', () => {
    withViewerKit()
    commit()
    fs.rmSync(path.join(root, 'camstack'), { recursive: true })
    expect(buildViewerEntries(root)).toBeNull()
    const drift = catalogueDrift(root)
    expect(drift.stale).toBe(false)
    expect(drift.viewerSource).toBe('carried')
    expect(drift.message).toContain('submodule absent')
    expect(regenerateCatalogue(root).catalogue.viewerEntries.map((e) => e.name)).toEqual(['Chip'])
  })

  it('leaves hooks of a .tsx file in, and helpers of .ts files out', () => {
    withViewerKit()
    write('camstack/src/components/ui/helper.ts', 'export function nextPhase() { return 1 }\n')
    write('camstack/src/components/ui/useThing.tsx', 'export function useThing() { return 1 }\n')
    expect(buildViewerEntries(root)?.map((e) => `${e.name}:${e.kind}`)).toEqual([
      'Chip:component',
      'useThing:hook',
    ])
  })
})
