/**
 * The `ui:shots` report: `report.json` (read back by `--compare`) and
 * `report.md` (the measurement table to paste into a done-gate).
 */
import type { Theme, Viewport } from './args.js'
import type { Measurement } from './measure.js'

export interface ShotRecord {
  readonly route: string
  readonly theme: Theme
  readonly viewport: Viewport
  /** Path relative to the run's directory. */
  readonly image: string
  readonly measurement: Measurement
  /** tRPC paths the page queried that no fixture answers. */
  readonly missingFixtures: readonly string[]
  readonly pageErrors: readonly string[]
}

export interface ShotsReport {
  readonly label: string
  readonly createdAt: string
  readonly commit: string
  readonly fixtures: readonly string[] | 'all'
  readonly shots: readonly ShotRecord[]
}

export interface Difference {
  readonly key: string
  readonly what: string
  readonly regression: boolean
}

export function shotKey(s: Pick<ShotRecord, 'route' | 'theme' | 'viewport'>): string {
  return `${s.route} · ${s.viewport.name} · ${s.theme}`
}

/** A file-name-safe slug for a route: `/system/identity?tab=access` → `system-identity-tab-access`. */
export function routeSlug(route: string): string {
  const slug = route
    .replace(/^\/+/, '')
    .replace(/[^\w]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return slug === '' ? 'root' : slug.slice(0, 80)
}

export function imageName(route: string, viewport: Viewport, theme: Theme): string {
  return `${routeSlug(route)}--${viewport.name}-${theme}.png`
}

const fmtMain = (n: number | null): string => (n === null ? '—' : String(n))

function stickyCell(m: Measurement): string {
  if (!m.sticky.measured) return 'n/a'
  return `${m.sticky.pinned}/${m.sticky.total}`
}

function status(s: ShotRecord): string {
  const m = s.measurement
  const bad =
    m.overflowDoc > 0 ||
    (m.overflowMain ?? 0) > 0 ||
    m.wide.length > 0 ||
    m.sticky.unpinned.length > 0 ||
    s.pageErrors.length > 0
  return bad ? '**check**' : 'ok'
}

function notes(shots: readonly ShotRecord[]): string[] {
  const out: string[] = []
  for (const s of shots) {
    const key = shotKey(s)
    for (const w of s.measurement.wide) {
      out.push(
        `- ${key}: past the viewport: ${w.selector} (left ${w.left}, right ${w.right}, width ${w.width})`,
      )
    }
    for (const u of s.measurement.sticky.unpinned) out.push(`- ${key}: sticky not pinned: ${u}`)
    for (const f of s.missingFixtures) out.push(`- ${key}: missing fixture: ${f}`)
    for (const e of s.pageErrors) out.push(`- ${key}: page error: ${e}`)
  }
  return out
}

export function compareReports(before: ShotsReport, after: ShotsReport): Difference[] {
  const prev = new Map(before.shots.map((s) => [shotKey(s), s]))
  const out: Difference[] = []
  for (const a of after.shots) {
    const key = shotKey(a)
    const b = prev.get(key)
    if (b === undefined) {
      out.push({ key, what: 'new shot (no before)', regression: false })
      continue
    }
    const ma = a.measurement
    const mb = b.measurement
    if (ma.overflowDoc > mb.overflowDoc) {
      out.push({
        key,
        what: `document overflow ${mb.overflowDoc} → ${ma.overflowDoc} px`,
        regression: true,
      })
    }
    if ((ma.overflowMain ?? 0) > (mb.overflowMain ?? 0)) {
      out.push({
        key,
        what: `main overflow ${fmtMain(mb.overflowMain)} → ${fmtMain(ma.overflowMain)} px`,
        regression: true,
      })
    }
    if (ma.wide.length > mb.wide.length) {
      const known = new Set(mb.wide.map((w) => w.selector))
      const added = ma.wide.filter((w) => !known.has(w.selector)).map((w) => w.selector)
      out.push({
        key,
        what: `elements past the viewport ${mb.wide.length} → ${ma.wide.length} (${added.join(', ')})`,
        regression: true,
      })
    }
    if (ma.sticky.measured && mb.sticky.measured && ma.sticky.pinned < mb.sticky.pinned) {
      out.push({
        key,
        what: `pinned sticky ${mb.sticky.pinned} → ${ma.sticky.pinned} (${ma.sticky.unpinned.join(', ')})`,
        regression: true,
      })
    }
    const oldErrors = new Set(b.pageErrors)
    for (const e of a.pageErrors.filter((x) => !oldErrors.has(x))) {
      out.push({ key, what: `new page error: ${e}`, regression: true })
    }
  }
  for (const key of prev.keys()) {
    if (!after.shots.some((s) => shotKey(s) === key)) {
      out.push({ key, what: 'shot missing from this run', regression: false })
    }
  }
  return out
}

export interface CompareInput {
  readonly before: ShotsReport
  /** The before run's directory, relative to this run's directory. */
  readonly beforeDir: string
}

export function renderReport(report: ShotsReport, compare?: CompareInput): string {
  const lines: string[] = [
    `# UI shots — ${report.label}`,
    '',
    `Commit \`${report.commit}\` · ${report.createdAt} · fixtures: ${report.fixtures === 'all' ? 'all' : report.fixtures.join(', ')}`,
    '',
    'Overflow = `scrollWidth - clientWidth` in px (0 = no horizontal scroll). Past viewport = outermost visible elements crossing the viewport edge, outside any scroll container. Sticky = sticky/fixed elements still on screen after scrolling a screen (n/a = nothing scrolls).',
    '',
    '| Route | Viewport | Theme | Doc overflow | Main overflow | Past viewport | Sticky pinned | Status | Image |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const s of report.shots) {
    const m = s.measurement
    lines.push(
      `| ${s.route} | ${s.viewport.name} ${s.viewport.width}×${s.viewport.height} | ${s.theme} | ${m.overflowDoc} | ${fmtMain(m.overflowMain)} | ${m.wide.length} | ${stickyCell(m)} | ${status(s)} | ![](${s.image}) |`,
    )
  }
  const n = notes(report.shots)
  if (n.length > 0) lines.push('', '## Findings', '', ...n)
  if (compare !== undefined) {
    const diffs = compareReports(compare.before, report)
    const regressions = diffs.filter((d) => d.regression)
    const before = new Map(compare.before.shots.map((s) => [shotKey(s), s]))
    lines.push(
      '',
      '## Before / after',
      '',
      `Before: \`${compare.beforeDir}\` (${compare.before.label}, \`${compare.before.commit}\`)`,
      '',
    )
    lines.push(
      regressions.length === 0
        ? 'No regressions.'
        : `**${regressions.length} regression(s):**\n\n${regressions.map((d) => `- ${d.key}: ${d.what}`).join('\n')}`,
    )
    const other = diffs.filter((d) => !d.regression)
    if (other.length > 0) lines.push('', ...other.map((d) => `- ${d.key}: ${d.what}`))
    lines.push('', '| Shot | Before | After |', '| --- | --- | --- |')
    for (const s of report.shots) {
      const b = before.get(shotKey(s))
      const left = b === undefined ? '—' : `![before](${compare.beforeDir}/${b.image})`
      lines.push(`| ${shotKey(s)} | ${left} | ![after](${s.image}) |`)
    }
  }
  return `${lines.join('\n')}\n`
}
