/**
 * What a node installs at first boot once the image stops carrying a
 * NON-system addon seed tree — [D45](../../../docs/decisions/adr-0045.md),
 * task 32.
 *
 * Operator decisions, 2026-08-12/13:
 *
 * - the docker seed stays for `@camstack/server` and the SYSTEM packages, as
 *   the first-boot fallback source; every other addon is single-copy, always,
 *   installed during the initial boot;
 * - **no pinning at all** — *"il sistema è designato per essere
 *   addons-agnostic, latest va sempre bene al primo boot"* [the system is designed to be addons-agnostic, latest is always fine at first boot]. There is no version
 *   contract between the closure and an addon, so first boot asks for `latest`
 *   and the copy that lands is the one the node keeps.
 *
 * So this module answers exactly one question per package — *fetch it, adopt
 * what is already here, or leave it to the closure* — and reports the version
 * the running closure happens to carry beside the installed one, as INFO. That
 * comparison is not a pin and never drives an action: the installed copy wins,
 * always ([D90](../../../docs/decisions/adr-0090.md)). It exists because the
 * same package having two truthful versions on one node is what task 32 is
 * about — the hub runs `addon-pipeline` 1.2.69 while its own closure carries
 * 1.2.64, and nothing said so out loud until now.
 *
 * Pure: the caller supplies the roster, what is on disk and what the closure
 * carries. It installs nothing and can never end a boot.
 */

/** What a single bootstrap package resolves to. */
export type BootstrapAction =
  /** Host-provided and resolvable from the closure — a copy would shadow it (D15). */
  | 'skip-closure-provided'
  /** A copy is already installed. It is the runtime authority; leave it alone. */
  | 'adopt-installed'
  /** Nothing on disk — fetch `latest` from the registry. */
  | 'install-npm'

/** One package, and what this node would do about it. */
export interface BootstrapDecision {
  readonly pkg: string
  readonly action: BootstrapAction
  /** The version on disk, `null` when absent or its package.json is unreadable. */
  readonly installedVersion: string | null
  /** What the running closure carries for the same package, when it carries one. */
  readonly closureVersion: string | null
  /**
   * Installed AND carried by the closure, at two different versions. INFO only:
   * one node, two true answers to "which version is this". Never an action.
   */
  readonly twoVersions: boolean
  readonly reason: string
}

export interface FirstBootPlanInput {
  /** The bootstrap roster for this role — `selectHubBootstrapPackages` / `AGENT_PACKAGES`. */
  readonly required: readonly string[]
  /** Version per package under the addon root; `null` for an unreadable package.json. */
  readonly installed: Readonly<Record<string, string | null>>
  /** Version per package inside the RUNNING closure's `node_modules`, when present. */
  readonly closureVersions: Readonly<Record<string, string | null>>
  /** Packages the running closure resolves — a copy of these must never be installed. */
  readonly closureProvided: readonly string[]
}

export interface FirstBootPlan {
  readonly decisions: readonly BootstrapDecision[]
  /** Packages that would be fetched, in roster order. Empty = an offline boot is complete. */
  readonly wouldInstall: readonly string[]
  /** Packages the node holds at a different version than its own closure. INFO. */
  readonly twoVersions: readonly string[]
  /** True when at least one package must come from the registry for this roster to be whole. */
  readonly needsRegistry: boolean
}

/** The plan. Pure; installs nothing. */
export function planFirstBootAddons(input: FirstBootPlanInput): FirstBootPlan {
  const provided = new Set(input.closureProvided)
  const decisions = input.required.map((pkg) =>
    decide(pkg, input.installed, input.closureVersions, provided),
  )
  const wouldInstall = decisions.filter((d) => d.action === 'install-npm').map((d) => d.pkg)
  return {
    decisions,
    wouldInstall,
    twoVersions: decisions.filter((d) => d.twoVersions).map((d) => d.pkg),
    needsRegistry: wouldInstall.length > 0,
  }
}

function decide(
  pkg: string,
  installed: Readonly<Record<string, string | null>>,
  closureVersions: Readonly<Record<string, string | null>>,
  closureProvided: ReadonlySet<string>,
): BootstrapDecision {
  const hasEntry = Object.hasOwn(installed, pkg)
  const version = installed[pkg] ?? null
  const closureVersion = closureVersions[pkg] ?? null

  // Host-provided and reachable: a copy under the addon root WINS over the
  // closure and nothing refreshes it — the shape that left both agents 17
  // versions behind. Same rule as `shouldSkipClosureProvidedSeed`.
  if (closureProvided.has(pkg)) {
    return {
      pkg,
      action: 'skip-closure-provided',
      installedVersion: version,
      closureVersion,
      twoVersions: false,
      reason: 'provided by the server closure — a copy here would shadow it',
    }
  }

  if (version === null) {
    return {
      pkg,
      action: 'install-npm',
      installedVersion: null,
      closureVersion,
      twoVersions: false,
      reason: hasEntry
        ? 'installed copy has an unreadable package.json — fetching latest'
        : 'absent — fetching latest, which is the whole version contract (addons-agnostic)',
    }
  }

  const twoVersions = closureVersion !== null && closureVersion !== version
  return {
    pkg,
    action: 'adopt-installed',
    installedVersion: version,
    closureVersion,
    twoVersions,
    reason: twoVersions
      ? `installed ${version}; this closure carries ${closureVersion} — the installed copy is what runs`
      : `installed ${version} — kept`,
  }
}

/** How the plan was used. `observe` means it decided nothing. */
export type PlanMode = 'observe' | 'enforce'

/**
 * The report.
 *
 * Always states the roster it checked and how much work it found, even when
 * that is none: a boot that prints nothing is indistinguishable from a boot
 * where the check did not run, and this repo has paid for that twice. In
 * `observe` the lines say so explicitly — an observe line that reads like an
 * install is worse than no line at all.
 */
export function formatFirstBootPlan(plan: FirstBootPlan, mode: PlanMode): readonly string[] {
  const header =
    `first-boot addon plan (${mode}) — ${plan.decisions.length} package(s), ` +
    `${plan.wouldInstall.length} to install`
  const lines: string[] = [
    mode === 'observe' ? `${header}; nothing was installed from this plan` : header,
  ]

  for (const d of plan.decisions) {
    const target = d.action === 'install-npm' ? '@latest' : ''
    lines.push(`  ${d.pkg}${target} — ${d.action}: ${d.reason}`)
  }

  // A closure that carries NOTHING is either a dev layout or a path that does
  // not resolve, and until 2026-09-17 those were indistinguishable: the reader
  // looked one directory up from the server package instead of three, found an
  // empty `node_modules`, and reported `twoVersions: false` for everything. Six
  // addons sat up to nineteen versions behind while this printed "0 to install"
  // and nothing else, every boot, for a month. Silence is what made it survive.
  if (plan.decisions.length > 0 && plan.decisions.every((d) => d.closureVersion === null)) {
    lines.push(
      `  the closure carries NO version for any of the ${plan.decisions.length} package(s) — ` +
        `either this is a dev layout, or the closure path does not resolve (it is ` +
        `<root>/node_modules, NOT <server>/node_modules; see closure-node-modules.ts)`,
    )
  }
  if (plan.twoVersions.length > 0) {
    lines.push(
      `  two versions on this node (installed vs this closure's own copy): ${plan.twoVersions.join(', ')} — ` +
        'INFO: the installed copy is the one that runs',
    )
  }
  if (!plan.needsRegistry) {
    lines.push('  no registry access needed — every required addon is already on disk')
  }
  return lines
}
