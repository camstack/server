/**
 * Post-boot convergence to ONE copy per node — [D45](../../../docs/decisions/adr-0045.md),
 * task 32.
 *
 * Operator decisions, 2026-08-13:
 *
 * - the SYSTEM seed stays in the image, as the first-boot and fallback source
 *   (*"teniamo gli addons di sistema nell'immagine per il primo boot, da usare
 *   in caso di fallback"* [we keep the system addons in the image for the first boot, to be used in case of fallback]);
 * - once a node **has booted correctly**, the redundant DATA-side copies are
 *   removed — the legacy `<dataDir>/framework` tree and any host-provided
 *   package sitting under the addon root;
 * - the end state is one version of everything per node, and an agent is
 *   identical to a hub.
 *
 * The removal is the easy half. The dangerous half is WHEN, because every copy
 * this deletes is one that something could still be resolving:
 *
 * | Situation | Why cleaning would brick the node |
 * | --- | --- |
 * | BAKED mode (no `<dataDir>/server-root/current`) | the node is running FROM the fallback tree |
 * | `@camstack/system` resolved outside the active closure | the copy being deleted may be the one in memory |
 * | the tree is still on `NODE_PATH` | a live resolution path, whatever the mode says |
 * | boot not confirmed healthy | the copies are the recovery path, needed exactly now |
 *
 * So the plan is gated four ways, the executor refuses a blocked plan a second
 * time, and a refusal is LOUD — a sweep that quietly did nothing is
 * indistinguishable from a node that was already clean.
 *
 * Removal is rename-then-delete, the pattern `evictInstallDir` already uses on
 * this FUSE mount: the rename is what ends the shadowing and it succeeds with
 * inodes still open; the delete is best-effort. A copy that could not even be
 * renamed is REPORTED, never swallowed.
 *
 * Pure planning + an injected filesystem, so the whole thing is testable
 * against a described layout rather than a real disk.
 */

/** What kind of redundant copy this is. */
export type CleanupKind =
  /** The legacy `<dataDir>/framework` tree — inert in data-root mode (D45). */
  | 'legacy-framework-tree'
  /** A host-provided package under the addon root — it WINS over the closure (D15/D107). */
  | 'addon-root-closure-copy'

/** One redundant copy, as found on disk. */
export interface CleanupCandidate {
  readonly kind: CleanupKind
  readonly path: string
  /** Package name for an addon-root copy; `null` for a whole tree. */
  readonly pkg: string | null
  readonly version: string | null
}

/** A copy that was NOT removed, and the reason a reader needs. */
export interface KeptCandidate {
  readonly candidate: CleanupCandidate
  readonly reason: string
}

export interface CleanupInput {
  /** `CAMSTACK_SERVER_ACTIVE_ROOT` — `null` in baked mode. */
  readonly activeRoot: string | null
  /** Where `require.resolve('@camstack/system')` actually landed this boot. */
  readonly closureResolvedFrom: string | null
  /** Has this boot been confirmed healthy by the role's own boot confirmation? */
  readonly bootHealthy: boolean
  /** The effective `NODE_PATH` entries, after the launcher finished extending it. */
  readonly nodePathEntries: readonly string[]
  readonly candidates: readonly CleanupCandidate[]
}

export interface CleanupPlan {
  readonly remove: readonly CleanupCandidate[]
  readonly keep: readonly KeptCandidate[]
  /** True when NOTHING may be removed this boot — a node-wide gate, not a per-copy one. */
  readonly blocked: boolean
  readonly blockedReason: string | null
}

/** Image trees. The fallback source lives here and is never data-side. */
const IMAGE_PREFIX = '/opt/'

/**
 * Decide what may be removed. Pure.
 *
 * The node-wide gates come first and are absolute: a blocked plan removes
 * nothing at all, whatever the individual candidates look like.
 */
export function planSingleCopyCleanup(input: CleanupInput): CleanupPlan {
  const blockedReason = nodeWideBlock(input)
  if (blockedReason !== null) {
    return {
      remove: [],
      keep: input.candidates.map((candidate) => ({ candidate, reason: blockedReason })),
      blocked: true,
      blockedReason,
    }
  }

  const remove: CleanupCandidate[] = []
  const keep: KeptCandidate[] = []
  for (const candidate of input.candidates) {
    const refusal = perCandidateRefusal(candidate, input)
    if (refusal === null) remove.push(candidate)
    else keep.push({ candidate, reason: refusal })
  }
  return { remove, keep, blocked: false, blockedReason: null }
}

/** The reasons NOTHING may be removed this boot. */
function nodeWideBlock(input: CleanupInput): string | null {
  if (!input.bootHealthy) {
    return 'this boot is not confirmed healthy — the redundant copies are the recovery path and stay'
  }
  if (input.activeRoot === null) {
    return 'baked mode: there is no active closure, so the node is running FROM the fallback tree'
  }
  if (input.closureResolvedFrom === null) {
    return 'the process resolved no @camstack/system at all — nothing here is safe to remove'
  }
  if (!isInside(input.closureResolvedFrom, input.activeRoot)) {
    return (
      `@camstack/system resolved from ${input.closureResolvedFrom}, which is OUTSIDE the active ` +
      'closure — the copy being removed could be the one in memory'
    )
  }
  return null
}

/** Why this ONE copy stays, or `null` when it may go. */
function perCandidateRefusal(candidate: CleanupCandidate, input: CleanupInput): string | null {
  if (input.activeRoot !== null && isInside(candidate.path, input.activeRoot)) {
    return 'inside the active closure — this is the copy that runs, not a redundant one'
  }
  if (candidate.path.startsWith(IMAGE_PREFIX)) {
    return 'an image tree — the operator keeps it as the first-boot and fallback source'
  }
  const onNodePath = input.nodePathEntries.some(
    (entry) => entry === candidate.path || isInside(entry, candidate.path),
  )
  if (onNodePath) {
    return 'still on NODE_PATH — a live resolution path, whatever the boot mode says'
  }
  return null
}

/** Is `child` the same path as `parent`, or under it? Separator-aware. */
function isInside(child: string, parent: string): boolean {
  const normalise = (p: string): string => (p.endsWith('/') ? p.slice(0, -1) : p)
  const c = normalise(child)
  const p = normalise(parent)
  return c === p || c.startsWith(`${p}/`)
}

/** The three filesystem operations the sweep needs, injected so it stays testable. */
export interface CleanupFs {
  exists(path: string): boolean
  rename(from: string, to: string): void | Promise<void>
  remove(path: string): void | Promise<void>
}

export interface CleanupResult {
  /** Paths that no longer shadow anything — renamed aside, delete best-effort. */
  readonly removed: readonly string[]
  /** Paths still exactly where they were. The sweep says so; silence would not. */
  readonly failed: readonly string[]
  /** True when a blocked plan was handed to the executor and refused. */
  readonly refused: boolean
}

/**
 * Carry out a plan. Never throws: a cleanup that fails is a node with an extra
 * directory, and a cleanup that ends a process is an outage.
 *
 * The blocked check is repeated here on purpose. `planSingleCopyCleanup` is the
 * only intended producer, but a hand-assembled plan must not be able to walk
 * past the one gate that keeps this from running at the wrong moment.
 */
export async function executeSingleCopyCleanup(
  plan: CleanupPlan,
  fs: CleanupFs,
  log: (line: string) => void,
): Promise<CleanupResult> {
  if (plan.blocked) {
    log(`single-copy cleanup REFUSED — ${plan.blockedReason ?? 'blocked'}`)
    return { removed: [], failed: [], refused: true }
  }

  const removed: string[] = []
  const failed: string[] = []
  for (const candidate of plan.remove) {
    if (!fs.exists(candidate.path)) continue
    const label = `${candidate.pkg ?? candidate.kind} ${candidate.version ?? '<unknown version>'}`
    const aside = `${candidate.path}.removing-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try {
      await fs.rename(candidate.path, aside)
    } catch (err) {
      failed.push(candidate.path)
      log(`single-copy cleanup — could NOT remove ${candidate.path} (${label}): ${errMsg(err)}`)
      continue
    }
    // Past this line the copy can no longer be resolved by anything, which is
    // the whole point; the bytes are a separate, best-effort concern.
    removed.push(candidate.path)
    log(`single-copy cleanup — removed ${candidate.path} (${label})`)
    try {
      await fs.remove(aside)
    } catch (err) {
      log(`single-copy cleanup — ${aside} still on disk (held open?): ${errMsg(err)}`)
    }
  }
  return { removed, failed, refused: false }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The report. Always says how many copies it looked at, so a boot that removed
 * nothing is distinguishable from a boot where the sweep never ran — and a
 * BLOCKED sweep names every copy it left behind, because those are exactly the
 * ones an operator would otherwise believe were gone.
 */
export function formatCleanupPlan(plan: CleanupPlan): readonly string[] {
  const lines: string[] = []
  if (plan.blocked) {
    lines.push(
      `single-copy cleanup blocked — ${plan.blockedReason ?? 'unknown reason'}; ` +
        `${plan.keep.length} copy(ies) kept`,
    )
  } else {
    lines.push(`single-copy cleanup — ${plan.remove.length} copy(ies) to remove`)
  }
  for (const c of plan.remove) {
    lines.push(`  remove ${c.path} — ${c.pkg ?? c.kind} ${c.version ?? '<unknown version>'}`)
  }
  for (const k of plan.keep) {
    lines.push(
      `  keep   ${k.candidate.path} — ${k.candidate.pkg ?? k.candidate.kind} ` +
        `${k.candidate.version ?? '<unknown version>'}: ${k.reason}`,
    )
  }
  return lines
}

/**
 * The host-provided packages the closure carries. A copy of any of these under
 * the addon root WINS over the closure and is never refreshed — the shape that
 * left both agents 17 versions behind ([D107](../../../docs/decisions/adr-0107.md)),
 * and the reason `<dataDir>/addons/@camstack/system` is on the agent's disk at
 * 1.2.78 while it runs a newer closure.
 */
export const CLOSURE_PROVIDED_PACKAGES: readonly string[] = [
  '@camstack/system',
  '@camstack/types',
  '@camstack/sdk',
  '@camstack/ui-library',
]

export interface DiscoveryInput {
  readonly dataDir: string
  /** `CAMSTACK_ADDONS_DIR`, i.e. the ONE directory the loader reads. */
  readonly addonRoot: string
  /**
   * Does the running closure actually resolve this package? Only then is a copy
   * under the addon root redundant. The inverse case is the one that made a
   * fresh deployment unbootable ("No addon provides required infrastructure
   * capability storage-provider") — there, the copy is the only one there is.
   */
  readonly closureProvides: (pkg: string) => boolean
}

/** The two reads discovery needs. */
export interface DiscoveryFs {
  exists(path: string): boolean
  readVersion(packageDir: string): string | null
}

/**
 * Every redundant DATA-side copy on this node, in removal order: the legacy
 * framework tree first, then the host-provided packages under the addon root.
 *
 * A copy whose `package.json` will not parse is still reported, with a null
 * version — dropping it would under-report exactly the kind that has been
 * sitting somewhere since an interrupted install.
 */
export function discoverRedundantCopies(
  input: DiscoveryInput,
  fs: DiscoveryFs,
): readonly CleanupCandidate[] {
  const found: CleanupCandidate[] = []

  const legacyFramework = `${trimSlash(input.dataDir)}/framework`
  if (fs.exists(legacyFramework)) {
    found.push({
      kind: 'legacy-framework-tree',
      path: legacyFramework,
      pkg: null,
      version: fs.readVersion(`${legacyFramework}/node_modules/@camstack/system`),
    })
  }

  for (const pkg of CLOSURE_PROVIDED_PACKAGES) {
    if (!input.closureProvides(pkg)) continue
    const dir = `${trimSlash(input.addonRoot)}/${pkg}`
    if (!fs.exists(dir)) continue
    found.push({
      kind: 'addon-root-closure-copy',
      path: dir,
      pkg,
      version: fs.readVersion(dir),
    })
  }

  return found
}

function trimSlash(p: string): string {
  return p.endsWith('/') ? p.slice(0, -1) : p
}

/**
 * The kill switch. Default ON — the operator asked for convergence to one copy
 * — but a destructive sweep that cannot be turned off from the outside is one
 * an operator has to edit code to stop. `CAMSTACK_SINGLE_COPY_CLEANUP=off`
 * (or `0` / `false`) leaves every copy where it is, and the boot says so.
 */
export function isCleanupEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = env['CAMSTACK_SINGLE_COPY_CLEANUP']?.trim().toLowerCase()
  return raw !== 'off' && raw !== '0' && raw !== 'false'
}
