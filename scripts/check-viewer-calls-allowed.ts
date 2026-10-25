#!/usr/bin/env tsx
/**
 * The viewer app can do what a VIEWER may do (D921).
 *
 * Every cap call the viewer app (`camstack/src`) makes from a section a viewer
 * sees must be reachable by a viewer: labelled `viewer` (or `public`) in
 * `METHOD_ACCESS_MAP`, or `feature:<id>` when the call sits in that feature's
 * section. A call from an admin-only section is not checked.
 *
 * Which files belong to which section is {@link SECTION_RULES}, first match
 * wins; a file no rule names is BASELINE. When the viewer grows a manifest of
 * its own sections, this table moves there.
 *
 * Extraction is textual and therefore a LOWER bound: `capQuery` /
 * `capMutate` / `capMutateOrThrow` with literal cap + method names, and the
 * typed client's `<cap>.<method>.query|mutate|subscribe(`. Calls through a
 * router name held in a variable (device statuses, accessory controls) are not
 * seen here — they go to device caps, whose protected methods are viewer by
 * derivation.
 *
 * The camstack/ submodule is absent in CI: the guard then says so and passes.
 * `CAMSTACK_VIEWER_DIR=<viewer checkout>` points it at another checkout.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  featureOfRole,
  METHOD_ACCESS_MAP,
  type ViewerFeatureId,
} from '../packages/types/src/index.js'

const ROOT = path.join(import.meta.dirname, '..')
const VIEWER_ROOT = process.env['CAMSTACK_VIEWER_DIR'] || path.join(ROOT, 'camstack')
const SRC = path.join(VIEWER_ROOT, 'src')

/** A viewer-app section a file belongs to. */
type Section =
  | { readonly kind: 'baseline' }
  | { readonly kind: 'admin' }
  | {
      readonly kind: 'feature'
      readonly feature: ViewerFeatureId
    }

interface SectionRule {
  readonly match: RegExp
  readonly section: Section
  readonly why: string
}

const feature = (f: ViewerFeatureId): Section => ({ kind: 'feature', feature: f })

/** File → section. Paths are relative to `camstack/src`. */
export const SECTION_RULES: readonly SectionRule[] = [
  {
    match: /^(screens\/faces\/|components\/faces\/|data\/use-face-|data\/use-identity-audit\.ts$)/,
    section: feature('face-assignment'),
    why: 'Library → Review and the face card of an event',
  },
  {
    match: /^(screens\/plates\/|data\/use-plate-review\.ts$)/,
    section: feature('plate-assignment'),
    why: 'Library → Plates and the plate card of an event',
  },
  {
    match: /^(screens\/retrain\/|data\/use-retrain)/,
    section: feature('retrain'),
    why: 'Library → Retrain',
  },
  {
    match: /^(screens\/scenes\/|data\/scenes-library\.ts$)/,
    section: feature('scenes'),
    why: 'Library → Scenes',
  },
  {
    match:
      /^(screens\/notifications\/rule-editor\/|data\/use-rule-history\.ts$|data\/use-nc-rule-test\.ts$|data\/use-shared-sequences\.ts$)/,
    section: { kind: 'admin' },
    why: 'notification rule editing — admin until a feature is added for it',
  },
  {
    match:
      /^(components\/camera\/management\/|data\/use-storage-management\.ts$|data\/use-users\.ts$|data\/use-node-directory\.ts$|data\/use-addon-packages\.ts$|components\/notifications\/ScopePickers\.tsx$)/,
    section: { kind: 'admin' },
    why: 'camera storage/events management and the rule scope pickers — rendered for an admin only',
  },
]

/**
 * Single calls in a baseline file that only an admin reaches, each with the
 * viewer gate that hides it. Admin-tier today for EVERY non-admin, so a viewer
 * loses nothing it had.
 */
export const ADMIN_CALLS_IN_BASELINE_FILES: Readonly<Record<string, string>> = {
  'pipelineOrchestrator.setCameraSwitch@data/use-camera-switches.ts':
    'CameraSwitchGroup renders the toggles only for useIsAdmin()',
}

/**
 * Feature calls made from a baseline file — the event detail shows a
 * recognised name to everyone (baseline reads) and offers the curation
 * actions only to a viewer holding the feature. Each entry names the gate the
 * viewer must apply; until the viewer gates on the feature (today it gates on
 * `useIsAdmin()`), a viewer without it never reaches the button.
 */
export const FEATURE_CALLS_IN_BASELINE_FILES: Readonly<Record<string, ViewerFeatureId>> = {
  'faceGallery.listRecentFaces@components/camera/theater/detail/use-face-info.ts':
    'face-assignment',
  'faceGallery.assignFace@components/camera/theater/detail/use-face-info.ts': 'face-assignment',
  'faceGallery.unassignFace@components/camera/theater/detail/use-face-info.ts': 'face-assignment',
  'faceGallery.unassignFaces@components/camera/theater/detail/use-face-info.ts': 'face-assignment',
  'faceGallery.createIdentity@components/camera/theater/detail/use-face-info.ts': 'face-assignment',
}

function sectionOf(rel: string): Section {
  for (const rule of SECTION_RULES) if (rule.match.test(rel)) return rule.section
  return { kind: 'baseline' }
}

export interface ViewerCall {
  readonly path: string
  readonly file: string
}

const CAP_HELPER_RE =
  /(?:cap(?:Query|Mutate|MutateOrThrow)|callMutate)\(\s*[^'`]{1,160}?,\s*'([a-zA-Z]+)',\s*'([a-zA-Z]+)'/g
const TYPED_CLIENT_RE = /\b([a-z][a-zA-Z]+)\.([a-z][a-zA-Z]+)\.(?:query|mutate|subscribe)\(/g
/** The addon custom-action dispatcher reached through a property read. */
const ADDONS_CUSTOM_RE = /\baddons\b[^\n]{0,80}\.custom\b/g

/** Every literal cap call in one source text that names a known cap path. */
export function extractCalls(source: string, file: string): ViewerCall[] {
  const out: ViewerCall[] = []
  for (const re of [CAP_HELPER_RE, TYPED_CLIENT_RE]) {
    re.lastIndex = 0
    for (let m = re.exec(source); m !== null; m = re.exec(source)) {
      const p = `${m[1]}.${m[2]}`
      if (p in METHOD_ACCESS_MAP) out.push({ path: p, file })
    }
  }
  ADDONS_CUSTOM_RE.lastIndex = 0
  if (ADDONS_CUSTOM_RE.test(source)) out.push({ path: 'addons.custom', file })
  return out
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      walk(p, out)
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(spec|test)\.tsx?$/.test(entry.name)) {
      out.push(p)
    }
  }
}

export interface Refusal {
  readonly call: ViewerCall
  readonly role: string
  readonly section: string
}

/** The calls a viewer would be refused in the section that makes them. */
export function refusedCalls(calls: readonly ViewerCall[]): Refusal[] {
  const out: Refusal[] = []
  for (const call of calls) {
    const section = sectionOf(call.file)
    if (section.kind === 'admin') continue
    const key = `${call.path}@${call.file}`
    if (key in ADMIN_CALLS_IN_BASELINE_FILES) continue
    const role = METHOD_ACCESS_MAP[call.path]?.role ?? 'admin'
    if (role === 'viewer' || role === 'public') continue
    const gated = FEATURE_CALLS_IN_BASELINE_FILES[key]
    if (gated !== undefined && featureOfRole(role) === gated) continue
    if (section.kind === 'feature' && featureOfRole(role) === section.feature) continue
    out.push({
      call,
      role,
      section: section.kind === 'feature' ? `feature:${section.feature}` : 'baseline',
    })
  }
  return out
}

function main(): void {
  if (!fs.existsSync(SRC)) {
    console.log(
      `  ⊘ viewer NOT checked: ${path.relative(ROOT, SRC) || SRC} is absent (the camstack/ submodule is not checked out here) — set CAMSTACK_VIEWER_DIR=<viewer checkout>`,
    )
    return
  }
  const files: string[] = []
  walk(SRC, files)
  const calls = files.flatMap((f) =>
    extractCalls(fs.readFileSync(f, 'utf8'), path.relative(SRC, f).split(path.sep).join('/')),
  )
  const refused = refusedCalls(calls)
  if (refused.length > 0) {
    console.error(`✖ viewer calls: ${refused.length} call(s) a viewer would be refused`)
    for (const r of refused) {
      console.error(`  • ${r.call.path} (${r.role}) from ${r.call.file} [${r.section}]`)
    }
    console.error(
      "\n  Label the method `role: 'viewer'` (or its feature) in its *.cap.ts and run codegen,\n  or add the file to SECTION_RULES if the section is feature- or admin-gated.",
    )
    process.exit(1)
  }
  const distinct = new Set(calls.map((c) => c.path)).size
  console.log(
    `✔ viewer calls: ${calls.length} literal calls (${distinct} methods), all viewer-reachable in their section`,
  )
}

if (import.meta.url === `file://${process.argv[1]}`) main()
