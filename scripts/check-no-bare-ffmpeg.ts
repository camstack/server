#!/usr/bin/env tsx
/**
 * No bare `ffmpeg` / `ffprobe` in runtime source — the enforcement D540 lacked.
 *
 * D540: every node runs the SAME pinned ffmpeg (`ctx.deps.ensureFfmpeg()`),
 * and the system PATH is never a candidate. The rule was enforced where the
 * binary is RESOLVED (`ffmpeg-binary-source.spec.ts`) and nowhere it is
 * SPAWNED, so the repo kept a dozen ways to reach PATH anyway:
 *
 *   - `spawn('ffmpeg', …)` / `execFile('ffprobe', …)` — the name, verbatim;
 *   - `deps.ffmpegPath ?? 'ffmpeg'` — an optional path whose default is PATH.
 *     The timelapse preview did exactly this and its caller never passed a
 *     path, so it ran the host's binary while its spec stayed green: the fake
 *     runner accepted any command name;
 *   - `private ffmpegBinaryPath = 'ffmpeg'` — the value a resolver that failed
 *     leaves behind, so "the pinned build is unavailable" became "run the
 *     host's" without a line in the log;
 *   - `fluent-ffmpeg`, `ffmpeg-static` and friends, whose defaults are PATH or
 *     a binary we did not pin.
 *
 * A runtime site asks `memoizePinnedFfmpeg(() => ctx.deps.ensureFfmpeg())`
 * (`@camstack/types`) or is handed a REQUIRED path by its addon, and when the
 * binary cannot be had it refuses with a logged reason. There is no pinned
 * `ffprobe` at all — the provisioning extracts `ffmpeg` only — so an `ffprobe`
 * literal in runtime source can only ever mean PATH.
 *
 * ## Scope
 *
 * Runtime source: `packages/<pkg>/src` and `server/backend/src`, excluding
 * specs, `__tests__` and generated code. `scripts/` is not scanned: those are
 * dev tools run by a developer on a workstation, not code a node runs.
 *
 * ## What it cannot see
 *
 * It is textual. A binary name assembled at runtime (`'ff' + 'mpeg'`), or a
 * default hidden behind a constant with an innocent name
 * (`const X = 'ffmpeg'; spawn(X)`) passes. The named-binding rule narrows the
 * second: a binding whose NAME says path/bin/binary/cmd/executable and whose
 * value is the bare name is refused whatever it is later used for.
 *
 * Deliberately NOT covered:
 *  - an argv TUPLE (`['ffmpeg', '-i', url]`): the same shape is how this repo
 *    spells enum lists (`['native', 'ffmpeg']` parser options), so a rule for
 *    it would be all false positives;
 *  - a ternary that is neither a spawn argument nor a path/binary binding
 *    (`label = x ? 'native' : 'ffmpeg'`): that is a label, not a binary.
 *
 * Exceptions live in {@link EXCEPTIONS}, each with its reason. An exception is
 * a site that NAMES the binary without running it from PATH — never a spawn.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

const SOURCE_RE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/
const NON_RUNTIME_RE = /\.(?:spec|test|d)\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/

export type BareFfmpegRule =
  | 'bare-spawn'
  | 'path-default'
  | 'ternary-default'
  | 'bare-binding'
  | 'absolute-host-path'
  | 'unpinned-package'

export interface BareFfmpegFinding {
  readonly rule: BareFfmpegRule
  readonly line: number
  readonly text: string
}

interface RuleDefinition {
  readonly rule: BareFfmpegRule
  readonly pattern: RegExp
  readonly why: string
}

const BINARY = String.raw`ff(?:mpeg|probe)`

const RULES: readonly RuleDefinition[] = [
  {
    rule: 'bare-spawn',
    // ANY callee whose name carries spawn/exec — `spawnFn`, `spawnMux`,
    // `execSync`, `execFileAsync` are this repo's own injection names — plus
    // the two PATH lookups by name. The binary name ends at the quote OR at
    // whitespace, so a command LINE (`exec('ffmpeg -version')`, a template
    // `\`ffprobe -v error ${url}\``) is caught too.
    pattern: new RegExp(
      String.raw`\b(?:\w*(?:spawn|Spawn|exec|Exec)\w*|findInPath|which)\s*\(\s*(['"\x60])${BINARY}(?:\1|\s)`,
      'g',
    ),
    why: 'spawns the binary BY NAME — that is a PATH lookup',
  },
  {
    rule: 'path-default',
    pattern: new RegExp(String.raw`(?:\?\?|\|\|)\s*(['"\x60])${BINARY}\1`, 'g'),
    why: 'defaults a missing path to the bare name — a silent PATH fallback',
  },
  {
    rule: 'ternary-default',
    // `spawn(p ? p : 'ffmpeg', …)` — a ternary AS the binary argument.
    // A real `?` (not `?.` / `??`), and the ELSE inside the same argument.
    pattern: new RegExp(
      String.raw`\b\w*(?:spawn|Spawn|exec|Exec)\w*\s*\(\s*[^,;()\n]*(?<!\?)\?(?![.?])[^,;:?()\n]*:\s*(['"\x60])${BINARY}\1`,
      'g',
    ),
    why: 'a ternary spawn argument whose ELSE is the bare name — a silent PATH fallback',
  },
  {
    rule: 'ternary-default',
    // `const bin = p !== undefined ? p : 'ffmpeg'` — a PATH/BINARY binding (by
    // the same names as the bare-binding rule) whose ternary falls back to the
    // bare name. A label (`engine: x ? 'native' : 'ffmpeg'`) is not a path.
    pattern: new RegExp(
      String.raw`\b(?:\w+(?:path|bin|binary|cmd|command|executable|exe)|\w*ff(?:mpeg|probe)\w*|bin|binary|cmd|command|executable|exe)['"]?\s*(?::\s*[\w|\s]+?)?(?<![=!<>])[:=](?!=)\s*[^;\n]*?(?<!\?)\?(?![.?])[^;:?\n]*:\s*(['"\x60])${BINARY}\1`,
      'gi',
    ),
    why: 'a path binding whose ternary ELSE is the bare name — a silent PATH fallback',
  },
  {
    rule: 'bare-binding',
    pattern: new RegExp(
      // `path` alone is excluded on purpose: `{ path: 'ffmpeg' }` is how the
      // demux tally NAMES which demuxer served a fragment, not a binary.
      String.raw`\b(?:\w+(?:path|bin|binary|cmd|command|executable|exe)|bin|binary|cmd|command|executable|exe)['"]?\s*(?::\s*string\s*)?[:=]\s*(['"\x60])${BINARY}\1`,
      'gi',
    ),
    why: 'a binary/path binding holding the bare name — the value a failed resolution falls back to',
  },
  {
    rule: 'bare-binding',
    // `const FFMPEG = 'ffmpeg'`: an identifier NAMED for the binary, assigned
    // the bare name (never a comparison: `=` alone, not `==`/`===`/`!=`).
    pattern: new RegExp(
      String.raw`\b\w*ff(?:mpeg|probe)\w*\s*(?::\s*string\s*)?(?<![=!<>])=(?!=)\s*(['"\x60])${BINARY}\1`,
      'gi',
    ),
    why: 'a binding named for the binary holding the bare name',
  },
  {
    rule: 'absolute-host-path',
    // The host's own binary by absolute path is PATH by another name.
    pattern: new RegExp(
      String.raw`(['"\x60])/(?:usr/(?:local/)?|opt/[\w.-]+/)?bin/${BINARY}\1`,
      'g',
    ),
    why: "the HOST's binary by absolute path — never the pinned build",
  },
  {
    rule: 'unpinned-package',
    pattern:
      /(?:from\s+|require\(\s*|import\(\s*)(['"])(?:fluent-ffmpeg|ffmpeg-static|ffprobe-static|@ffmpeg-installer\/[^'"]+|@ffprobe-installer\/[^'"]+)\1/g,
    why: 'an ffmpeg wrapper/binary package — its default is PATH or a build we did not pin',
  },
]

/**
 * Sites that NAME the binary without running it from PATH. Keyed by file and
 * rule; the reason is the review. Adding a SPAWN here is the thing this guard
 * exists to stop — resolve the pinned build instead.
 */
const EXCEPTIONS: ReadonlyArray<readonly [string, BareFfmpegRule, string]> = [
  [
    'packages/types/src/deps/ffmpeg-downloader.ts',
    'bare-binding',
    '`archiveInnerPath: "ffmpeg"` names the file INSIDE the pinned, checksummed archive — this is the provisioning itself, not a spawn',
  ],
]

function isException(file: string, rule: BareFfmpegRule): boolean {
  return EXCEPTIONS.some(([f, r]) => f === file && r === rule)
}

/**
 * Blank every comment while keeping line numbers and string literals intact,
 * so a doc comment that QUOTES the old pattern (`'ffmpeg'` on PATH) is not a
 * violation and a string containing `//` is not cut short.
 */
export function stripComments(source: string): string {
  let out = ''
  let i = 0
  let quote: string | null = null
  while (i < source.length) {
    const ch = source[i] ?? ''
    const next = source[i + 1] ?? ''
    if (quote !== null) {
      out += ch
      if (ch === '\\') {
        out += next
        i += 2
        continue
      }
      if (ch === quote || (ch === '\n' && quote !== '`')) quote = null
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n'
        i += 1
      }
      i += 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    out += ch
    i += 1
  }
  return out
}

/** Every bare-binary finding in one source file (comments ignored). */
export function findBareFfmpeg(source: string): readonly BareFfmpegFinding[] {
  const code = stripComments(source)
  const lines = source.split('\n')
  const findings: BareFfmpegFinding[] = []
  // One finding per rule per line: two patterns of one rule may name the
  // same line (`ffmpegBinaryPath = 'ffmpeg'` is both a path and a name).
  const seen = new Set<string>()
  for (const { rule, pattern } of RULES) {
    for (const match of code.matchAll(pattern)) {
      const line = code.slice(0, match.index ?? 0).split('\n').length
      const key = `${rule}:${line}`
      if (seen.has(key)) continue
      seen.add(key)
      findings.push({ rule, line, text: (lines[line - 1] ?? '').trim() })
    }
  }
  return findings.sort((a, b) => a.line - b.line)
}

function walk(dir: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue
    const full = path.join(dir, entry)
    let isDir: boolean
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (isDir) walk(full, out)
    else if (SOURCE_RE.test(entry) && !NON_RUNTIME_RE.test(entry)) out.push(full)
  }
}

function runtimeSourceRoots(): readonly string[] {
  const packagesDir = path.join(ROOT, 'packages')
  const roots = readdirSync(packagesDir)
    .map((pkg) => path.join(packagesDir, pkg, 'src'))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory()
      } catch {
        return false
      }
    })
  return [...roots, path.join(ROOT, 'server/backend/src')]
}

interface Violation extends BareFfmpegFinding {
  readonly file: string
}

function main(): void {
  const files: string[] = []
  for (const root of runtimeSourceRoots()) walk(root, files)

  const violations: Violation[] = []
  for (const full of files) {
    const file = path.relative(ROOT, full)
    for (const finding of findBareFfmpeg(readFileSync(full, 'utf8'))) {
      if (!isException(file, finding.rule)) violations.push({ ...finding, file })
    }
  }

  if (violations.length === 0) {
    console.log(`check-no-bare-ffmpeg: OK (${files.length} runtime files)`)
    return
  }
  console.error('\n\x1b[31m✘ a runtime site reaches ffmpeg/ffprobe through PATH (D540):\x1b[0m')
  console.error(
    "  Use the node's pinned build — `memoizePinnedFfmpeg(() => ctx.deps.ensureFfmpeg())`\n" +
      '  from @camstack/types, or a REQUIRED path the addon resolved — and refuse with a\n' +
      '  logged reason (tags: { deviceId }) when it cannot be had. See docs/architecture/ffmpeg.md.\n',
  )
  for (const v of violations) {
    const why = RULES.find((r) => r.rule === v.rule)?.why ?? v.rule
    console.error(`    ${v.file}:${v.line}  [${v.rule}] ${why}`)
    console.error(`      \x1b[2m${v.text}\x1b[0m`)
  }
  console.error('')
  process.exit(1)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
