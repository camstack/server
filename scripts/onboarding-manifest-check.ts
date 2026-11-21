/**
 * The pure half of `check-onboarding-manifest.ts`: what the bundled onboarding
 * manifest (D1077) claims about THIS repository, checked against facts the
 * caller read from it. No file access here, so the spec can feed it worlds.
 */
import {
  isManualText,
  type OnboardingManifest,
  type UiLocation,
} from '../packages/cli/src/onboarding/manifest-schema.ts'

/** What the repository really has, read by the caller. */
export interface RepositoryFacts {
  /** Route patterns the admin UI mounts, plus the pages addons declare. */
  readonly routes: ReadonlySet<string>
  /** Every English string the admin UI can print. */
  readonly labels: ReadonlySet<string>
  /** Addon id → the workspace package that declares it. */
  readonly addonPackages: ReadonlyMap<string, string>
}

export interface UiClaim {
  readonly where: string
  readonly ui: UiLocation
}

export function uiClaims(manifest: OnboardingManifest): readonly UiClaim[] {
  const fromSteps = manifest.steps.flatMap((step) =>
    step.actions.flatMap((action) =>
      isManualText(action.manual) && action.manual.ui !== undefined
        ? [
            {
              where: `step ${step.id} / action ${action.id}`,
              ui: action.manual.ui,
            },
          ]
        : [],
    ),
  )
  const fromAddons = manifest.coreAddons.flatMap((group) =>
    group.ui === undefined ? [] : [{ where: `core addon group ${group.id}`, ui: group.ui }],
  )
  return [...fromSteps, ...fromAddons]
}

/** Every claim of the manifest this repository contradicts, one line each. */
export function manifestProblems(
  manifest: OnboardingManifest,
  facts: RepositoryFacts,
): readonly string[] {
  const ui = uiClaims(manifest).flatMap(({ where, ui: location }) => [
    ...(facts.routes.has(location.route)
      ? []
      : [`${where}: the admin UI has no route ${location.route}`]),
    ...location.nav
      .filter((label) => !facts.labels.has(label))
      .map((label) => `${where}: the admin UI prints no label "${label}"`),
  ])
  const addons = manifest.coreAddons.flatMap((group) =>
    group.addons.flatMap((addon) => {
      const real = facts.addonPackages.get(addon.id)
      if (real === undefined)
        return [`core addon group ${group.id}: no addon has the id ${addon.id}`]
      return real === addon.package
        ? []
        : [
            `core addon group ${group.id}: ${addon.id} ships in ${real}, the manifest says ${addon.package}`,
          ]
    }),
  )
  return [...ui, ...addons]
}

export type SnapshotVerdict =
  | { readonly kind: 'same' }
  | { readonly kind: 'differs'; readonly detail: string }

const canonical = (json: string): string => JSON.stringify(JSON.parse(json))

/**
 * The bundled snapshot against the document a docs checkout would publish.
 * Compared as JSON values, not bytes: this repository's formatter rewrites the
 * file on commit, and whitespace is not content.
 */
export function compareSnapshot(bundled: string, published: string): SnapshotVerdict {
  if (canonical(bundled) === canonical(published)) return { kind: 'same' }
  return {
    kind: 'differs',
    detail:
      'packages/cli/src/onboarding/manifest.snapshot.json is not the manifest the docs checkout publishes — run `npm run onboarding:sync`',
  }
}

export interface ManifestIdentity {
  readonly revision: number
  readonly contentHash: string
}

/**
 * The bundled snapshot against the LIVE document. The CLI prefers the higher
 * revision, so a bundle that is behind is fine; one that is AHEAD means the
 * docs were not published, and an equal revision with another hash means two
 * different documents carry one number.
 */
export function liveProblems(bundled: ManifestIdentity, live: ManifestIdentity): readonly string[] {
  if (bundled.revision > live.revision) {
    return [
      `the bundled manifest is revision ${bundled.revision}, the docs site serves ${live.revision}: publish the docs before the CLI`,
    ]
  }
  if (bundled.revision === live.revision && bundled.contentHash !== live.contentHash) {
    return [
      `revision ${bundled.revision} is ${bundled.contentHash} here and ${live.contentHash} on the docs site: one number, two documents`,
    ]
  }
  return []
}
