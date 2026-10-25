#!/usr/bin/env tsx
/**
 * Single-copy layout guard — enforcement step 3 of
 * D45 (docs/decisions/adr-0045).
 *
 * ── The bug class this prevents ────────────────────────────────────────────
 * D45: a host-provided package (`@camstack/system`, `@camstack/types`,
 * `@camstack/sdk`) exists exactly ONCE per node, inside the active server
 * closure, reached by ONE resolution path. It was written after an evening in
 * which one agent held four copies of `@camstack/system` — 1.2.28 under the
 * image seed, 1.2.28 under a second seed tree, 1.2.0 in the legacy
 * `/data/framework`, 1.2.30 in the closure. Three consecutive diagnoses of
 * which one actually ran were each disproved by the next measurement, while
 * every status surface reported the version of a copy nobody was running.
 *
 * Step 1 made a node log the path it RESOLVED. Step 2 made it count the copies
 * it HAS. Both describe a node at boot. Neither stops the repository from
 * growing a fifth copy or a fourth resolution path in the meantime — which is
 * what this does.
 *
 * ── Why a ratchet and not a red build ──────────────────────────────────────
 * The layout is non-compliant TODAY, by design: the image still builds seed
 * trees, `/data/framework` still exists, `CAMSTACK_FRAMEWORK_DIR` is still
 * read. D45 records their removal as a deliberate, scheduled migration with a
 * container recreate as the escape hatch — not something a guard should force
 * by turning CI red on the first commit. So this pins what exists today, per
 * (file, marker), and fails only when a bucket gets WORSE or a NEW file grows a
 * marker.
 *
 * It is a RATCHET, not an amnesty: when a bucket improves the guard says so and
 * asks you to re-pin, so the numbers can only go down. The baseline file is
 * therefore also the cleanup list D45 scheduled — in one place, with counts.
 *
 * `--update` rewrites the baseline from the current tree; the diff it produces
 * is the evidence that the change was intentional.
 *
 * Usage:
 *   tsx scripts/check-single-copy-layout.ts
 *   tsx scripts/check-single-copy-layout.ts --update
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const BASELINE_FILE = path.join(ROOT, 'scripts', 'single-copy-baseline.json')

/**
 * The files that DECIDE the layout: what the image lays down, and what the
 * launcher resolves from. D45's `applies-to` list, plus the Dockerfile that
 * builds both node roles from one definition.
 */
const LAYOUT_FILES: readonly string[] = [
  'Dockerfile',
  'server/backend/src/launcher.ts',
  'server/backend/src/framework-nodepath.ts',
  'server/backend/src/bootstrap-packages.ts',
  'packages/system/src/kernel/addon-installer.ts',
  // The Electron bundle is the OTHER thing that lays a node's copies down, and
  // it had the same shape as the docker image: `extraResources` copied the whole
  // closure into `Resources/node_modules`, then re-copied six addons and
  // `@camstack/system` one by one into `Resources/addons/<name>` — 41 MB of
  // second copy, measured 2026-08-25. Pinned at 0 so it cannot come back.
  'packages/desktop/package.json',
]

interface Marker {
  readonly id: string
  readonly pattern: RegExp
  /** What a NEW occurrence would mean, in the reviewer's terms. */
  readonly meaning: string
}

/**
 * Each marker is a construct that creates a SECOND copy or a SECOND resolution
 * path. Matched textually on purpose: the guard has to hold for a Dockerfile
 * and for TypeScript with one mechanism, and a construct that only *looks*
 * like another seed tree is still worth a reviewer's attention.
 */
const MARKERS: readonly Marker[] = [
  {
    id: 'seed-framework-tree',
    pattern: /camstack-seed-framework/g,
    meaning: 'a framework tree copied outside the active closure (D45: no seed)',
  },
  {
    id: 'seed-addons-tree',
    pattern: /camstack-seed-addons/g,
    meaning: 'an addons tree copied outside the active closure (D45: no seed)',
  },
  {
    id: 'bundled-addons-seed-tree',
    pattern: /"to":\s*"addons\//g,
    meaning:
      'an electron-builder extraResources entry re-copying a package the bundled ' +
      'closure ALREADY carries into a second Resources/addons tree (D45: one copy)',
  },
  {
    id: 'framework-dir-override',
    pattern: /CAMSTACK_FRAMEWORK_DIR/g,
    meaning: 'a framework-dir override — a second resolution path (D45: one path)',
  },
  {
    id: 'legacy-framework-dir',
    pattern: /data\/framework/g,
    meaning: 'the legacy /data/framework tree D45 removes',
  },
  {
    id: 'node-path-manipulation',
    pattern: /NODE_PATH/g,
    meaning: 'NODE_PATH manipulation — every entry is another place a copy can win',
  },
]

type Counts = Record<string, number>

/**
 * Comments are not a resolution path.
 *
 * This ratchet counts raw regex hits, and on 2026-09-09 it went red on
 * `addon-installer.ts` 0 → 2 because someone DOCUMENTED, in two doc comments,
 * that production derives the closure dir from `CAMSTACK_FRAMEWORK_DIR` while
 * a spec injects it. Both lines describe behaviour that already existed; the
 * file gained no path. Failing there teaches the reader that the guard is
 * noise, and a guard people learn to scroll past is the one that gets
 * `disabled_manually` — which is exactly what happened to this repo's CI.
 *
 * So the count is taken over CODE: line and block comments are blanked
 * (replaced with spaces, so line numbers are unchanged). String literals are
 * NOT blanked — `process.env['CAMSTACK_FRAMEWORK_DIR']` is a real use of the
 * override and must keep counting — they are only tracked so a `//` inside a
 * URL is not read as the start of a comment. A marker that appears only in
 * prose is a marker that describes, and describing is not regressing.
 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template'
  let mode: Mode = 'code'
  while (i < source.length) {
    const c = source[i] ?? ''
    const next = source[i + 1] ?? ''
    if (mode === 'code') {
      if (c === '/' && next === '/') {
        mode = 'line'
        out += '  '
        i += 2
        continue
      }
      if (c === '/' && next === '*') {
        mode = 'block'
        out += '  '
        i += 2
        continue
      }
      if (c === "'") {
        mode = 'single'
        out += c
        i += 1
        continue
      }
      if (c === '"') {
        mode = 'double'
        out += c
        i += 1
        continue
      }
      if (c === '`') {
        mode = 'template'
        out += c
        i += 1
        continue
      }
      out += c
      i += 1
      continue
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code'
        out += c
        i += 1
        continue
      }
      out += ' '
      i += 1
      continue
    }
    if (mode === 'block') {
      if (c === '*' && next === '/') {
        mode = 'code'
        out += '  '
        i += 2
        continue
      }
      out += c === '\n' ? c : ' '
      i += 1
      continue
    }
    // Inside a string literal. Its CONTENT is code — `process.env['X']` is a
    // real use of X — so it is kept verbatim; the mode exists only so a `//`
    // inside a URL is not mistaken for the start of a comment.
    if (c === '\\') {
      out += source.slice(i, i + 2)
      i += 2
      continue
    }
    if (
      (mode === 'single' && c === "'") ||
      (mode === 'double' && c === '"') ||
      (mode === 'template' && c === '`')
    ) {
      mode = 'code'
      out += c
      i += 1
      continue
    }
    out += c
    i += 1
  }
  return out
}

/** `<file> » <marker>` → occurrences. Absent key = zero. */
function measure(): Counts {
  const counts: Counts = {}
  for (const rel of LAYOUT_FILES) {
    const abs = path.join(ROOT, rel)
    if (!fs.existsSync(abs)) continue
    const raw = fs.readFileSync(abs, 'utf-8')
    // Only TS/JS gets the comment strip: it understands `//` and `/* */`, and
    // a Dockerfile is full of paths like `/app/*` that would open a block
    // comment and swallow the rest of the file (measured: every Dockerfile
    // bucket fell to 0). Shell and YAML keep their `#` prose in the count —
    // conservative in the direction that fails loudly rather than quietly.
    const source = /\.(ts|tsx|js|mjs|cts|mts)$/.test(rel) ? stripComments(raw) : raw
    for (const marker of MARKERS) {
      const n = source.match(marker.pattern)?.length ?? 0
      if (n > 0) counts[`${rel} » ${marker.id}`] = n
    }
  }
  return counts
}

function readBaseline(): Counts {
  if (!fs.existsSync(BASELINE_FILE)) return {}
  const raw: unknown = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf-8'))
  if (typeof raw !== 'object' || raw === null) return {}
  const buckets = (raw as { buckets?: unknown }).buckets
  if (typeof buckets !== 'object' || buckets === null) return {}
  const out: Counts = {}
  for (const [k, v] of Object.entries(buckets)) {
    if (typeof v === 'number') out[k] = v
  }
  return out
}

function writeBaseline(counts: Counts): void {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
  fs.writeFileSync(
    BASELINE_FILE,
    `${JSON.stringify(
      {
        _comment:
          'D45 single-copy layout debt, pinned per <file> » <marker>. A ratchet: ' +
          'counts may only go DOWN. Enforced by scripts/check-single-copy-layout.ts. ' +
          'This file is also the cleanup list — every entry is a second copy or a ' +
          'second resolution path that D45 removes.',
        buckets: sorted,
      },
      null,
      2,
    )}\n`,
  )
}

function meaningOf(bucket: string): string {
  const markerId = bucket.split(' » ')[1] ?? ''
  return MARKERS.find((m) => m.id === markerId)?.meaning ?? ''
}

function main(): void {
  const current = measure()
  const update = process.argv.includes('--update')

  if (update) {
    writeBaseline(current)
    console.log(`✔ re-pinned ${Object.keys(current).length} bucket(s) → ${BASELINE_FILE}`)
    console.log('  Review the diff: it is the evidence the change was intentional.')
    return
  }

  const baseline = readBaseline()
  const worse: string[] = []
  const better: string[] = []

  for (const [bucket, n] of Object.entries(current)) {
    const pinned = baseline[bucket] ?? 0
    if (n > pinned) worse.push(`${bucket}: ${pinned} → ${n}  (${meaningOf(bucket)})`)
  }
  for (const [bucket, pinned] of Object.entries(baseline)) {
    const n = current[bucket] ?? 0
    if (n < pinned) better.push(`${bucket}: ${pinned} → ${n}`)
  }

  if (better.length > 0) {
    console.log('✔ layout debt went DOWN — re-pin so it cannot come back:')
    for (const line of better) console.log(`    ${line}`)
    console.log('  npx tsx scripts/check-single-copy-layout.ts --update')
  }

  if (worse.length > 0) {
    console.error('')
    console.error('✘ D45 single-copy layout regressed — a new copy or resolution path:')
    for (const line of worse) console.error(`    ${line}`)
    console.error('')
    console.error('  D45: one copy of every host-provided package per node, inside the active')
    console.error('  closure, reached by one path. Four copies of @camstack/system on one node')
    console.error('  cost three wrong diagnoses in an evening — see docs/decisions/adr-0045.md.')
    console.error('')
    console.error('  If this IS the intended direction, re-pin with --update and say why in')
    console.error('  the commit message.')
    process.exit(1)
  }

  if (better.length === 0) {
    console.log(
      `✔ D45 single-copy layout: ${Object.keys(current).length} pinned bucket(s), none worse`,
    )
  }
}

main()
