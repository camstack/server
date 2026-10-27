/**
 * `ui:check` — the off-system UI shapes an author (or an agent) reaches for
 * when they did not look at the library first, each reported WITH the thing
 * that replaces it.
 *
 * A developer tool, never a CI gate (operator decision, 2026-10-09): the
 * pre-commit hook runs it on staged UI files in `--warn` mode, which prints
 * and never fails the commit. The drift that exists today is reported, not
 * fixed — new drift is what this is for.
 *
 * Pure: `checkUiSource(path, text)` → findings. The CLI lives in
 * `scripts/ui/cli.ts`.
 *
 * Escape hatch: `ui-check-ok: <reason>` in a comment on the same line or the
 * line above (a video overlay that must be black on every theme, a primitive
 * that IS the raw element).
 */

export type UiRule =
  | 'raw-hex'
  | 'raw-color-fn'
  | 'palette-class'
  | 'inline-style'
  | 'raw-button'
  | 'raw-table'
  | 'raw-select'
  | 'raw-dialog'
  | 'native-dialog-call'
  | 'inline-confirm-state'
  | 'raw-password-input'
  | 'shadows-library'

export interface UiFinding {
  readonly file: string
  readonly line: number
  readonly rule: UiRule
  readonly match: string
  readonly message: string
}

/** `#hex` → semantic token name, from the theme (`camstack-theme.css`). */
export type HexTokenMap = ReadonlyMap<string, string>

const SUPPRESS = /ui-check-ok/

const PALETTE_HUES =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
const PALETTE_PREFIXES =
  'bg|text|border|border-[trblxy]|ring|ring-offset|from|via|to|fill|stroke|outline|divide|placeholder|decoration|shadow|accent|caret'
const PALETTE_CLASS = new RegExp(
  `(?<![\\w-])(?:[a-z0-9-]+:)*(${PALETTE_PREFIXES})-(${PALETTE_HUES})-(50|[1-9]00|950)(\\/\\d{1,3})?(?![\\w-])`,
  'g',
)
const HEX = /(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_-])/g
const COLOR_FN = /(?<![\w-])(rgba?|hsla?)\(/g

const SEMANTIC_BY_HUE: Readonly<Record<string, string>> = {
  red: 'danger',
  rose: 'danger',
  pink: 'danger',
  orange: 'warning',
  amber: 'warning',
  yellow: 'warning',
  green: 'success',
  emerald: 'success',
  lime: 'success',
  teal: 'success',
  blue: 'info',
  sky: 'info',
  indigo: 'info',
  cyan: 'info',
}

const NEUTRAL_HUES: readonly string[] = ['slate', 'gray', 'zinc', 'neutral', 'stone']

const NEUTRAL_BY_PREFIX: Readonly<Record<string, string>> = {
  bg: '`bg-surface` / `bg-surface-hover` / `bg-background` / `bg-background-elevated`',
  text: '`text-foreground` / `text-foreground-muted` / `text-foreground-subtle`',
  border: '`border-border` / `border-border-subtle`',
}

/** The token utility that replaces one palette class. */
export function paletteReplacement(prefix: string, hue: string, opacity: string): string {
  const base = prefix.startsWith('border') ? 'border' : prefix
  if (NEUTRAL_HUES.includes(hue)) {
    return NEUTRAL_BY_PREFIX[base] ?? '`*-foreground-*` / `*-surface*` / `*-border*` tokens'
  }
  const semantic = SEMANTIC_BY_HUE[hue]
  if (semantic) return `\`${prefix}-${semantic}${opacity}\``
  return '`primary` or a NEW token in camstack-theme.css (no semantic token for this hue)'
}

const LINE_COMMENT = /^\s*(\/\/|\*|\/\*)/

/** Library files that ARE the raw element, so the element rules do not apply. */
function implementsPrimitive(file: string): boolean {
  return /packages\/ui-library\/src\/primitives\//.test(file)
}

export function isCheckedFile(file: string): boolean {
  if (!/\.(tsx?|css)$/.test(file) || file.endsWith('.d.ts')) return false
  if (/(^|\/)(__tests__|__mocks__)\//.test(file) || /\.(spec|test|stories)\.[jt]sx?$/.test(file)) {
    return false
  }
  if (/(^|\/)(node_modules|dist|build)\//.test(file)) return false
  return true
}

interface ElementRule {
  readonly rule: UiRule
  readonly pattern: RegExp
  readonly message: string
}

const ELEMENT_RULES: readonly ElementRule[] = [
  {
    rule: 'raw-button',
    pattern: /<button\b/g,
    message:
      'raw <button> → `Button` (variant/size) or `IconButton` (icon-only, needs aria-label); a dialog close is `DialogContent`’s own',
  },
  {
    rule: 'raw-table',
    pattern: /<table\b/g,
    message:
      'raw <table> → `DataTable` (+ `maxBodyHeight={TABLE_SCROLL_MAX_H}`, `DataTableFilterBar`) or `DeviceList mode="generic"` for rows that expand',
  },
  {
    rule: 'raw-select',
    pattern: /<select\b/g,
    message:
      'raw <select> → `Select` (options prop), a schema `select` field via `ConfigFormBuilder`, or `NodePicker` / `DeviceSelectField` for nodes and devices',
  },
  {
    rule: 'raw-dialog',
    pattern: /<dialog\b|role=["']dialog["']/g,
    message:
      'hand-rolled dialog → `Dialog` + `DialogContent` (`scroll="body"` when tall, `placement="sheet-on-mobile"`), or `useConfirm` / `ConfirmActionButton`',
  },
  {
    rule: 'raw-password-input',
    pattern: /<input\b[^>]*type=["']password["']/g,
    message:
      'raw password <input> → `PasswordInput`, or `SecretFieldControl` for a keychain-backed settings field',
  },
]

const RAW_DIALOG_MESSAGE = ELEMENT_RULES.find((r) => r.rule === 'raw-dialog')?.message ?? ''

/**
 * A hand-rolled modal is a full-viewport scrim: `fixed` + `inset-0` + a
 * translucent black/background fill, in any class order.
 */
export function isModalScrim(line: string): boolean {
  return (
    /\bfixed\b/.test(line) &&
    /\binset-0\b/.test(line) &&
    /\bbg-(black|background)\/\d{1,3}\b/.test(line)
  )
}

/**
 * An inline two-step destructive confirm: a state hook named for the pending
 * delete (`confirmDelete`, `confirmingRemove`, `pendingDelete`, `confirming`)
 * that swaps the row's buttons for "Delete?/Cancel" in place. The product's
 * answer is a modal that names the item.
 */
const INLINE_CONFIRM_STATE =
  /\bconst\s+\[\s*(?:confirm(?:ing)?(?:Delete|Remove|Deletion)\w*|confirming|pending(?:Delete|Remove|Deletion)\w*)\s*,\s*set\w+\s*\]\s*=\s*useState\b/g

const NATIVE_DIALOG_CALL = /\bwindow\.(confirm|alert|prompt)\(/g

const STYLE_TOKEN_KEYS =
  /\b(color|background|backgroundColor|borderColor|margin\w*|padding\w*|fontSize|fontWeight|gap)\s*:/

function hexMessage(hex: string, tokens: HexTokenMap): string {
  const token = tokens.get(hex.toLowerCase())
  return token
    ? `raw ${hex} is the \`${token}\` token → \`text-${token}\` / \`bg-${token}\` / \`border-${token}\` (or \`var(--color-${token})\` in an SVG/canvas)`
    : `raw ${hex} → a theme token (\`ui:tokens\`); a colour the theme lacks is added to camstack-theme.css, not inlined`
}

/**
 * `libraryComponents`: the names `@camstack/ui-library` exports as components.
 * A file outside the library that EXPORTS a component of the same name is a
 * local look-alike (admin-ui's `shared/StatusBadge.tsx` beside the library's
 * `StatusBadge`) — the second answer to a question the library already answers.
 */
export function checkUiSource(
  file: string,
  source: string,
  tokens: HexTokenMap = new Map(),
  libraryComponents: ReadonlySet<string> = new Set(),
): UiFinding[] {
  if (!isCheckedFile(file)) return []
  const findings: UiFinding[] = []
  const lines = source.split('\n')
  const isTsx = file.endsWith('.tsx')
  const isCss = file.endsWith('.css')
  const elementsApply = isTsx && !implementsPrimitive(file)
  const push = (line: number, rule: UiRule, match: string, message: string): void => {
    findings.push({ file, line, rule, match, message })
  }

  for (const [index, text] of lines.entries()) {
    const lineNo = index + 1
    if (SUPPRESS.test(text) || (index > 0 && SUPPRESS.test(lines[index - 1] ?? ''))) continue
    if (LINE_COMMENT.test(text)) continue

    // The theme file IS where hex lives.
    if (!isCss || !file.endsWith('camstack-theme.css')) {
      for (const m of text.matchAll(HEX)) push(lineNo, 'raw-hex', m[0], hexMessage(m[0], tokens))
      for (const m of text.matchAll(COLOR_FN)) {
        if (/var\(--/.test(text.slice(m.index ?? 0, (m.index ?? 0) + 24))) continue
        push(
          lineNo,
          'raw-color-fn',
          `${m[1]}(`,
          `raw ${m[1]}() → a theme token; for alpha use the \`/NN\` modifier (\`bg-danger/10\`)`,
        )
      }
    }
    if (isCss) continue

    for (const m of text.matchAll(PALETTE_CLASS)) {
      const [whole, prefix, hue, , opacity] = m
      push(
        lineNo,
        'palette-class',
        whole,
        `palette class ${whole} → ${paletteReplacement(prefix, hue, opacity ?? '')}`,
      )
    }

    if (isTsx && /\bstyle=\{/.test(text)) {
      const tokenish = STYLE_TOKEN_KEYS.test(text)
      push(
        lineNo,
        'inline-style',
        'style={…}',
        tokenish
          ? 'inline colour/spacing style → Tailwind token utilities (`text-*`, `bg-*`, `p-2 sm:p-4`, `gap-*`)'
          : 'inline style — acceptable ONLY for computed geometry (width %, transform, top/left); colour and spacing are utilities',
      )
    }

    if (elementsApply) {
      for (const r of ELEMENT_RULES) {
        for (const m of text.matchAll(r.pattern)) push(lineNo, r.rule, m[0], r.message)
      }
      if (isModalScrim(text))
        push(lineNo, 'raw-dialog', 'fixed inset-0 … scrim', RAW_DIALOG_MESSAGE)
    }
    if (isTsx) {
      for (const m of text.matchAll(INLINE_CONFIRM_STATE)) {
        push(
          lineNo,
          'inline-confirm-state',
          m[0],
          "inline destructive confirm → `useConfirm` from @camstack/ui-library: `await confirm({ title, message: <names the item>, confirmLabel, variant: 'danger' })` (modal, danger variant)",
        )
      }
    }
    for (const m of text.matchAll(NATIVE_DIALOG_CALL)) {
      push(
        lineNo,
        'native-dialog-call',
        m[0],
        `window.${m[1]}() → \`use${m[1][0].toUpperCase()}${m[1].slice(1)}\` from @camstack/ui-library (needs \`ConfirmDialogProvider\`)`,
      )
    }
  }
  if (isTsx && !file.startsWith('packages/ui-library/')) {
    for (const [index, text] of lines.entries()) {
      const m = /^export\s+(?:default\s+)?(?:function|const)\s+([A-Z]\w*)/.exec(text)
      if (m && libraryComponents.has(m[1]) && !SUPPRESS.test(text)) {
        push(
          index + 1,
          'shadows-library',
          m[1],
          `local ${m[1]} duplicates the library's \`${m[1]}\` → import it from @camstack/ui-library, or extend it with a prop`,
        )
      }
    }
  }
  return findings
}

export function formatFinding(f: UiFinding): string {
  return `${f.file}:${f.line}  ${f.rule}  ${f.message}`
}

export function summarizeFindings(findings: readonly UiFinding[]): {
  readonly byRule: Record<string, number>
  readonly filesByRule: Record<string, number>
  readonly files: number
} {
  const byRule: Record<string, number> = {}
  const filesPerRule = new Map<string, Set<string>>()
  for (const f of findings) {
    byRule[f.rule] = (byRule[f.rule] ?? 0) + 1
    const set = filesPerRule.get(f.rule) ?? new Set<string>()
    set.add(f.file)
    filesPerRule.set(f.rule, set)
  }
  const filesByRule: Record<string, number> = {}
  for (const [rule, set] of filesPerRule) filesByRule[rule] = set.size
  return { byRule, filesByRule, files: new Set(findings.map((f) => f.file)).size }
}
