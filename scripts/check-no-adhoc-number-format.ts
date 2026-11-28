#!/usr/bin/env tsx
/**
 * One number rule for the UI: a reading or measurement is formatted by `formatNumeric`
 * (`@dominevo/ui-library`, `lib/format-numeric.ts`): the operator's precision wins, with none at most two
 * decimals, trailing zeros trimmed. A hand-written `toFixed(`, `toPrecision(`, `minimumFractionDigits` or `maximumFractionDigits` in runtime code of
 * `packages/ui-library/src` or `packages/addon-admin-ui/src` is a second rule, so it is refused.
 *
 * The allowlist below holds every use that is NOT a reading (byte sizes, geometry, whole-number
 * progress, coordinates, rounding helpers). Each entry names the file, how many uses it may carry and why;
 * a new use in an allowlisted file exceeds the count and fails, and an entry that no longer matches fails too,
 * so the list only shrinks. Specs, `__tests__` and `.d.ts` are skipped; comment lines are skipped.
 *
 * Usage: npx tsx scripts/check-no-adhoc-number-format.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCANNED: readonly string[] = ['packages/ui-library/src', 'packages/addon-admin-ui/src']
const FORMATTER = 'packages/ui-library/src/lib/format-numeric.ts'
export const USE_RE = /\.toFixed\(|\.toPrecision\(|maximumFractionDigits|minimumFractionDigits/g

interface AllowEntry {
  readonly file: string
  readonly uses: number
  readonly reason: string
}

const U = 'packages/ui-library/src/composites/'
const A = 'packages/addon-admin-ui/src/'
const BYTES = 'a byte size with its unit, not a reading'
const GEOM = 'SVG / CSS geometry or snapping math, not shown as a number'
const WHOLE = 'a whole-number display (ms, fps, percent, kbps): no decimals to rule'
const SCORE_PCT = 'a detection score shown as a whole percent'

export const ALLOWLIST: readonly AllowEntry[] = [
  { file: `${U}detection-overlay.tsx`, uses: 1, reason: WHOLE },
  { file: `${U}detection-result-tree.tsx`, uses: 3, reason: SCORE_PCT },
  { file: `${U}detection-canvas.tsx`, uses: 4, reason: WHOLE },
  { file: `${U}stream-panel.tsx`, uses: 1, reason: 'average inference time in whole milliseconds' },
  { file: `${U}response-log.tsx`, uses: 1, reason: BYTES },
  { file: `${U}log-stream.tsx`, uses: 1, reason: BYTES },
  { file: `${U}webrtc-diagnostics/format.ts`, uses: 2, reason: BYTES },
  { file: `${U}data-records/data-records-hub.tsx`, uses: 2, reason: BYTES },
  { file: `${U}cap-settings/recording-spans.ts`, uses: 1, reason: BYTES },
  {
    file: `${U}charts/chart-uplot.ts`,
    uses: 3,
    reason: `${BYTES} (axis) and the >=100 integer branch of formatChartNumber`,
  },
  {
    file: `${U}stream-debug/stream-debug-overlay.tsx`,
    uses: 1,
    reason: 'debug overlay with an explicit digits argument per row',
  },
  {
    file: `${U}quantity-value-input/quantity-value.ts`,
    uses: 1,
    reason:
      'float-residue cleanup of a converted value kept as the editable input value (it must round-trip, so it is not display-rounded)',
  },
  { file: `${U}hero-scene/backdrops.tsx`, uses: 2, reason: GEOM },
  {
    file: `${U}device-card/scenes/siren/model.ts`,
    uses: 1,
    reason: 'float-residue cleanup of a stepper value, parsed back to a number',
  },
  {
    file: `${U}device-card/scenes/climate/ClimateCard.tsx`,
    uses: 1,
    reason: 'float-residue cleanup of a setpoint, parsed back to a number',
  },
  {
    file: `${U}device-card/scenes/control/model.ts`,
    uses: 1,
    reason: 'float-residue cleanup of a stepper value, parsed back to a number',
  },
  {
    file: `${U}device-card/scenes/weather-station/WeatherStationIllustration.tsx`,
    uses: 1,
    reason: 'CSS animation period',
  },
  { file: `${U}device-card/illustrations/EnergyFlowIllustration.tsx`, uses: 7, reason: GEOM },
  { file: `${U}device-card/illustrations/ApplianceIllustration.tsx`, uses: 2, reason: GEOM },
  {
    file: `${U}device-card/parts/Dial.tsx`,
    uses: 1,
    reason: 'snapping a dial value, parsed back to a number',
  },
  { file: `${A}components/mesh/MeshStatusPanel.tsx`, uses: 3, reason: BYTES },
  {
    file: `${A}components/settings/SiteLocationCard.tsx`,
    uses: 1,
    reason: 'a coordinate at 6 decimals',
  },
  { file: `${A}components/pipeline/NodeDetailHeader.tsx`, uses: 1, reason: WHOLE },
  { file: `${A}components/pipeline/CameraStatusStrip.tsx`, uses: 1, reason: WHOLE },
  { file: `${A}components/pipeline/LiveLoadPanel.tsx`, uses: 3, reason: WHOLE },
  { file: `${A}components/pipeline/tabs/NodeLiveTab.tsx`, uses: 2, reason: WHOLE },
  { file: `${A}components/pipeline/assignments/AssignmentStatusCell.tsx`, uses: 2, reason: WHOLE },
  { file: `${A}components/pipeline/cameras/runtime-blocks.tsx`, uses: 3, reason: WHOLE },
  { file: `${A}components/cluster/load/LoadTab.tsx`, uses: 1, reason: WHOLE },
  {
    file: `${A}components/recordings/migration/StorageMigrationSection.tsx`,
    uses: 1,
    reason: 'a progress bar width, CSS geometry',
  },
  { file: `${A}components/storage/DrainProgressLine.tsx`, uses: 1, reason: BYTES },
  { file: `${A}components/storage/PathBrowser.tsx`, uses: 1, reason: BYTES },
  { file: `${A}components/device/tabs/OverviewTab.tsx`, uses: 1, reason: WHOLE },
  {
    file: `${A}components/device/tabs/TracksTab.tsx`,
    uses: 3,
    reason: 'centimetres whole, and track coordinates at 3 decimals',
  },
  { file: `${A}lib/format-size.ts`, uses: 1, reason: BYTES },
  { file: `${A}pages/events-debug-tapes.helpers.ts`, uses: 2, reason: BYTES },
  { file: `${A}pages/DeviceDetail.tsx`, uses: 2, reason: WHOLE },
  { file: `${A}pages/system/AiModelPicker.tsx`, uses: 1, reason: BYTES },
  { file: `${A}pages/system/AiRuntimes.tsx`, uses: 1, reason: BYTES },
  { file: `${A}pages/system/ai-test-chat.helpers.ts`, uses: 2, reason: BYTES },
  { file: `${A}pages/system/notification-rule-status.ts`, uses: 3, reason: BYTES },
]

const SKIP_PATH_RE = /(?:__tests__|\.spec\.|\.test\.|\.d\.ts$)/
const COMMENT_LINE_RE = /^\s*(?:\*|\/\/|\/\*)/

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules') walk(full, out)
    } else if (/\.tsx?$/.test(name)) out.push(full)
  }
}

/** Uses of an ad-hoc number format per repo-relative file. */
export function countUses(root: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const dir of SCANNED) {
    const files: string[] = []
    walk(path.join(root, dir), files)
    for (const abs of files) {
      const rel = path.relative(root, abs).split(path.sep).join('/')
      if (rel === FORMATTER || SKIP_PATH_RE.test(rel)) continue
      let n = 0
      for (const line of readFileSync(abs, 'utf8').split('\n')) {
        if (COMMENT_LINE_RE.test(line)) continue
        n += line.match(USE_RE)?.length ?? 0
      }
      if (n > 0) counts.set(rel, n)
    }
  }
  return counts
}

export function violations(counts: ReadonlyMap<string, number>): string[] {
  const allowed = new Map(ALLOWLIST.map((e) => [e.file, e.uses]))
  const out: string[] = []
  for (const [file, n] of counts) {
    const cap = allowed.get(file) ?? 0
    if (n > cap) {
      out.push(
        `${file}: ${String(n)} toFixed/toPrecision/FractionDigits use(s), ${String(cap)} allowed — format a reading with formatNumeric(value, precision) from @dominevo/ui-library`,
      )
    }
  }
  for (const [file, cap] of allowed) {
    if ((counts.get(file) ?? 0) < cap) {
      out.push(
        `${file}: allowlisted for ${String(cap)} use(s) but fewer remain — shrink scripts/check-no-adhoc-number-format.ts`,
      )
    }
  }
  return out
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const bad = violations(countUses(ROOT))
  if (bad.length > 0) {
    console.error(`check-no-adhoc-number-format: ${String(bad.length)} problem(s)`)
    for (const b of bad) console.error(`  ${b}`)
    process.exit(1)
  }
  console.log('check-no-adhoc-number-format: ok')
}
