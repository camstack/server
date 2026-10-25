#!/usr/bin/env tsx
/**
 * Addon-id guard — `ctx.id` is never compared to, or published as, a
 * registry/store addon id without being normalised first.
 *
 * ## The failure this catches
 *
 * `AddonContext.id` has two spellings and nothing warns you which one you
 * hold:
 *
 *   - forked addon → `composer`
 *     (`packages/system/src/kernel/moleculer/addon-context-factory.ts`)
 *   - hub-main builtin → `addon:composer`
 *     (`server/backend/src/core/addon/addon-registry.service.ts`)
 *
 * Everything it might be compared AGAINST carries the bare form:
 * `DeviceBindingEntry.providerAddonId`, `deviceBindings[…].wrapperAddonId`,
 * capability-registry provider keys, `/addon/<id>/…` data-plane routes.
 *
 * So `entry.providerAddonId === this.ctx.id` inside a builtin is false for
 * every entry, forever — a defect that looks exactly like the fact it is
 * testing for. On 2026-08-07 that comparison made the (since retired, D671)
 * virtual doorbell's binding mirror latch `unbound` for twelve hours while the
 * binding was intact, and it DROPPED a real press on camera 101 (D72). It survived a
 * suite that pinned the gate, because the fake supplied the bare id.
 *
 * A raw `===` here is unreviewable: both sides are strings named like addon
 * ids, and the bug only exists in one of the two processes the same file
 * runs in. So it gets a check.
 *
 * ## Scope
 *
 * Only the code that can run in hub-main, where the prefix exists:
 * `packages/system/src/builtins/**` and `server/backend/src/**`. A forked-only
 * addon never sees the prefixed form; widening the scope would add noise
 * without adding safety, and a noisy guard gets deleted.
 *
 * ## What it checks
 *
 * 1. No `ctx.id` on either side of `===` / `!==`. Use `isSameAddonId`.
 * 2. No hand-rolled prefix stripping (`.replace('addon:', '')` and friends).
 *    Use `bareAddonId`.
 * 3. No `providerAddonId:` / `wrapperAddonId:` / `nativeAddonId:` assigned
 *    from a bare `ctx.id` — those fields are consumed as manifest ids.
 *
 * Usage: tsx scripts/check-addon-id-comparison.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/** Trees whose code can run inside hub-main, where `ctx.id` is prefixed. */
const SCANNED_DIRS: readonly string[] = ['packages/system/src/builtins', 'server/backend/src']

/** The helpers this guard exists to route callers to. */
const HELPER_FILE = 'packages/types/src/utils/addon-id.ts'

interface Violation {
  readonly file: string
  readonly line: number
  readonly text: string
  readonly rule: string
}

const RULES: ReadonlyArray<{
  readonly id: string
  readonly re: RegExp
  readonly fix: string
}> = [
  {
    id: 'raw-equality',
    re: /(?:ctx\.id\s*(?:===|!==))|(?:(?:===|!==)\s*[A-Za-z_$][\w$.]*\bctx\.id)/,
    fix: "use isSameAddonId(a, b) from '@camstack/types'",
  },
  {
    id: 'hand-rolled-strip',
    re: /\.(?:replace|replaceAll)\(\s*['"`]addon:['"`]|\.slice\(\s*['"`]addon:['"`]\.length/,
    fix: "use bareAddonId(id) from '@camstack/types'",
  },
  {
    id: 'prefixed-id-published',
    re: /\b(?:providerAddonId|wrapperAddonId|nativeAddonId)\s*:\s*(?!bareAddonId\()[A-Za-z_$][\w$.]*\bctx\.id\b/,
    fix: 'wrap in bareAddonId(...) — these fields are consumed as manifest ids',
  },
]

function listTsFiles(dir: string, out: string[]): void {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      listTsFiles(rel, out)
      continue
    }
    if (!entry.name.endsWith('.ts')) continue
    if (entry.name.endsWith('.d.ts')) continue
    out.push(rel)
  }
}

/**
 * Strip line comments and block-comment bodies so a doc comment describing
 * the bug (this repo documents its failures at length) is not itself a
 * violation.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '')
}

function main(): void {
  const files: string[] = []
  for (const dir of SCANNED_DIRS) listTsFiles(dir, files)

  const violations: Violation[] = []
  for (const file of files) {
    if (file.includes('__tests__') || file.endsWith('.spec.ts')) continue
    const raw = fs.readFileSync(path.join(ROOT, file), 'utf8')
    const lines = stripComments(raw).split('\n')
    lines.forEach((text, index) => {
      for (const rule of RULES) {
        if (rule.re.test(text)) {
          violations.push({
            file,
            line: index + 1,
            text: text.trim(),
            rule: rule.id,
          })
        }
      }
    })
  }

  if (!fs.existsSync(path.join(ROOT, HELPER_FILE))) {
    console.error(`✗ the addon-id helpers are gone (${HELPER_FILE}) — this guard has no target`)
    process.exit(1)
  }

  if (violations.length === 0) {
    console.log(`✓ addon-id guard: ${files.length} files, no raw ctx.id addon-id comparisons`)
    return
  }

  console.error('✗ addon-id guard: ctx.id compared/published without normalisation\n')
  for (const v of violations) {
    const fix = RULES.find((r) => r.id === v.rule)?.fix ?? ''
    console.error(`  ${v.file}:${v.line}  [${v.rule}]`)
    console.error(`      ${v.text}`)
    console.error(`      → ${fix}\n`)
  }
  console.error(
    'ctx.id is `addon:<id>` in hub-main and `<id>` in a forked runner; every\n' +
      'registry/store field carries the bare form. See docs/decisions/adr-0072.md.',
  )
  process.exit(1)
}

main()
