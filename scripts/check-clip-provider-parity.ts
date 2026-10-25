#!/usr/bin/env tsx
/**
 * Clip-provider parity guard — three sibling implementations of one contract
 * must not drift apart in silence.
 *
 * ── The bug class this prevents ────────────────────────────────────────────
 * `provider-reolink`, `provider-hikvision` and `provider-amcrest` each serve
 * the same videoclips capability with their own code. On 2026-09-23 the SAME
 * defect class surfaced four times, and every time it was present in one
 * provider and absent from the others:
 *
 *  - D618: a drain listener registered once at spawn instead of per refusal.
 *    Hikvision only. Clips died at 11.2 s for three days and it read as a
 *    Hikvision media fault, because nobody diffed the three.
 *  - An unbounded ffmpeg interleave window. Amcrest only. "Si blocca spesso."
 *  - Audio timestamps never resynced from the sample count. Amcrest only.
 *    Ninety-one per cent of the sound discarded.
 *  - `thumbnailUnavailable: { reason: 'unsupported' }` hard-coded on every
 *    row. Amcrest only. It read to the operator as broken thumbnails.
 *
 * A defect in one of three reads as a property of that vendor's hardware for
 * as long as nobody puts them side by side. The operator, after the fourth:
 * *"Assicuriamoci che non si rompano più lavorando su altri provider"* [let us make sure they do not break any more while working on other providers].
 *
 * ── What this guard does ───────────────────────────────────────────────────
 * It holds a TABLE: one row per invariant, one cell per provider, and every
 * cell is decided — `required` (the probe must match) or `exempt` with a
 * reason someone had to type. The guard fails on three things, and the third
 * is the one that usually rots:
 *
 *  1. a `required` cell whose probe does not match — the provider drifted;
 *  2. a provider missing from a row — a NEW provider cannot be added without
 *     deciding every invariant, which is the whole point;
 *  3. an `exempt` cell whose probe DOES match — the exemption is stale, and a
 *     recorded reason that no longer applies reads as verification of it.
 *
 * It deliberately holds only invariants that are DECIDED for all three. The
 * two ffmpeg mux flags Reolink lacks (`-max_interleave_delta`,
 * `-frag_duration`) are not here yet: whether that window bites a transfer
 * that lands the whole clip at 49–62× is being measured, and a cell invented
 * before the measurement would be the guard asserting a guess.
 *
 * Run manually: npx tsx scripts/check-clip-provider-parity.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

/** Every provider that serves clips. A new one must appear in every row. */
const PROVIDERS = ['reolink', 'hikvision', 'amcrest'] as const
type Provider = (typeof PROVIDERS)[number]

type Cell = 'required' | { readonly exempt: string }

interface Invariant {
  readonly id: string
  /** One line: what it prevents, in the vocabulary of the failure. */
  readonly what: string
  /** Where the failure is recorded. */
  readonly record: string
  /** True when the provider's sources satisfy it. */
  readonly holds: (sources: readonly string[]) => boolean
  readonly cells: Readonly<Record<Provider, Cell>>
}

const INVARIANTS: readonly Invariant[] = [
  {
    id: 'peer-drain-gate',
    what: 'the peer hop has a drain gate, so a consumer that never drains is cut rather than fed forever',
    record: 'D447',
    holds: (sources) => sources.some((s) => /createDrainGate|drainTimer/.test(s)),
    cells: { reolink: 'required', hikvision: 'required', amcrest: 'required' },
  },
  {
    id: 'still-refusal-vocabulary',
    what: 'a still that cannot be made refuses BY NAME, so absence never looks like a camera with no picture',
    record: 'D315, D391',
    holds: (sources) => sources.some((s) => /ClipStillRefusal|clipStillRefusal/.test(s)),
    cells: { reolink: 'required', hikvision: 'required', amcrest: 'required' },
  },
  {
    id: 'no-hardcoded-unsupported-thumbnail',
    what: 'a row never declares its thumbnail unsupported unconditionally — that is an unimplemented feature wearing a capability answer',
    record: 'the Amcrest stills, 2026-09-23',
    holds: (sources) =>
      !sources.some((s) => /thumbnailUnavailable:\s*\{\s*reason:\s*'unsupported'/.test(s)),
    cells: { reolink: 'required', hikvision: 'required', amcrest: 'required' },
  },
  {
    id: 'declares-playback-options',
    what: 'the provider declares what its clips can really do, so the chrome never offers a rate it will not deliver',
    record: 'D612',
    holds: (sources) => sources.some((s) => /getPlaybackOptions/.test(s)),
    cells: { reolink: 'required', hikvision: 'required', amcrest: 'required' },
  },
]

function sourcesOf(provider: Provider): readonly string[] {
  const dir = path.join(ROOT, `packages/addon-provider-${provider}/src`)
  const out: string[] = []
  const walk = (at: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'dist' || entry.name === 'node_modules') {
          continue
        }
        walk(full)
      } else if (entry.name.endsWith('.ts')) {
        out.push(fs.readFileSync(full, 'utf8'))
      }
    }
  }
  if (!fs.existsSync(dir)) return []
  walk(dir)
  return out
}

const sources = new Map<Provider, readonly string[]>(
  PROVIDERS.map((p) => [p, sourcesOf(p)] as const),
)

const failures: string[] = []
for (const inv of INVARIANTS) {
  for (const provider of PROVIDERS) {
    const cell: Cell | undefined = inv.cells[provider]
    if (cell === undefined) {
      failures.push(
        `  ${inv.id}: '${provider}' is not in this row. A new clip provider decides EVERY invariant — ` +
          `mark it 'required', or exempt it with the reason.`,
      )
      continue
    }
    const holds = inv.holds(sources.get(provider) ?? [])
    if (cell === 'required' && !holds) {
      failures.push(`  ${inv.id}: '${provider}' has drifted — ${inv.what} (${inv.record})`)
    }
    if (cell !== 'required' && holds) {
      failures.push(
        `  ${inv.id}: '${provider}' is exempt ("${cell.exempt}") but SATISFIES it. ` +
          `A recorded reason that no longer applies reads as verification — delete the exemption.`,
      )
    }
  }
}

if (failures.length > 0) {
  console.error(
    '✘ clip providers have drifted apart (see scripts/check-clip-provider-parity.ts):\n',
  )
  for (const line of failures) console.error(line)
  console.error('')
  process.exit(1)
}
console.log(
  `✓ clip-provider parity: ${String(INVARIANTS.length)} invariants × ${String(PROVIDERS.length)} providers, every cell decided`,
)
