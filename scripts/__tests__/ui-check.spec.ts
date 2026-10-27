/**
 * `ui:check` reports the off-system UI shapes an author reaches for without
 * looking at the library, each with its replacement — and nothing else. A
 * finding on legitimate code teaches people to skip the tool, so the misses
 * matter as much as the hits.
 */
import { describe, expect, it } from 'vitest'
import {
  checkUiSource,
  isCheckedFile,
  isModalScrim,
  paletteReplacement,
  summarizeFindings,
} from '../ui/lib/ui-check.js'

const ADMIN = 'packages/addon-admin-ui/src/components/x/Thing.tsx'
const rules = (
  file: string,
  src: string,
  tokens: ReadonlyMap<string, string> = new Map(),
  library: ReadonlySet<string> = new Set(),
): string[] => checkUiSource(file, src, tokens, library).map((f) => f.rule)

describe('colours', () => {
  it('flags raw hex and names the token when the value is one', () => {
    const tokens = new Map([['#f87171', 'danger']])
    const [finding] = checkUiSource(ADMIN, `const c = '#F87171'\n`, tokens)
    expect(finding?.rule).toBe('raw-hex')
    expect(finding?.message).toContain('`danger` token')
    expect(finding?.message).toContain('text-danger')
  })

  it('flags an arbitrary-value hex class', () => {
    expect(rules(ADMIN, '<div className="bg-[#123456]" />\n')).toEqual(['raw-hex'])
  })

  it('does not take an HTML entity or an anchor-ish id for a colour', () => {
    expect(rules(ADMIN, '<span>&#123456;</span>\n')).toEqual([])
    expect(rules(ADMIN, "const id = 'section#details'\n")).toEqual([])
  })

  it('flags rgb()/hsl() but not a token read through var()', () => {
    expect(rules(ADMIN, "const a = 'rgba(0,0,0,0.5)'\n")).toEqual(['raw-color-fn'])
    expect(rules(ADMIN, "const a = 'rgb(var(--color-danger))'\n")).toEqual([])
  })

  it('leaves the theme file alone — it is where the hex lives', () => {
    const css = '--color-danger: #f87171;\n'
    expect(rules('packages/ui-library/src/tailwind/camstack-theme.css', css)).toEqual([])
    expect(rules('packages/addon-x/src/page.css', css)).toEqual(['raw-hex'])
  })
})

describe('palette classes', () => {
  it('maps a status hue to its semantic token, keeping the opacity', () => {
    const [f] = checkUiSource(ADMIN, '<div className="bg-red-500/10 p-2" />\n')
    expect(f?.rule).toBe('palette-class')
    expect(f?.message).toContain('`bg-danger/10`')
  })

  it('flags a variant-prefixed class and each class of a dark: twin', () => {
    const src = '<p className="text-emerald-700 dark:text-emerald-300" />\n'
    expect(rules(ADMIN, src)).toEqual(['palette-class', 'palette-class'])
  })

  it('suggests surface/foreground tokens for the neutral scales', () => {
    expect(paletteReplacement('bg', 'zinc', '')).toContain('bg-surface')
    expect(paletteReplacement('text', 'stone', '')).toContain('text-foreground-muted')
    expect(paletteReplacement('border-b', 'gray', '')).toContain('border-border')
  })

  it('does not flag theme utilities that merely look similar', () => {
    expect(
      rules(ADMIN, '<div className="bg-danger/10 text-foreground-muted border-border" />\n'),
    ).toEqual([])
    expect(rules(ADMIN, '<div className="bg-surface-hover" />\n')).toEqual([])
  })
})

describe('elements', () => {
  it('flags raw button, table, select and a password input, each with its replacement', () => {
    const src = [
      '<button onClick={x}>Go</button>',
      '<table />',
      '<select value={v} />',
      '<input type="password" />',
    ].join('\n')
    const found = checkUiSource(ADMIN, src)
    expect(found.map((f) => f.rule)).toEqual([
      'raw-button',
      'raw-table',
      'raw-select',
      'raw-password-input',
    ])
    expect(found[0]?.message).toContain('`Button`')
    expect(found[1]?.message).toContain('`DataTable`')
    expect(found[2]?.message).toContain('`Select`')
    expect(found[3]?.message).toContain('`PasswordInput`')
  })

  it('recognises a hand-rolled modal scrim in any class order', () => {
    expect(isModalScrim('className="fixed inset-0 z-50 bg-background/80"')).toBe(true)
    expect(isModalScrim('className="z-50 bg-black/60 inset-0 fixed"')).toBe(true)
    expect(isModalScrim('className="fixed inset-0 pointer-events-none"')).toBe(false)
    expect(rules(ADMIN, '<div role="dialog" />\n')).toEqual(['raw-dialog'])
  })

  it('flags window.confirm and names the hook', () => {
    const [f] = checkUiSource(ADMIN, 'if (window.confirm("sure?")) go()\n')
    expect(f?.rule).toBe('native-dialog-call')
    expect(f?.message).toContain('useConfirm')
  })

  it('flags an inline two-step delete confirm and points at useConfirm', () => {
    for (const decl of [
      'const [confirmDelete, setConfirmDelete] = useState<string | null>(null)',
      'const [confirming, setConfirming] = useState<string | null>(null)',
      'const [pendingDelete, setPendingDelete] = useState(false)',
    ]) {
      const [f] = checkUiSource(ADMIN, `${decl}\n`)
      expect(f?.rule).toBe('inline-confirm-state')
      expect(f?.message).toContain('useConfirm')
    }
    expect(rules(ADMIN, 'const [confirmPassword, setConfirmPassword] = useState("")\n')).toEqual([])
    expect(rules(ADMIN, 'const [confirmOpen, setConfirmOpen] = useState(false)\n')).toEqual([])
  })

  it('does not apply element rules to the primitives that ARE those elements, or to a .ts file', () => {
    expect(rules('packages/ui-library/src/primitives/button.tsx', '<button />\n')).toEqual([])
    expect(rules('packages/addon-admin-ui/src/lib/x.ts', "const s = '<button>'\n")).toEqual([])
  })
})

describe('inline styles', () => {
  it('distinguishes colour/spacing from computed geometry', () => {
    const [colour] = checkUiSource(ADMIN, "<div style={{ color: 'red' }} />\n")
    const [geometry] = checkUiSource(ADMIN, '<div style={{ width: `${pct}%` }} />\n')
    expect(colour?.message).toContain('colour/spacing')
    expect(geometry?.message).toContain('ONLY for computed geometry')
  })
})

describe('local look-alikes', () => {
  const library = new Set(['StatusBadge', 'Button'])

  it('flags a local component exported under a library component name', () => {
    const src = 'export function StatusBadge() { return null }\n'
    expect(rules(ADMIN, src, new Map(), library)).toEqual(['shadows-library'])
  })

  it('accepts a re-export and the library itself', () => {
    expect(
      rules(ADMIN, "export { StatusBadge } from '@camstack/ui-library'\n", new Map(), library),
    ).toEqual([])
    expect(
      rules(
        'packages/ui-library/src/composites/status-badge.tsx',
        'export function StatusBadge() {}\n',
        new Map(),
        library,
      ),
    ).toEqual([])
  })
})

describe('scope and escape hatch', () => {
  it('skips specs, tests, declarations and comments', () => {
    expect(isCheckedFile('packages/addon-admin-ui/src/x/__tests__/a.spec.tsx')).toBe(false)
    expect(isCheckedFile('packages/addon-admin-ui/src/a.test.tsx')).toBe(false)
    expect(isCheckedFile('packages/addon-admin-ui/src/a.d.ts')).toBe(false)
    expect(rules(ADMIN, '// the old colour was #ff0000\n * bg-red-500 in a doc comment\n')).toEqual(
      [],
    )
  })

  it('honours ui-check-ok on the line or the line above', () => {
    expect(rules(ADMIN, "const c = '#000' // ui-check-ok: video letterbox\n")).toEqual([])
    expect(rules(ADMIN, "{/* ui-check-ok: terminal palette */}\nconst c = '#000'\n")).toEqual([])
  })

  it('counts findings per rule and per file', () => {
    const f = [
      ...checkUiSource(ADMIN, '<button />\n<button />\n'),
      ...checkUiSource('packages/addon-x/src/b.tsx', '<button />\n'),
    ]
    expect(summarizeFindings(f)).toEqual({
      byRule: { 'raw-button': 3 },
      filesByRule: { 'raw-button': 2 },
      files: 2,
    })
  })
})
