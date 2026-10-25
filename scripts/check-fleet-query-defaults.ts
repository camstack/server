#!/usr/bin/env tsx
/**
 * Fleet-query-defaults guard — enforcement for D274.
 *
 * ── The bug class this prevents ────────────────────────────────────────────
 * `staleTime` is a per-OBSERVER setting in React Query. `deviceManager.listAll`
 * has ~27 observers across the admin UI and ui-library, and ONE of them leaving
 * the window at the app-wide default of `0` re-fetches the whole fleet — 1017
 * devices on the reference hub — every time it mounts, no matter what its
 * siblings passed.
 *
 * This was already fixed once, by hand, at 21 call sites. The hand fix had
 * drifted before it shipped: every ui-library composite was missed, and those
 * are the ones requesting the UNPROJECTED fleet. 21 edits are 21 chances to
 * forget, and forgetting is silent — the UI still works, it just asks again.
 *
 * D274 moved the window to `applyFleetQueryDefaults`, one registration on the
 * query client, matched by key PREFIX so it covers every `input` variant and
 * every future call site. That closes the "forgot at the call site" hole
 * structurally. This guard closes the two holes it does NOT close:
 *
 *  1. **A new `QueryClient` that never gets the defaults.** The registration
 *     lives on the client, so a surface that builds its own client silently
 *     opts out of it. There are three clients today (the admin shell, the
 *     embed player, the ui-library dev shell); client four must not be the
 *     one that reintroduces the storm.
 *  2. **A call site that re-declares the window locally.** `staleTime` at the
 *     call site WINS over the registration (it is last in
 *     `defaultQueryOptions`' merge). That override is a legitimate escape
 *     hatch, but as a copy-paste default it recreates the 21-owners problem
 *     the ADR exists to end — so it has to be a deliberate, reviewed act, not
 *     something that slips in with a pasted line.
 *
 * A call site that genuinely needs live data should say so with
 * `refetchInterval` (untouched by this guard, and used by two surfaces today),
 * or add itself to ALLOWED_WINDOW_OVERRIDES below with a reason.
 *
 *  3. **A call site that never touches the query client at all.** Both rules
 *     above look at OBSERVERS. An audit on 2026-08-30 found twelve fleet reads
 *     that are not observers: `system.trpcClient.deviceManager.listAll.query()`
 *     called inside a `useQuery` body under a PRIVATE key such as
 *     `['deviceManager','listAll','forRules']`. Such a read is invisible three
 *     times over:
 *
 *       - `setQueryDefaults` matches the tRPC key prefix
 *         `[['deviceManager','listAll']]`. A single-nested key does NOT match
 *         it (element 0 is the string `'deviceManager'`, not the array
 *         `['deviceManager','listAll']`), so the registered window never
 *         applied and the read went out at the app-wide `staleTime: 0`.
 *       - The ~20 mutation handlers that invalidate `[['deviceManager']]` miss
 *         it for the same reason, so renaming a camera never refreshed the
 *         picker. This is the exact single-vs-double nesting bug D274 already
 *         found once, in `useUpdateDeviceConfig`.
 *       - It fetches its own copy of a fleet the rest of the app holds warm.
 *         Six of the twelve asked for the FULL projection: 1 019 rows with
 *         every device's `config` blob, 5.6 s on the reference hub against
 *         2.9 s slim and 0.18 s for `/health`.
 *
 *     The UI reads the fleet through `useDeviceManagerListAll`. A raw call in a
 *     UI tree needs a reason in ALLOWED_RAW_FLEET_READS, and even then it must
 *     name a `projection` — see the next rule for why that is not pedantry.
 *
 *  4. **An input key the schema does not have.** `deviceManager.listAll` takes
 *     `{ addonId?, projection?, isCamera?, deviceIds? }` and Zod STRIPS unknown
 *     keys rather than rejecting them. `RunTargetPicker.tsx:95` passed
 *     `{ slim: true }` under a comment explaining that slim "skips the
 *     per-device settings read"; the key was silently dropped and the call was
 *     the FULL projection, every mount, for as long as the comment has existed.
 *     A misspelt narrowing is a widening that reads as a narrowing.
 *
 * SCOPE: UI trees only. An ADDON reaching the fleet through `ctx.api` has no
 * query client to ride and is a different question (`fleet-read-census.ts`).
 *
 * Usage: tsx scripts/check-fleet-query-defaults.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/** UI trees that can construct a query client, observe the fleet list, or ask
 *  for it raw. `addon-benchmark` is here because it is a UI that does BOTH of
 *  the things this guard cares about and NEITHER of the things that would have
 *  made it visible before: it ships no `QueryClient`, so rule 1 never saw it,
 *  and it calls no hook, so rule 2 never saw it. */
const SCANNED_DIRS: readonly string[] = [
  'packages/addon-admin-ui/src',
  'packages/addon-benchmark/src',
  'packages/ui-library/src',
]

/** The single owner of the window. If this moves, this guard is pointing at air. */
const HELPER_FILE = 'packages/ui-library/src/lib/fleet-query-defaults.ts'

/** The hook whose window D274 centralised. */
const FLEET_HOOK = 'useDeviceManagerListAll'

/**
 * Call sites permitted to re-declare the window, with the reason. Empty by
 * design: no surface has yet needed a window other than the registered one,
 * and the two that need livelier data use `refetchInterval` instead.
 */
const ALLOWED_WINDOW_OVERRIDES: ReadonlyMap<string, string> = new Map()

/**
 * Files permitted to read the fleet through the RAW tRPC client, with the
 * reason. The bar is "this surface has no query client to ride" — not "this
 * one is small" and not "this one only asks once".
 *
 * An allowlisted file still has to name a `projection`: the window is what it
 * opts out of, not the payload.
 */
const ALLOWED_RAW_FLEET_READS: ReadonlyMap<string, string> = new Map([
  [
    'packages/addon-benchmark/src/components/RunTargetPicker.tsx',
    'benchmark is a federated remote with no QueryClient and no React Query at all',
  ],
  [
    'packages/addon-benchmark/src/tabs/PipelineTab.tsx',
    'benchmark is a federated remote with no QueryClient and no React Query at all',
  ],
])

/** The complete `deviceManager.listAll` input schema. Zod strips anything else. */
const FLEET_INPUT_KEYS: ReadonlySet<string> = new Set([
  'addonId',
  'projection',
  'isCamera',
  'deviceIds',
])

/** A raw fleet read, whatever the client reference is called. */
const RAW_FLEET_READ = /\bdeviceManager\s*\.\s*listAll\s*\.\s*query\s*\(/g

interface Violation {
  readonly file: string
  readonly line: number
  readonly text: string
  readonly rule: string
  readonly fix: string
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
    if (!/\.tsx?$/.test(entry.name)) continue
    if (entry.name.endsWith('.d.ts')) continue
    out.push(rel)
  }
}

/**
 * Blank out comment bodies so the prose that documents this bug — which this
 * repo writes at length, including in the helper itself — is not a violation.
 * Newlines are preserved so reported line numbers stay true.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '')
}

/** `new QueryClient(` — the construction this guard wants paired with the helper. */
const QUERY_CLIENT_CTOR = /\bnew\s+QueryClient\s*\(/

/** A caching window declared inside a call's own argument list. */
const WINDOW_OPTION = /\b(?:staleTime|gcTime)\s*:/

/**
 * The argument text of the call whose opening paren is at `open`, found by
 * balancing parentheses. Scoping to the ACTUAL call matters: a file-wide regex
 * happily pairs this hook with a `staleTime` belonging to a different hook
 * further down, which is how the first draft of this guard reported three
 * violations that were all somebody else's option object.
 */
function extractCallArgs(source: string, open: number): string {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const char = source[i]
    if (char === '(') depth++
    else if (char === ')') {
      depth--
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  return ''
}

/**
 * The FIRST argument of a call, given its full argument text. Split on the
 * top-level comma only: the input object of a fleet read routinely contains
 * commas of its own, and the hook takes React Query options as a second
 * argument that must not be mistaken for input keys.
 */
function firstArgument(args: string): string {
  let depth = 0
  for (let i = 0; i < args.length; i++) {
    const char = args[i]
    if (char === '(' || char === '[' || char === '{') depth++
    else if (char === ')' || char === ']' || char === '}') depth--
    else if (char === ',' && depth === 0) return args.slice(0, i)
  }
  return args
}

/**
 * Object-literal keys declared at the TOP level of `text`. Nested objects
 * (a `where`, a `filter`) are somebody else's vocabulary and are skipped.
 */
function topLevelKeys(text: string): readonly string[] {
  const body = text.trim().replace(/^\{/, '').replace(/\}$/, '')
  const keys: string[] = []
  let depth = 0
  let segmentStart = 0
  const segments: string[] = []
  for (let i = 0; i < body.length; i++) {
    const char = body[i]
    if (char === '(' || char === '[' || char === '{') depth++
    else if (char === ')' || char === ']' || char === '}') depth--
    else if (char === ',' && depth === 0) {
      segments.push(body.slice(segmentStart, i))
      segmentStart = i + 1
    }
  }
  segments.push(body.slice(segmentStart))
  for (const segment of segments) {
    const match = /^\s*(?:'([A-Za-z_$][\w$]*)'|"([A-Za-z_$][\w$]*)"|([A-Za-z_$][\w$]*))\s*:/.exec(
      segment,
    )
    const key = match?.[1] ?? match?.[2] ?? match?.[3]
    if (key !== undefined) keys.push(key)
  }
  return keys
}

/** 1-based line number of `offset` in `source`. */
function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length
}

/**
 * Every top-level key of a fleet read's INPUT must exist in the schema. Zod
 * strips the rest, so a misspelt narrowing widens the query in silence.
 */
function checkInputKeys(
  violations: Violation[],
  file: string,
  lines: readonly string[],
  source: string,
  open: number,
  args: string,
): void {
  const input = firstArgument(args)
  if (!input.includes('{')) return
  for (const key of topLevelKeys(input)) {
    if (FLEET_INPUT_KEYS.has(key)) continue
    const line = lineOf(source, open + 1 + Math.max(0, args.indexOf(key)))
    violations.push({
      file,
      line,
      text: lines[line - 1]?.trim() ?? '',
      rule: 'unknown-fleet-input-key',
      fix:
        `\`${key}\` is not in the listAll input schema — Zod STRIPS it, so this call ` +
        `is whatever it would be without it. Valid: ${[...FLEET_INPUT_KEYS].join(', ')}`,
    })
  }
}

function main(): void {
  if (!fs.existsSync(path.join(ROOT, HELPER_FILE))) {
    console.error(`✗ fleet-query-defaults guard: the helper is gone (${HELPER_FILE}).`)
    console.error('  The window has no owner — restore it or retire this guard and D274.')
    process.exit(1)
  }

  const files: string[] = []
  for (const dir of SCANNED_DIRS) listSourceFiles(dir, files)

  const violations: Violation[] = []
  let clientCount = 0
  let callSiteCount = 0
  let rawReadCount = 0

  for (const file of files) {
    if (file.includes('__tests__') || /\.(?:spec|test)\.tsx?$/.test(file)) continue
    if (file === HELPER_FILE) continue

    const source = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'))
    const lines = source.split('\n')
    const appliesDefaults = source.includes('applyFleetQueryDefaults')

    lines.forEach((text, index) => {
      if (QUERY_CLIENT_CTOR.test(text)) {
        clientCount++
        if (!appliesDefaults) {
          violations.push({
            file,
            line: index + 1,
            text: text.trim(),
            rule: 'client-without-defaults',
            fix: "call applyFleetQueryDefaults(client) on it — import from '@camstack/ui-library'",
          })
        }
      }
    })

    const hookCall = new RegExp(`\\b${FLEET_HOOK}\\s*\\(`, 'g')
    for (let hit = hookCall.exec(source); hit !== null; hit = hookCall.exec(source)) {
      callSiteCount++
      const open = source.indexOf('(', hit.index)
      const args = extractCallArgs(source, open)
      checkInputKeys(violations, file, lines, source, open, args)
      if (!WINDOW_OPTION.test(args)) continue
      if (ALLOWED_WINDOW_OVERRIDES.has(file)) continue
      const line = lineOf(source, open + 1 + args.search(WINDOW_OPTION))
      violations.push({
        file,
        line,
        text: lines[line - 1]?.trim() ?? '',
        rule: 'window-redeclared-at-call-site',
        fix: `drop it — the window is registered once in ${HELPER_FILE}`,
      })
    }

    RAW_FLEET_READ.lastIndex = 0
    for (let hit = RAW_FLEET_READ.exec(source); hit !== null; hit = RAW_FLEET_READ.exec(source)) {
      rawReadCount++
      const open = source.indexOf('(', hit.index + hit[0].length - 1)
      const args = extractCallArgs(source, open)
      const line = lineOf(source, hit.index)
      const reason = ALLOWED_RAW_FLEET_READS.get(file)
      if (reason === undefined) {
        violations.push({
          file,
          line,
          text: lines[line - 1]?.trim() ?? '',
          rule: 'raw-client-fleet-read',
          fix:
            `read it with ${FLEET_HOOK}(...) — a raw call rides no registered window, ` +
            "shares no cache entry, and is missed by every `[['deviceManager']]` invalidation",
        })
      } else if (!/\bprojection\s*:/.test(firstArgument(args))) {
        violations.push({
          file,
          line,
          text: lines[line - 1]?.trim() ?? '',
          rule: 'raw-fleet-read-without-projection',
          fix:
            `allowlisted (${reason}) — but it must still say \`projection: 'slim'\` unless it ` +
            'genuinely reads `config` / `metadata` / `sourceInfo`',
        })
      }
      checkInputKeys(violations, file, lines, source, open, args)
    }
  }

  if (violations.length === 0) {
    console.log(
      `✓ fleet-query-defaults guard: ${clientCount} query clients all apply the defaults, ` +
        `${callSiteCount} ${FLEET_HOOK} call sites declare no window of their own, ` +
        `${rawReadCount} raw fleet reads are allowlisted and projected`,
    )
    return
  }

  console.error('✗ fleet-query-defaults guard: the fleet-list window has more than one owner\n')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule}]`)
    console.error(`      ${v.text}`)
    console.error(`      → ${v.fix}\n`)
  }
  console.error(
    'staleTime is per-OBSERVER: one observer at the default of 0 refetches the\n' +
      'whole fleet on mount regardless of what the others set. See\n' +
      'docs/decisions/adr-0274-the-fleet-list-window-is-owned-by-the-query-client.md.',
  )
  process.exit(1)
}

main()
