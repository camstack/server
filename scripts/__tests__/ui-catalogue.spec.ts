/**
 * The UI catalogue is what `ui:find` / `ui:show` and the camstack-ui skills
 * stand on: if it misses an export, an agent builds a second one.
 */
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildCatalogue,
  camelKey,
  parseNeedTable,
  parseThemeCss,
  renderCatalogue,
} from '../ui/lib/ui-catalogue.js'
import { rankEntries, rankNeeds } from '../ui/lib/ui-search.js'

const REPO = path.resolve(import.meta.dirname, '..', '..')

describe('reading the library', () => {
  const catalogue = buildCatalogue(REPO)
  const byName = new Map(catalogue.entries.map((e) => [e.name, e]))

  it('follows export * and named re-exports through the barrels', () => {
    expect(byName.get('Button')?.area).toBe('primitives')
    expect(byName.get('DataTable')?.file).toBe('packages/ui-library/src/composites/data-table.tsx')
    expect(byName.get('useConfirm')?.kind).toBe('hook')
    expect(byName.get('TABLE_SCROLL_MAX_H')?.kind).toBe('constant')
  })

  it('reads a component’s props from the type its first parameter names', () => {
    const table = byName.get('DataTable')
    expect(table?.kind).toBe('component')
    expect(table?.props?.map((p) => p.name)).toContain('maxBodyHeight')
    // SecretFieldControl's props type is SecretFieldProps, not <Name>Props.
    expect((byName.get('SecretFieldControl')?.props ?? []).length).toBeGreaterThan(0)
  })

  it('leaves the generated tRPC hooks out', () => {
    expect(catalogue.entries.some((e) => e.area === 'generated')).toBe(false)
  })

  it('renders indented JSON that round-trips', () => {
    const text = renderCatalogue(catalogue)
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(catalogue)))
    expect(text.split('\n').length).toBeGreaterThan(catalogue.entries.length)
  })
})

describe('tokens and the need table', () => {
  it('pairs each CSS colour with its viewer key and both theme values', () => {
    const css =
      '@theme {\n  --color-foreground-muted: #a8a29e;\n  --radius-md: 6px;\n}\n.light {\n  --color-foreground-muted: #57534e;\n}\n'
    expect(parseThemeCss(css)).toEqual({
      colors: [
        {
          name: 'foreground-muted',
          viewerKey: 'foregroundMuted',
          dark: '#a8a29e',
          light: '#57534e',
        },
      ],
      radius: { md: '6px' },
    })
    expect(camelKey('background-elevated')).toBe('backgroundElevated')
  })

  it('parses the need table rows and ranks them by the words an author types', () => {
    const md =
      '| Need | Admin | Viewer | Notes |\n| --- | --- | --- | --- |\n| Confirm before a destructive action | `useConfirm` | `useConfirm` | |\n| A tooltip | `Tooltip` | `Tooltip` | |\n\nAfter.\n'
    const rows = parseNeedTable(md)
    expect(rows).toHaveLength(2)
    expect(rankNeeds(rows, 'confirm delete')[0]?.need).toBe('Confirm before a destructive action')
  })

  it('finds a component by need, not only by name', () => {
    const entries = buildCatalogue(REPO).entries
    const top = rankEntries(entries, 'password field')
      .slice(0, 5)
      .map((e) => e.name)
    expect(top).toContain('PasswordInput')
  })
})
