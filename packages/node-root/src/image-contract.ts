/**
 * image-contract — compares the node's IMMUTABLE baked seed (the Docker image
 * / desktop app bundle) against the release the deployment contract would
 * deliver today, and says so in one operator-grade sentence.
 *
 * ## The failure this exists for (2026-08-02)
 *
 * `scripts/check-deployment-templates.ts` proved every template declared
 * `ghcr.io/camstack/camstack:intel-latest` — and passed daily while the hub
 * actually ran `camstack-server:intel-1.1.74`, a 13-day-old image from a
 * repository that had been RENAMED and received no builds. A `docker pull`
 * could never have fixed it. The agent was on the right repository, pinned to
 * `intel-1.2.0`. Every existing surface was green: `runningVersion` was
 * current (applyServerUpdate swaps the data-root and NEVER touches the image),
 * so "up to date" showed on a node whose starter, entrypoint and boot seed
 * were weeks old. The declaration was right; reality was not; nothing compared
 * them.
 *
 * ## What a container can honestly see
 *
 * There is no docker socket inside the node, so the image reference itself
 * (`repo:tag`) is invisible. What IS visible is `seedVersion` — the version of
 * the baked `@camstack/server` closure, i.e. what `@latest` resolved to when
 * the image was built (Dockerfile stage 1). That is the image's fingerprint,
 * and the release workflow guarantees (scripts/ci/verify-release-npm.mjs)
 * that the contract image `intel-X.Y.Z` carries seed `X.Y.Z`. So:
 *
 *   seed vs the current release  ==  running image vs the contract image.
 *
 * The "current release" reference is the registry latest when a check has run;
 * otherwise the node's own running version — a node can never run code newer
 * than the newest release, so `seed < running` proves image staleness with no
 * network at all. When neither proves anything (`seed == running`, no check),
 * the verdict is `unknown`, NOT `in-sync`: claiming sync without evidence is
 * exactly the fake-green this module exists to kill.
 *
 * Zero-dep (bundled next to the starter); the shape it returns is
 * `ImageContractSchema` in `@camstack/types` (type-only import).
 */
import type { ImageContract } from '@camstack/types'
import { compareSemver } from './semver-compare.js'

export interface ImageContractInputs {
  /** Baked seed closure version (null in a dev workspace). */
  readonly seedVersion: string | null
  /** Registry latest from the most recent check (null = never checked). */
  readonly latestVersion: string | null
  /** Version of the code the running process actually loaded. */
  readonly runningVersion: string | null
}

/** `major.minor` of a version string, for the series comparison. */
function releaseSeries(version: string): readonly [number, number] {
  const [major, minor] = version.split('.').map((seg) => {
    const n = Number.parseInt(seg, 10)
    return Number.isNaN(n) ? 0 : n
  })
  return [major ?? 0, minor ?? 0]
}

function sameSeries(a: string, b: string): boolean {
  const [aMajor, aMinor] = releaseSeries(a)
  const [bMajor, bMinor] = releaseSeries(b)
  return aMajor === bMajor && aMinor === bMinor
}

function behindMessage(seed: string, contract: string, series: boolean): string {
  const base =
    `This node is running an image whose baked seed is @camstack/server@${seed}; ` +
    `the deployment contract currently delivers ${contract}. applyServerUpdate ` +
    'keeps the code current but NEVER updates the image — the starter, the ' +
    'entrypoint and the boot fallback are still the old copies.'
  if (!series) {
    return `${base} Recreate the container from the contract image to converge.`
  }
  return (
    `${base} The seed is a full release series behind — the shape of a pinned tag ` +
    'or an image repository that no longer receives builds, where a docker pull ' +
    "fixes nothing. Verify the container's image reference against the deployment templates."
  )
}

/**
 * Pure verdict — see the module docblock for the semantics. Computed by
 * `RootUpdateService.getServerPackageStatus` on every node role (hub + agent
 * share the one implementation, D16-style) and rendered by the Cluster page.
 */
export function assessImageContract(inputs: ImageContractInputs): ImageContract {
  const { seedVersion, latestVersion, runningVersion } = inputs

  if (seedVersion === null) {
    return {
      state: 'unknown',
      seedVersion: null,
      contractVersion: latestVersion,
      contractSource: latestVersion !== null ? 'registry' : null,
      message: 'No baked seed closure detected (dev workspace) — no image contract to compare.',
    }
  }

  const contractVersion =
    latestVersion ??
    (runningVersion !== null && compareSemver(seedVersion, runningVersion) < 0
      ? runningVersion
      : null)
  if (contractVersion === null) {
    return {
      state: 'unknown',
      seedVersion,
      contractVersion: null,
      contractSource: null,
      message:
        `This node is running an image whose baked seed is @camstack/server@${seedVersion}; ` +
        'no registry check has run yet, so the release the contract image delivers is ' +
        'unknown. Run a server-update check to verify the image against the contract.',
    }
  }
  const contractSource = latestVersion !== null ? 'registry' : 'running'

  const cmp = compareSemver(seedVersion, contractVersion)
  if (cmp === 0) {
    return {
      state: 'in-sync',
      seedVersion,
      contractVersion,
      contractSource,
      message:
        `Image seed @camstack/server@${seedVersion} matches the current release — ` +
        'this node is running the image the deployment contract names.',
    }
  }
  if (cmp > 0) {
    return {
      state: 'ahead',
      seedVersion,
      contractVersion,
      contractSource,
      message:
        `Image seed @camstack/server@${seedVersion} is NEWER than the best-known ` +
        `release ${contractVersion} — the registry check is stale or the registry ` +
        'was unreachable. Re-run a server-update check.',
    }
  }

  const series = !sameSeries(seedVersion, contractVersion)
  return {
    state: series ? 'behind-series' : 'behind-patch',
    seedVersion,
    contractVersion,
    contractSource,
    message: behindMessage(seedVersion, contractVersion, series),
  }
}
