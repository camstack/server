/**
 * What a published package needs from the rest of the install (D988).
 *
 * One published framework package (`@camstack/server`) carries the kernel, the
 * builtins and the capability contracts, so "which addon runs on which
 * framework" is a question of version, and the answer is DECLARED by the
 * package that knows it:
 *
 *   - an addon says the oldest server it runs on (`requires.server: ">=X"`);
 *   - the server says the oldest addon it works with
 *     (`requires.addons: { "@camstack/addon-x": ">=Y" }`) and the oldest shell
 *     around it (`requires.wrapper: { desktop, image }`);
 *   - a wrapper (the desktop app, the container starter) says which server
 *     range it can host, and reports its own kind and version.
 *
 * The publish workflow STAMPS these after the version bump
 * (`scripts/ci/stamp-requires.mjs`); nobody types a number by hand.
 *
 * A requirement that cannot be checked is NOT met: a shell that reports no
 * version counts as below the minimum, and an unreadable running version is
 * named in the result (a failed read is never a pass).
 */
import { z } from 'zod'

/** `>=MAJOR.MINOR.PATCH[-prerelease]` — the only range shape a requirement uses. */
export const MinVersionSchema = z
  .string()
  .regex(/^>=\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'a minimum is written ">=X.Y.Z"')

export const PackageRequiresSchema = z.object({
  /** The oldest `@camstack/server` this package runs on. */
  server: MinVersionSchema.optional(),
  /** The oldest installed version of each named addon package. */
  addons: z.record(z.string(), MinVersionSchema).optional(),
  /** The oldest shell around the server, per shell kind. */
  wrapper: z
    .object({
      desktop: MinVersionSchema.optional(),
      image: MinVersionSchema.optional(),
    })
    .optional(),
})
export type PackageRequires = z.infer<typeof PackageRequiresSchema>

/** `>=1.2.3` to `1.2.3`; `null` when the text is not a minimum. */
export function minimumOf(range: string): string | null {
  return MinVersionSchema.safeParse(range).success ? range.slice(2) : null
}

function parts(version: string): { readonly nums: readonly number[]; readonly pre: string | null } {
  const dash = version.indexOf('-')
  const base = dash === -1 ? version : version.slice(0, dash)
  const nums = base.split('.').map((s) => {
    const n = Number.parseInt(s, 10)
    return Number.isNaN(n) ? 0 : n
  })
  return { nums, pre: dash === -1 ? null : version.slice(dash + 1) }
}

/** -1 | 0 | 1; a prerelease sorts below its release. Never throws. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const x = pa.nums[i] ?? 0
    const y = pb.nums[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  if (pa.pre === pb.pre) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  return pa.pre < pb.pre ? -1 : 1
}

export type WrapperRequirementKind = 'desktop' | 'image'

/** The shell around a node, as it reports itself. `version: null` is "reported nothing". */
export interface RunningWrapper {
  readonly kind: WrapperRequirementKind | 'native' | 'unknown'
  readonly version: string | null
}

/** What is actually running. `null` is "could not be read". */
export interface RunningVersions {
  readonly server: string | null
  readonly addons: Readonly<Record<string, string | null | undefined>>
  readonly wrapper: RunningWrapper | null
}

/** One unmet requirement; each names the versions on both sides. */
export const UnmetRequirementSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('server-too-old'),
    required: z.string(),
    /** `null` — the running server version could not be read. */
    running: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('addon-too-old'),
    packageName: z.string(),
    required: z.string(),
    /** `null` — the addon is not installed (or its version is unreadable). */
    running: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('wrapper-too-old'),
    wrapper: z.enum(['desktop', 'image']),
    required: z.string(),
    /** `null` — the wrapper reported no version. */
    running: z.string().nullable(),
  }),
])
export type UnmetRequirement = z.infer<typeof UnmetRequirementSchema>

export const RequiredAddonUpdateSchema = z.object({
  packageName: z.string(),
  /** The minimum the target server declares. */
  required: z.string(),
  /** What this node has; `null` when the addon is not installed. */
  installed: z.string().nullable(),
})
export type RequiredAddonUpdate = z.infer<typeof RequiredAddonUpdateSchema>

function meets(running: string | null | undefined, minimum: string): boolean {
  return typeof running === 'string' && running.length > 0 && compareVersions(running, minimum) >= 0
}

/** Every requirement of `requires` that `running` does not meet. Empty means "fine". */
export function unmetRequirements(
  requires: PackageRequires | undefined,
  running: RunningVersions,
): readonly UnmetRequirement[] {
  if (requires === undefined) return []
  const unmet: UnmetRequirement[] = []
  const server = requires.server === undefined ? null : minimumOf(requires.server)
  if (server !== null && !meets(running.server, server)) {
    unmet.push({ kind: 'server-too-old', required: server, running: running.server })
  }
  for (const [packageName, range] of Object.entries(requires.addons ?? {})) {
    const minimum = minimumOf(range)
    const have = running.addons[packageName] ?? null
    if (minimum !== null && !meets(have, minimum)) {
      unmet.push({ kind: 'addon-too-old', packageName, required: minimum, running: have })
    }
  }
  // A wrapper minimum binds only the shell it names. A node with no wrapper of
  // that kind (a bare process, an unidentified shell) has nothing to compare.
  for (const kind of ['desktop', 'image'] as const) {
    const range = requires.wrapper?.[kind]
    const minimum = range === undefined ? null : minimumOf(range)
    if (minimum === null || running.wrapper?.kind !== kind) continue
    if (!meets(running.wrapper.version, minimum)) {
      unmet.push({
        kind: 'wrapper-too-old',
        wrapper: kind,
        required: minimum,
        running: running.wrapper.version,
      })
    }
  }
  return unmet
}

/** One line, naming both versions — the text an operator reads. */
export function describeUnmet(unmet: UnmetRequirement): string {
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
