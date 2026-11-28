#!/usr/bin/env tsx
/**
 * dominevo — the CamStack → Dominevo rename, layer 1 (planning#757).
 *
 *   npx tsx scripts/rename/dominevo.ts [--dry-run]
 *
 * Deterministic and idempotent: it walks `git ls-files`, applies an ordered
 * rule list to every text file and prints how many replacements each rule made.
 * Re-running it on a tree it already rewrote changes nothing, so it is safe to
 * re-run on a fresh `main` right before landing.
 *
 * Layer 1 renames what a person or the package manager sees: the npm scope, the
 * package versions (reset to 0.1.0), the CLI, the image and GitHub org, and the
 * product name in prose and UI text.
 *
 * Layer 2 is everything persisted or on the wire between running nodes
 * (`CAMSTACK_*` env vars, data dirs, SQLite names, keychain owners, event
 * topics, Moleculer names, cert subjects, headers, URL prefixes …). This script
 * leaves it alone on purpose and PROTECTS the few exact tokens that a layer-1
 * rule would otherwise reach. The inventory is `scripts/rename/LAYER2.md`;
 * the tail of every run prints how much of each layer-2 identifier is left.
 *
 * Never touched: CHANGELOG history, package-lock.json (regenerate it with
 * `npm install --package-lock-only --ignore-scripts`), the bundled viewer
 * assets (regenerated from the viewer), and this directory.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DRY_RUN = process.argv.includes('--dry-run')
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

/** The version every workspace package starts again from. */
const RESET_VERSION = '0.1.0'

interface TextRule {
  readonly id: string
  readonly pattern: RegExp
  readonly replace: string | ((substring: string, ...groups: string[]) => string)
}

/** Paths the codemod never rewrites. */
const EXCLUDED: readonly RegExp[] = [
  /(^|\/)CHANGELOG[^/]*$/,
  /(^|\/)package-lock\.json$/,
  /^packages\/addon-pipeline-orchestrator\/assets\/viewer\//,
  /^scripts\/rename\//,
  /^\.git\//,
]

/**
 * Exact tokens a layer-1 rule would reach but that are layer 2 (wire or
 * persisted). They are parked behind a placeholder while the rules run.
 */
const PROTECTED: readonly RegExp[] = [
  /X-CamStack-[A-Za-z-]*/g, //                       HTTP headers between the Alexa Lambda and the hub
  /CamStack (?:Local|Mesh|Device) CA/g, //           certificate subject CNs
  /\/O=CamStack/g, //                                 certificate subject organisation
  /oss_CamStack_Binding/g, //                         identifier registered on the Alexa side
  /(?<=[/\\])CamStack(?=[/\\])/g, //                 a data-directory path segment (`/Users/me/CamStack/data`)
]

/** CLI subcommands: `camstack <word>` is the command line only for these. */
const CLI_WORDS =
  'deploy-server|deploy|login|logout|whoami|mcp|develop|host-check|agent|discover|cluster-update|serve|setup|dev|watch|update|push|help|--help|--version|-v|-h'

const TEXT_RULES: readonly TextRule[] = [
  // ── the npm scope ────────────────────────────────────────────────────────
  {
    id: 'scope: @camstack → @dominevo',
    pattern: /@camstack(?![A-Za-z0-9_]|\.(?:local|dev|example|zentik)\b)/g,
    replace: '@dominevo',
  },
  // ── the image and the GitHub org ─────────────────────────────────────────
  {
    id: 'image: ghcr.io/camstack/camstack → ghcr.io/dominevo/dominevo',
    pattern: /ghcr\.io\/camstack\/camstack(?![A-Za-z0-9_-])/g,
    replace: 'ghcr.io/dominevo/dominevo',
  },
  {
    id: 'image: ghcr.io/camstack/ → ghcr.io/dominevo/',
    pattern: /ghcr\.io\/camstack\//g,
    replace: 'ghcr.io/dominevo/',
  },
  {
    id: 'org: github.com/camstack/ → github.com/dominevo/',
    pattern: /(github\.com|api\.github\.com\/repos|raw\.githubusercontent\.com)([/:])camstack\//g,
    replace: '$1$2dominevo/',
  },
  {
    id: 'org: gh repo slug camstack/<repo> → dominevo/<repo>',
    pattern:
      /((?:-R|--repo|repo:|repository:)[ =]*["']?)camstack\/(server|addon-x|addon-examples|docs|viewer|unraid-templates|proxmox|camstack-server)(?![A-Za-z0-9_-])/g,
    replace: '$1dominevo/$2',
  },
  {
    id: 'org: quoted slug camstack/<repo> → dominevo/<repo>',
    pattern:
      /(?<=["'`])camstack\/(server|addon-x|addon-examples|docs|viewer|unraid-templates|proxmox|camstack-server)(?=["'`])/g,
    replace: 'dominevo/$1',
  },
  // ── the CLI ──────────────────────────────────────────────────────────────
  {
    id: 'cli: `camstack <command>` → `dominevo <command>`',
    pattern: new RegExp(
      `(?<![A-Za-z0-9_@.~$-]|[A-Za-z0-9_.-]/)camstack (?=(?:${CLI_WORDS})(?![A-Za-z0-9_-]))`,
      'g',
    ),
    replace: 'dominevo ',
  },
  {
    id: 'cli: npx / npm i -g camstack → dominevo',
    pattern:
      /\b(npx(?: -y| --yes)? |npm (?:i|install)(?: -g| --global) |npm (?:view|info) )camstack(?![A-Za-z0-9_@/.-])/g,
    replace: '$1dominevo',
  },
  // ── the product name ─────────────────────────────────────────────────────
  {
    id: 'product: CamStack → Dominevo',
    pattern: /(?<![A-Za-z0-9_])CamStack(?![A-Za-z0-9_])/g,
    replace: 'Dominevo',
  },
]

/** A line a package.json rule rewrites, keyed by the rule that made the change. */
interface JsonEdit {
  readonly id: string
  readonly count: number
}

const counts = new Map<string, number>()
const filesTouched = new Map<string, Set<string>>()

function bump(rule: string, file: string, n: number): void {
  if (n === 0) return
  counts.set(rule, (counts.get(rule) ?? 0) + n)
  const set = filesTouched.get(rule) ?? new Set<string>()
  set.add(file)
  filesTouched.set(rule, set)
}

function isExcluded(file: string): boolean {
  return EXCLUDED.some((re) => re.test(file))
}

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  return out.split('\0').filter((f) => f.length > 0)
}

/** Tracked files read as binary (a NUL byte in the first 8 KB) and so never rewritten. */
const skippedBinary: string[] = []
/** A source or text extension: a NUL byte in one of these is a stray byte, not an image. */
const TEXT_EXTENSION = /\.(?:[cm]?[jt]sx?|json|md|mdx|ya?ml|html?|css|sh|toml|txt|py|svg)$/u

/** A text file: a regular file with no NUL byte in its first 8 KB. */
function readText(file: string): string | undefined {
  const abs = path.join(ROOT, file)
  if (!existsSync(abs)) return undefined
  const stat = lstatSync(abs)
  if (!stat.isFile()) return undefined
  const buf = readFileSync(abs)
  if (buf.subarray(0, 8192).includes(0)) {
    skippedBinary.push(file)
    return undefined
  }
  return buf.toString('utf8')
}

function applyTextRules(file: string, input: string): string {
  const parked: string[] = []
  let text = input
  for (const guard of PROTECTED) {
    text = text.replace(guard, (m) => {
      parked.push(m)
      return `\uE000L2-${parked.length - 1}\uE000`
    })
  }
  for (const rule of TEXT_RULES) {
    let n = 0
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      n += 1
      const match = String(args[0])
      const groups = args.slice(1).filter((a): a is string => typeof a === 'string')
      if (typeof rule.replace === 'function') return rule.replace(match, ...groups)
      return rule.replace.replace(/\$(\d)/g, (_s, d: string) => groups[Number(d) - 1] ?? '')
    })
    bump(rule.id, file, n)
  }
  return text.replace(/\uE000L2-(\d+)\uE000/g, (_m, i: string) => parked[Number(i)] ?? '')
}

// ── package.json: versions, internal ranges, floors, the CLI package ───────

const WORKSPACE_DEP_BLOCKS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]

/** The index just past the `}` that closes the `{` at `open`. */
function closingBrace(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '"') {
      i += 1
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
    } else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return text.length
}

function isWorkspacePackageJson(file: string): boolean {
  return (
    file === 'package.json' ||
    /^packages\/[^/]+\/package\.json$/.test(file) ||
    /^server\/[^/]+\/package\.json$/.test(file) ||
    file === 'e2e/package.json'
  )
}

function rewritePackageJson(file: string, input: string): string {
  let text = input

  // The root `version`: the first top-level one.
  text = text.replace(/^(  "version": ")[^"]*(")/m, (m, a: string, b: string) => {
    const next = `${a}${RESET_VERSION}${b}`
    if (next !== m) bump('version: workspace package → 0.1.0', file, 1)
    return next
  })

  // Internal dependency ranges (and peer floors).
  for (const block of WORKSPACE_DEP_BLOCKS) {
    const start = text.search(new RegExp(`^  "${block}": \\{`, 'm'))
    if (start < 0) continue
    const open = text.indexOf('{', start)
    const end = closingBrace(text, open)
    const body = text.slice(open, end)
    const next = body.replace(
      /("@(?:camstack|dominevo)\/[A-Za-z0-9._/-]+": ")([^"]*)(")/g,
      (m, a: string, range: string, b: string) => {
        const floor = range.startsWith('>=') ? `>=${RESET_VERSION}` : RESET_VERSION
        if (floor === range) return m
        bump('range: internal dependency → 0.1.0', file, 1)
        return `${a}${floor}${b}`
      },
    )
    text = text.slice(0, open) + next + text.slice(end)
  }

  // `requires` stamps: every `>=x.y.z` floor inside a requires block.
  let from = 0
  for (;;) {
    const at = text.indexOf('"requires": {', from)
    if (at < 0) break
    const open = text.indexOf('{', at)
    const end = closingBrace(text, open)
    const body = text.slice(open, end)
    const next = body.replace(/">=\d+\.\d+\.\d+[^"]*"/g, (m) => {
      const reset = `">=${RESET_VERSION}"`
      if (m === reset) return m
      bump('requires: >=floor → >=0.1.0', file, 1)
      return reset
    })
    text = text.slice(0, open) + next + text.slice(end)
    from = open + next.length
  }

  // The unscoped CLI package and the root workspace name.
  if (file === 'packages/cli/package.json' || file === 'package.json') {
    text = text.replace(/^(  "name": ")camstack(")/m, (_m, a: string, b: string) => {
      bump('cli: package name camstack → dominevo', file, 1)
      return `${a}dominevo${b}`
    })
    text = text.replace(/("bin": \{\s*)"camstack"(:)/, (_m, a: string, b: string) => {
      bump('cli: bin camstack → dominevo', file, 1)
      return `${a}"dominevo"${b}`
    })
  }
  return text
}

function rewriteSidecarJson(file: string, input: string): string {
  if (file === 'product-version.json') {
    return input.replace(/("version": ")[^"]*(")/, (m, a: string, b: string) => {
      const next = `${a}${RESET_VERSION}${b}`
      if (next !== m) bump('version: product-version.json → 0.1.0', file, 1)
      return next
    })
  }
  if (file === 'scripts/ci/wrapper-minimums.json') {
    return input.replace(/">=\d+\.\d+\.\d+"/g, (m) => {
      const reset = `">=${RESET_VERSION}"`
      if (m !== reset) bump('requires: >=floor → >=0.1.0', file, 1)
      return reset
    })
  }
  return input
}

// ── layer 2: what is left, counted ─────────────────────────────────────────

const LAYER2_PROBES: ReadonlyArray<readonly [string, RegExp]> = [
  ['CAMSTACK_* env vars', /CAMSTACK_[A-Z0-9_]+/g],
  ['camstack.evt.* event topics', /camstack\.evt\./g],
  ['camstack.db / .crt / .key files', /camstack\.(?:db|crt|key)\b/g],
  ['~/.camstack, .camstack paths', /\.camstack(?![A-Za-z0-9_-])/g],
  ['package.json `camstack` manifest key', /\bpkg\.camstack\b|"camstack": \{/g],
  ['camstack:// URL scheme', /camstack(?:\.dev)?:\/\//g],
  ['/viewer/camstack/ URL prefix', /\/viewer\/camstack\b/g],
  ['_camstack._tcp mDNS type', /_camstack\._tcp/g],
  ['camstack_* cookie / storage keys', /\bcamstack_[a-z_]+/g],
  ['x-camstack-* headers', /x-camstack-[a-z-]+/gi],
  ['camstack-zentik.app / camstack.zentik.app domains', /camstack(?:-docs)?\.zentik\.app/g],
  ['huggingface camstack org', /huggingface\.co\/camstack|hf\/camstack|camstack\/camstack-models/g],
]

function main(): void {
  const files = trackedFiles().filter((f) => !isExcluded(f))
  let changed = 0
  const remaining = new Map<string, number>()

  for (const file of files) {
    const original = readText(file)
    if (original === undefined) continue
    let next = original
    if (file.endsWith('package.json') && isWorkspacePackageJson(file)) {
      next = rewritePackageJson(file, next)
    }
    next = rewriteSidecarJson(file, next)
    next = applyTextRules(file, next)
    if (next !== original) {
      changed += 1
      if (!DRY_RUN) writeFileSync(path.join(ROOT, file), next)
    }
    for (const [label, re] of LAYER2_PROBES) {
      const hits = next.match(re)?.length ?? 0
      if (hits > 0) remaining.set(label, (remaining.get(label) ?? 0) + hits)
    }
  }

  const mode = DRY_RUN ? 'dry run — nothing written' : 'written'
  console.log(`dominevo codemod (${mode}): ${changed} of ${files.length} files change`)
  console.log('\nrule counts (replacements / files):')
  for (const [rule, n] of [...counts.entries()].toSorted((a, b) => b[1] - a[1])) {
    console.log(
      `  ${String(n).padStart(6)} / ${String(filesTouched.get(rule)?.size ?? 0).padStart(5)}  ${rule}`,
    )
  }
  const suspect = skippedBinary.filter((f) => TEXT_EXTENSION.test(f))
  console.log(
    `\nskipped as binary: ${skippedBinary.length} tracked files (${suspect.length} with a text extension)`,
  )
  for (const f of suspect) console.log(`  SKIPPED TEXT FILE (stray NUL byte?): ${f}`)
  console.log('\nlayer 2 left in place (see scripts/rename/LAYER2.md):')
  for (const [label, n] of [...remaining.entries()].toSorted((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(6)}  ${label}`)
  }
}

main()
if (skippedBinary.some((f) => TEXT_EXTENSION.test(f))) {
  console.error('refusing: a tracked text file was skipped as binary, fix its NUL byte first')
  process.exitCode = 1
}
