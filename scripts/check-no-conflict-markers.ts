#!/usr/bin/env tsx
/**
 * Conflict-marker guard — fail the build if a tracked file contains an
 * unresolved git merge marker.
 *
 * ── The bug class this prevents ────────────────────────────────────────────
 * On 2026-08-07 `docs/decisions/adr-0061.md` and `adr-0062.md` were found on
 * `main` with unresolved markers committed by merge 15c0423b3. Three agents had
 * independently taken the number 0061; the merge renumbered one side into
 * adr-0065/0066 but ALSO left its content inside 0061/0062, wrapped in markers.
 *
 * Both decision records were unreadable, and every existing check passed:
 *
 *   - `docs:check` verifies the GENERATED docs are in sync and that no
 *     reference is dead. A conflict marker is neither.
 *   - The index generator parsed straight past the markers and published the
 *     WRONG title for D61 and D62 — it read the second `title:` it found. So the
 *     one artifact a reader would consult to notice the problem actively
 *     concealed it.
 *   - biome/oxlint do not lint markdown, and the affected TypeScript was clean.
 *
 * Nothing here is specific to docs: the same merge could have left markers in a
 * `.ts` file, where the failure surfaces as a confusing parse error at build
 * time rather than as "somebody committed a conflict".
 *
 * ── What this guard does ───────────────────────────────────────────────────
 * Walks every file `git ls-files` reports and flags a line that BEGINS with a
 * 7-character `<` or `>` merge marker.
 *
 * ── Why only the outer two markers ─────────────────────────────────────────
 * The middle marker (seven `=`) is deliberately NOT matched. A setext heading in
 * Markdown underlines its title with a run of `=`, so matching it would fire on
 * ordinary prose and this guard would be deleted within a week. The outer two
 * are unambiguous — they carry a branch label, appear in no legitimate content,
 * and a real conflict always has both. Missing a hand-edited file that kept only
 * the `=` line is the accepted blind spot.
 *
 * The patterns are BUILT at runtime rather than written as literals so that this
 * file — and any document explaining a conflict — does not trip its own check.
 *
 * Run manually: npx tsx scripts/check-no-conflict-markers.ts
 */

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

/** Built, never written literally — see the docblock. */
const OURS_MARKER = `${'<'.repeat(7)} `
const THEIRS_MARKER = `${'>'.repeat(7)} `

/**
 * Files allowed to contain a marker at line start. Only this guard, which must
 * describe what it looks for. Anything added here needs a `why`.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  'scripts/check-no-conflict-markers.ts':
    'this guard; it builds the patterns rather than writing them',
}

/** Extensions whose bytes are not text — a marker cannot be read out of them. */
const BINARY_EXT: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.tgz',
  '.gz',
  '.bin',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp4',
  '.mov',
  '.onnx',
  '.tflite',
  '.node',
  '.wasm',
  '.jar',
  '.so',
  '.dylib',
])

interface Violation {
  readonly file: string
  readonly line: number
  readonly marker: string
}

function trackedFiles(): readonly string[] {
  // The tracked list passed the 1 MiB default buffer (ENOBUFS) and failed every commit.
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
  })
  return out.split('\0').filter((f) => f.length > 0)
}

function scan(rel: string): readonly Violation[] {
  const violations: Violation[] = []
  let src: string
  try {
    src = fs.readFileSync(path.join(ROOT, rel), 'utf-8')
  } catch {
    return violations
  }
  // Cheap reject before splitting: most files contain neither marker.
  if (!src.includes(OURS_MARKER) && !src.includes(THEIRS_MARKER)) return violations
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.startsWith(OURS_MARKER))
      violations.push({ file: rel, line: i + 1, marker: line.trim() })
    else if (line.startsWith(THEIRS_MARKER))
      violations.push({ file: rel, line: i + 1, marker: line.trim() })
  }
  return violations
}

function main(): void {
  const files = trackedFiles()
  const violations: Violation[] = []
  let scanned = 0

  for (const rel of files) {
    if (BINARY_EXT.has(path.extname(rel).toLowerCase())) continue
    if (ALLOWED[rel] !== undefined) continue
    scanned += 1
    violations.push(...scan(rel))
  }

  if (violations.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `\n✗ conflict-marker guard: ${violations.length} unresolved merge marker(s) in tracked files.\n` +
        `  A committed conflict is invisible to docs:check and to the linters, and the\n` +
        `  docs index will publish whichever side it happens to parse first.\n` +
        `  Resolve the merge, then re-run.\n`,
    )
    for (const v of violations) {
      // eslint-disable-next-line no-console
      console.error(`  ${v.file}:${v.line}\n    ${v.marker}`)
    }
    process.exit(1)
  }

  // eslint-disable-next-line no-console
  console.log(`✔ conflict-marker guard: ${scanned} tracked text files, 0 unresolved markers`)
}

main()
