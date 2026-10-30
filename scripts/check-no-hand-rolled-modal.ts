#!/usr/bin/env tsx
/**
 * No hand-rolled `fixed inset-0` overlay outside the UI library.
 *
 * ## The failure this catches
 *
 * `IntegrationWizard`, `AdoptDevicesModal` and `AddDeviceDialog` each drew
 * their own backdrop with a `fixed inset-0` div. None of them closed on
 * Escape, none was inside the library's modal `HotkeyScope` (so page hotkeys
 * kept firing behind them), and each re-invented the close button, the
 * safe-area height cap and the scroll lock. `Dialog` (a native `<dialog>`
 * opened with `showModal()`, inside `HotkeyScope modal`) is the one modal.
 *
 * ## Scope
 *
 * Every `.tsx` under `packages/<pkg>/src` except `packages/ui-library` (which
 * owns the primitives that legitimately draw overlays: Dialog, BottomSheet,
 * MobileDrawer). Specs and tests are skipped; comments may mention the class.
 *
 * ## Exceptions
 *
 * {@link ALLOWLIST} names each remaining site with its reason. An entry that
 * no longer matches fails the run, so the list cannot rot.
 *
 * Usage: npx tsx scripts/check-no-hand-rolled-modal.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './check-no-bare-ffmpeg.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const SKIP_DIRS = new Set([
  'dist',
  'node_modules',
  '.git',
  'coverage',
  'generated',
  '__tests__',
  '__mocks__',
  'worktrees',
])
const NON_RUNTIME_RE = /\.(?:spec|test)\.tsx$/
const OVERLAY_RE = /\bfixed\s+inset-0\b/

export interface AllowedOverlay {
  readonly file: string
  readonly reason: string
}

export const ALLOWLIST: readonly AllowedOverlay[] = [
  {
    file: 'packages/addon-pipeline/src/stream-broker/widgets/FfmpegParamsField.tsx',
    reason:
      'transparent click-away catcher behind a popover, not a modal (no backdrop, no focus trap)',
  },
  {
    file: 'packages/addon-model-studio/src/components/InstalledSettingsModal.tsx',
    reason: 'addon page modal not yet migrated to Dialog; remove this entry when it is',
  },
  {
    file: 'packages/addon-model-studio/src/components/ImportProgressModal.tsx',
    reason: 'addon page modal not yet migrated to Dialog; remove this entry when it is',
  },
]

export interface OverlayFinding {
  readonly line: number
  readonly text: string
}

/** Lines of `source` whose code (comments removed) uses `fixed inset-0`. */
export function findHandRolledOverlays(source: string): readonly OverlayFinding[] {
  const code = stripComments(source).split('\n')
  const lines = source.split('\n')
  const findings: OverlayFinding[] = []
  code.forEach((line, index) => {
    if (OVERLAY_RE.test(line)) findings.push({ line: index + 1, text: (lines[index] ?? '').trim() })
  })
  return findings
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = path.join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, out)
    else if (entry.endsWith('.tsx') && !NON_RUNTIME_RE.test(entry)) out.push(full)
  }
}

function sourceRoots(): readonly string[] {
  const packagesDir = path.join(ROOT, 'packages')
  return readdirSync(packagesDir)
    .filter((name) => name !== 'ui-library')
    .map((name) => path.join(packagesDir, name, 'src'))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory()
      } catch {
        return false
      }
    })
}

function main(): void {
  const files: string[] = []
  for (const root of sourceRoots()) walk(root, files)

  const allowed = new Map(ALLOWLIST.map((entry) => [entry.file, entry]))
  const used = new Set<string>()
  const violations: Array<OverlayFinding & { readonly file: string }> = []
  for (const full of files) {
    const file = path.relative(ROOT, full).split(path.sep).join('/')
    for (const finding of findHandRolledOverlays(readFileSync(full, 'utf8'))) {
      if (allowed.has(file)) used.add(file)
      else violations.push({ ...finding, file })
    }
  }
  const stale = ALLOWLIST.filter((entry) => !used.has(entry.file))

  if (violations.length === 0 && stale.length === 0) {
    console.log(
      `check-no-hand-rolled-modal: OK (${files.length} .tsx files, ${ALLOWLIST.length} allowed)`,
    )
    return
  }
  if (violations.length > 0) {
    console.error(
      '\n\x1b[31m✘ a hand-rolled `fixed inset-0` overlay outside the UI library:\x1b[0m',
    )
    console.error(
      '  Use `Dialog` + `DialogContent` (width, scroll="body") from @camstack/ui-library.\n',
    )
    for (const v of violations) {
      console.error(`    ${v.file}:${v.line}`)
      console.error(`      \x1b[2m${v.text}\x1b[0m`)
    }
  }
  for (const entry of stale) {
    console.error(
      `\n\x1b[31m✘ stale allowlist entry:\x1b[0m ${entry.file} no longer uses \`fixed inset-0\` — remove it.`,
    )
  }
  console.error('')
  process.exit(1)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
