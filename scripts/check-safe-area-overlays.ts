#!/usr/bin/env tsx
/**
 * Safe-area guard — a viewport-anchored `fixed` overlay never uses a bare
 * edge offset.
 *
 * ## The failure this catches
 *
 * `AppLayout` pads the app shell by `env(safe-area-inset-*)`, and
 * `index.html` sets `viewport-fit=cover` +
 * `apple-mobile-web-app-status-bar-style: black-translucent`. Together those
 * mean the layout viewport starts at y=0 BEHIND the iOS notch / Dynamic
 * Island and ends behind the home indicator.
 *
 * `position: fixed` resolves against that viewport, NOT against the padded
 * shell — so a `fixed` overlay inherits none of AppLayout's protection no
 * matter where it is mounted in the tree. `fixed top-4` is therefore 16px
 * from the PHYSICAL top of the screen, while `safe-area-inset-top` is
 * ~47-59px on every notched iPhone.
 *
 * On 2026-08-07 that is exactly what the operator screenshotted: the
 * "Server restarted — Manual restart by …" toast (`ReconnectOverlay`) painted
 * on top of the iOS status-bar clock. Two more overlays had the same class
 * (`Addons.tsx` bulk-restart toast) or its bottom-edge twin under the home
 * indicator (`ToastContainer`, the boot-probe banner in `App.tsx`).
 *
 * The bug is invisible in review — `top-4` looks obviously correct — and
 * invisible in every desktop browser and non-notched device, where the insets
 * are 0 and the two spellings render identically. It only appears on the
 * installed PWA on hardware. So it gets a check rather than a paragraph.
 *
 * ## Scope
 *
 * The two web surfaces that render into a PWA viewport:
 * `packages/addon-admin-ui/src` and `packages/ui-library/src`. The viewer
 * (`camstack/`) is React-Native and handles this through
 * `react-native-safe-area-context`, not CSS — a different mechanism, so
 * widening the scope here would only add noise.
 *
 * ## What it checks
 *
 * 1. `edge-offset` — `fixed` + a spacing-token edge anchor (`top-4`,
 *    `bottom-4`, `right-4`, …) with no `safe-area-inset` in the same class
 *    string. Fix: `top-[calc(env(safe-area-inset-top)+1rem)]`.
 * 2. `flush-bottom-sheet` — `fixed` + `bottom-0` (a sheet flush with the
 *    bottom edge) with no `safe-area-inset-bottom`. A flush edge must STAY
 *    flush, so the fix is padding, not an offset:
 *    `pb-[env(safe-area-inset-bottom)]`.
 * 3. `viewport-height-cap` — a `max-h-[…100dvh/100vh…]` on a `fixed` element
 *    that does not subtract the insets. A box centred on the viewport and
 *    tall enough to reach its cap pushes its own header under the notch.
 *
 * Deliberately NOT flagged, because each is already correct:
 *   - `fixed inset-0` backdrops — a scrim SHOULD cover the notch.
 *   - `fixed left-1/2 top-1/2 -translate-*` centring — no edge anchor.
 *   - `fixed` with JS-computed `style={{ top, left }}` — follows an anchor
 *     element that is itself already inside the safe area.
 *
 * Usage: tsx scripts/check-safe-area-overlays.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/** Web surfaces that paint into a `viewport-fit=cover` PWA viewport. */
const SCANNED_DIRS: readonly string[] = ['packages/addon-admin-ui/src', 'packages/ui-library/src']

/** Proof the mechanism this guard depends on is still opted into. */
const VIEWPORT_META_FILE = 'packages/addon-admin-ui/index.html'

interface Violation {
  readonly file: string
  readonly line: number
  readonly text: string
  readonly rule: string
}

interface Rule {
  readonly id: string
  readonly test: (classString: string) => boolean
  readonly fix: string
}

/**
 * A Tailwind edge anchor with a spacing token — `top-4`, `bottom-2`,
 * `right-6`, `left-1.5`. Excludes `-1/2` (centring), `-auto`, `-0` (flush,
 * handled by its own rule) and arbitrary values `-[…]` (already explicit).
 *
 * The `(?!\/)` is what excludes the FRACTION forms, and it is load-bearing:
 * `\b` alone is happy to stop between the `1` and the `/` of `top-1/2`, so
 * every centred `fixed left-1/2 top-1/2 -translate-*` dialog — the exact
 * shape this guard's docblock lists as deliberately NOT flagged — matched
 * `edge-offset`. It went unnoticed until the first such dialog was written
 * (`confirm-dialog.tsx`, 2026-09-15) and turned CI red on correct code.
 */
const EDGE_OFFSET_RE =
  /(?:^|[\s'"`:])(?:sm:|md:|lg:|xl:)?(top|bottom|left|right)-\d+(?:\.\d+)?\b(?!\/)/

/** A sheet flush with the bottom viewport edge. */
const FLUSH_BOTTOM_RE = /(?:^|[\s'"`:])(?:sm:|md:|lg:|xl:)?bottom-0\b/

/** A height cap measured against the raw viewport. */
const VIEWPORT_HEIGHT_CAP_RE = /max-h-\[[^\]]*\b(?:100dvh|100vh|\d{2}dvh|\d{2}vh)\b[^\]]*\]/

const HAS_SAFE_AREA_RE = /safe-area-inset/
const HAS_FIXED_RE = /(?:^|[\s'"`])fixed(?:[\s'"`]|$)/

const RULES: readonly Rule[] = [
  {
    id: 'edge-offset',
    test: (c) => HAS_FIXED_RE.test(c) && EDGE_OFFSET_RE.test(c) && !HAS_SAFE_AREA_RE.test(c),
    fix: 'use top-[calc(env(safe-area-inset-top)+1rem)] (and the matching right/bottom/left form)',
  },
  {
    id: 'flush-bottom-sheet',
    test: (c) =>
      HAS_FIXED_RE.test(c) && FLUSH_BOTTOM_RE.test(c) && !/safe-area-inset-bottom/.test(c),
    fix: 'a flush edge stays flush — absorb the inset as pb-[env(safe-area-inset-bottom)]',
  },
  {
    id: 'viewport-height-cap',
    test: (c) =>
      HAS_FIXED_RE.test(c) && VIEWPORT_HEIGHT_CAP_RE.test(c) && !HAS_SAFE_AREA_RE.test(c),
    fix: 'subtract the insets from the cap, e.g. max-h-[calc(100dvh-2rem-2*max(env(safe-area-inset-top),env(safe-area-inset-bottom)))]',
  },
]

/**
 * The rule ids a single class string violates. Exported so the regexes above
 * can be exercised directly — a guard whose false positives are only ever
 * discovered by turning main red is a guard nobody can safely tighten.
 */
export function rulesViolatedBy(classString: string): readonly string[] {
  return RULES.filter((rule) => rule.test(classString)).map((rule) => rule.id)
}

function listSourceFiles(dir: string, out: string[]): void {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      listSourceFiles(rel, out)
      continue
    }
    if (!entry.name.endsWith('.tsx')) continue
    out.push(rel)
  }
}

/**
 * Blank out comment bodies so the prose describing this failure — which this
 * repo writes at length, and which necessarily quotes the broken spelling —
 * is not itself a violation.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '')
}

/**
 * Class lists are routinely split across several lines by the formatter, and
 * an anchor can land on a different line from its `fixed`. Joining a quoted
 * string with the lines around it keeps the rules seeing one class string.
 */
function windowAt(lines: readonly string[], index: number): string {
  return lines.slice(Math.max(0, index - 3), Math.min(lines.length, index + 4)).join(' ')
}

function main(): void {
  const files: string[] = []
  for (const dir of SCANNED_DIRS) listSourceFiles(dir, files)

  if (files.length === 0) {
    console.error('✗ safe-area guard: scanned no files — the scan roots have moved')
    process.exit(1)
  }

  // `env()` evaluates to 0 without `viewport-fit=cover`, which would make
  // every fix in the tree silently inert. Verify the opt-in still exists.
  const metaPath = path.join(ROOT, VIEWPORT_META_FILE)
  if (!fs.existsSync(metaPath) || !/viewport-fit=cover/.test(fs.readFileSync(metaPath, 'utf8'))) {
    console.error(
      `✗ safe-area guard: \`viewport-fit=cover\` is missing from ${VIEWPORT_META_FILE}.\n` +
        '  Without it every env(safe-area-inset-*) in the app resolves to 0 and all\n' +
        '  the offsets this guard enforces become no-ops.',
    )
    process.exit(1)
  }

  const violations: Violation[] = []
  for (const file of files) {
    if (file.includes('__tests__') || file.includes('.spec.')) continue
    const lines = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8')).split('\n')
    lines.forEach((text, index) => {
      if (!HAS_FIXED_RE.test(text)) return
      const classString = windowAt(lines, index)
      for (const rule of RULES) {
        if (rule.test(classString)) {
          violations.push({ file, line: index + 1, text: text.trim().slice(0, 160), rule: rule.id })
        }
      }
    })
  }

  if (violations.length === 0) {
    console.log(
      `✓ safe-area guard: ${files.length} files, every fixed overlay clears the notch/home indicator`,
    )
    return
  }

  console.error('✗ safe-area guard: fixed overlay anchored to the raw viewport edge\n')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule}]`)
    console.error(`      ${v.text}`)
    console.error(`      → ${RULES.find((r) => r.id === v.rule)?.fix ?? ''}\n`)
  }
  console.error(
    '`position: fixed` resolves against the VIEWPORT, so it bypasses the\n' +
      '`env(safe-area-inset-*)` padding AppLayout puts on the app shell. Under\n' +
      '`viewport-fit=cover` that viewport starts behind the iOS notch — which is\n' +
      'how the restart toast came to paint on top of the status-bar clock.',
  )
  process.exit(1)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
