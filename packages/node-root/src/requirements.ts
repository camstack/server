/**
 * Package requirements (D988) for the zero-dep starter layer.
 *
 * The declaration format and its authoritative checker live in
 * `@camstack/types` (`PackageRequiresSchema`, `unmetRequirements`). The starter
 * cannot import a runtime value from there (it would bundle the whole types
 * barrel into a zero-dep file), so the few lines it needs are ported here on
 * top of `compareSemver`; `requirements-parity.spec.ts` runs both over one
 * table so they cannot drift.
 */
import type {
  PackageRequires,
  RequiredAddonUpdate,
  RunningWrapper,
  UnmetRequirement,
} from '@camstack/types'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { rootPackageDir } from './root-state.js'
import type { RootPackageSpec } from './root-package-spec.js'
import { compareSemver } from './semver-compare.js'
import type { WrapperIdentity } from '@camstack/types'

const MINIMUM_RE = /^>=(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/

/** `>=1.2.3` to `1.2.3`; null when the text is not a minimum. */
function minimumOf(range: unknown): string | null {
  if (typeof range !== 'string') return null
  const match = MINIMUM_RE.exec(range)
  return match?.[1] ?? null
}

function meets(running: string | null | undefined, minimum: string): boolean {
  return typeof running === 'string' && running.length > 0 && compareSemver(running, minimum) >= 0
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/**
 * The `camstack.requires` of a closure's root package, or `undefined` when it
 * declares none or the file is unreadable. Only well-formed minimums survive:
 * a malformed one is dropped, never guessed at.
 */
export function readClosureRequires(
  closureDir: string,
  spec: RootPackageSpec,
): PackageRequires | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(
      fs.readFileSync(path.join(rootPackageDir(closureDir, spec), 'package.json'), 'utf-8'),
    )
  } catch {
    return undefined
  }
  const requires = record(record(record(raw)['camstack'])['requires'])
  const server = minimumOf(requires['server'])
  const addons: Record<string, string> = {}
  for (const [name, range] of Object.entries(record(requires['addons']))) {
    if (minimumOf(range) !== null) addons[name] = String(range)
  }
  const wrapperRaw = record(requires['wrapper'])
  const desktop = minimumOf(wrapperRaw['desktop'])
  const image = minimumOf(wrapperRaw['image'])
  return {
    ...(server !== null ? { server: `>=${server}` } : {}),
    ...(Object.keys(addons).length > 0 ? { addons } : {}),
    ...(desktop !== null || image !== null
      ? {
          wrapper: {
            ...(desktop !== null ? { desktop: `>=${desktop}` } : {}),
            ...(image !== null ? { image: `>=${image}` } : {}),
          },
        }
      : {}),
  }
}

/** The shell as `unmetRequirements` wants it: `docker` is the `image` wrapper. */
export function runningWrapperOf(identity: WrapperIdentity): RunningWrapper {
  if (identity.kind === 'docker') return { kind: 'image', version: identity.currentVersion }
  if (identity.kind === 'electron') return { kind: 'desktop', version: identity.currentVersion }
  return { kind: identity.kind === 'native' ? 'native' : 'unknown', version: null }
}

/** The wrapper minimums of `requires` the running shell does not meet. */
export function unmetWrapperRequirements(
  requires: PackageRequires | undefined,
  wrapper: RunningWrapper,
): readonly UnmetRequirement[] {
  const unmet: UnmetRequirement[] = []
  for (const kind of ['desktop', 'image'] as const) {
    const minimum = minimumOf(requires?.wrapper?.[kind])
    if (minimum === null || wrapper.kind !== kind) continue
    if (!meets(wrapper.version, minimum)) {
      unmet.push({
        kind: 'wrapper-too-old',
        wrapper: kind,
        required: minimum,
        running: wrapper.version,
      })
    }
  }
  return unmet
}

/** The addons below the minimum a server declares — the ones to update with it. */
export function addonsBelowMinimum(
  requires: PackageRequires | undefined,
  installed: Readonly<Record<string, string | null | undefined>>,
): readonly RequiredAddonUpdate[] {
  const out: RequiredAddonUpdate[] = []
  for (const [packageName, range] of Object.entries(requires?.addons ?? {})) {
    const minimum = minimumOf(range)
    const have = installed[packageName] ?? null
    if (minimum !== null && !meets(have, minimum)) {
      out.push({ packageName, required: minimum, installed: have })
    }
  }
  return out
}

/** One line per unmet minimum, naming both versions. */
export function describeUnmetRequirement(unmet: UnmetRequirement): string {
  const have = (v: string | null, none: string): string => (v === null ? none : v)
  switch (unmet.kind) {
    case 'server-too-old':
      return `requires server >= ${unmet.required}, running ${have(unmet.running, 'unknown')}`
    case 'addon-too-old':
      return `requires ${unmet.packageName} >= ${unmet.required}, installed ${have(unmet.running, 'none')}`
    case 'wrapper-too-old':
      return `requires the ${unmet.wrapper} wrapper >= ${unmet.required}, it reports ${have(unmet.running, 'no version')}`
  }
}
