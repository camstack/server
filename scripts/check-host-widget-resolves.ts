#!/usr/bin/env tsx
/**
 * Host-widget guard — every `host/…` widget a capability DECLARES must exist in
 * `HOST_WIDGETS`.
 *
 * ## The failure this catches, and what it cost
 *
 * `scene-monitor.cap.ts` declared `deviceConfig.ui.widgetId:
 * 'host/scene-monitor-editor'` on the day the cap landed. `HOST_WIDGETS`
 * registered five widgets; that one was never among them. `WidgetSlot` looks
 * the id up in `HOST_WIDGETS` first and, on a miss, falls through to the
 * Module-Federation path — which for a `host/` id resolves nothing and renders
 * `WidgetMissingError reason="unknown"`.
 *
 * So the cap's device tab existed, mounted, and displayed an error box. Six
 * caps declared a `host/` widget; five resolved. Nothing failed at build time,
 * nothing logged, and the only way to find it was to open the tab on a camera
 * that had the cap — which nothing did, because the cap also had no provider.
 *
 * That is two absences hiding each other, and it is exactly the shape AGENTS.md
 * warns about: *a leftover that describes the right design is worse than
 * nothing, it reads as verification.*
 *
 * ## What it checks
 *
 * 1. Every `widgetId: 'host/…'` string literal anywhere in `packages/ * /src`
 *    appears as a key of `HOST_WIDGETS`.
 * 2. Every `host/…` key in `HOST_WIDGETS` is declared by SOMETHING — a widget
 *    registered for nobody is dead code that will be kept alive by this file.
 *
 * The scan is repo-wide rather than cap-only because a `host/` widget has two
 * legitimate declarers: a `*.cap.ts` `deviceConfig.ui` block (the D14
 * archetype) and an addon's hand-written `getDeviceSettingsContribution`
 * (`host/recording-panel` is declared that way). A cap-only scan called the
 * second one dead the first time it ran, which is how a guard earns its
 * deletion.
 *
 * ## Why it cannot cry wolf
 *
 * Both directions compare STRING LITERALS that are either present or absent —
 * no judgement, no heuristics. A cap that computed its widget id would be
 * invisible here, and that is the honest trade: this guard is worth keeping
 * precisely because it never argues.
 *
 * Usage: tsx scripts/check-host-widget-resolves.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const CAP_DIR = 'packages/types/src/capabilities'
const REGISTRY = 'packages/ui-library/src/widgets/host-widgets.ts'

interface Declaration {
  readonly widgetId: string
  readonly capFile: string
}

function readOrDie(relative: string): string {
  const abs = path.join(ROOT, relative)
  if (!fs.existsSync(abs)) {
    console.error(`✖ host-widget guard: ${relative} does not exist — has it moved?`)
    process.exit(1)
  }
  return fs.readFileSync(abs, 'utf8')
}

/** Every TypeScript source under a package's `src`, minus the registry itself. */
function* sourceFiles(): Generator<string> {
  const packagesDir = path.join(ROOT, 'packages')
  for (const pkg of fs.readdirSync(packagesDir)) {
    const src = path.join(packagesDir, pkg, 'src')
    if (!fs.existsSync(src)) continue
    yield* walk(src)
  }
}

const SKIPPED_DIRS: ReadonlySet<string> = new Set(['node_modules', 'dist', '__tests__'])

/**
 * Can this file DECLARE a host widget? A spec's fixture ids (`host/other`) are
 * test data: they neither need a registry entry nor keep a dead one alive.
 */
export function isDeclarerSource(fileName: string): boolean {
  if (!/\.tsx?$/.test(fileName)) return false
  return !/\.(spec|test)\.tsx?$/.test(fileName)
}

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue
      yield* walk(full)
      continue
    }
    if (isDeclarerSource(entry.name)) yield full
  }
}

/**
 * `widgetId: 'host/x'` anywhere a cap or an addon declares a device tab —
 * including through a constant.
 *
 * The literal-only scan called `host/camera-grid-layout` dead code while
 * `grid-device-settings.ts` was declaring it perfectly well as
 * `widgetId: GRID_LAYOUT_WIDGET_ID`, with the constant defined six lines
 * above. A guard that reports a live declaration as dead is worse than no
 * guard: the obvious way to satisfy it is to DELETE working code.
 *
 * One level of same-file indirection is enough for every declaration this repo
 * has, and it keeps the scan a regex rather than a parser.
 */
function declaredWidgets(): readonly Declaration[] {
  const out: Declaration[] = []
  const registryAbs = path.join(ROOT, REGISTRY)
  for (const file of sourceFiles()) {
    if (file === registryAbs) continue
    const source = fs.readFileSync(file, 'utf8')
    if (!source.includes('widgetId:')) continue
    const rel = path.relative(ROOT, file)

    for (const match of source.matchAll(/widgetId:\s*'(host\/[^']+)'/g)) {
      out.push({ widgetId: match[1]!, capFile: rel })
    }

    // `const X = 'host/…'` in this file, then `widgetId: X` somewhere in it.
    const consts = new Map<string, string>()
    for (const c of source.matchAll(/\b([A-Z][A-Z0-9_]*)\s*=\s*'(host\/[^']+)'/g)) {
      consts.set(c[1]!, c[2]!)
    }
    for (const match of source.matchAll(/widgetId:\s*([A-Z][A-Z0-9_]*)\b/g)) {
      const resolved = consts.get(match[1]!)
      if (resolved !== undefined) out.push({ widgetId: resolved, capFile: rel })
    }
  }
  return out
}

/** True when the declaration came from a capability definition — the D14
 *  archetype, whose widget the FRAMEWORK mounts and therefore must resolve. */
function isCapDeclaration(d: Declaration): boolean {
  return d.capFile.startsWith(CAP_DIR) && d.capFile.endsWith('.cap.ts')
}

/** `'host/x': Component,` keys of the HOST_WIDGETS object literal. */
function registeredWidgets(source: string): ReadonlySet<string> {
  const start = source.indexOf('export const HOST_WIDGETS')
  if (start < 0) {
    console.error(`✖ host-widget guard: HOST_WIDGETS not found in ${REGISTRY}`)
    process.exit(1)
  }
  const end = source.indexOf('\n}', start)
  const block = source.slice(start, end < 0 ? source.length : end)
  return new Set([...block.matchAll(/'(host\/[^']+)'\s*:/g)].map((m) => m[1]!))
}

function main(): void {
  const declarations = declaredWidgets()
  const registered = registeredWidgets(readOrDie(REGISTRY))

  const capDeclarations = declarations.filter(isCapDeclaration)
  if (capDeclarations.length === 0) {
    console.error(
      '✖ host-widget guard: no cap declares a host/ widget — the scan found nothing, which means it broke rather than passed.',
    )
    process.exit(1)
  }

  const problems: string[] = []
  for (const d of declarations) {
    if (!registered.has(d.widgetId)) {
      problems.push(
        `  ${d.capFile} declares "${d.widgetId}", which is NOT in HOST_WIDGETS.\n` +
          `    → WidgetSlot falls through to Module Federation and renders WidgetMissingError.\n` +
          `    → Register it in ${REGISTRY} (lazily, if it mounts MaskShapeCanvas).`,
      )
    }
  }
  const declaredIds = new Set(declarations.map((d) => d.widgetId))
  for (const id of registered) {
    if (!declaredIds.has(id)) {
      problems.push(
        `  HOST_WIDGETS registers "${id}", which NO capability declares.\n` +
          `    → Either a declarer lost its widgetId, or this entry is dead code.`,
      )
    }
  }

  if (problems.length > 0) {
    console.error('✖ host-widget guard failed:\n')
    console.error(problems.join('\n\n'))
    process.exit(1)
  }

  console.log(
    `  ✔ host widgets: ${declarations.length} declared (${capDeclarations.length} by caps), all ${registered.size} resolve in HOST_WIDGETS`,
  )
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
