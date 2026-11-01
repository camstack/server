/**
 * A page remote does not bundle ui-library: the host provides it. The remote
 * declares the lowest version it was built against (`requiredVersion`, stamped
 * as `>=<version>` by its build) and registers that declaration in the Module
 * Federation share scope when its entry initialises. This reads it back so
 * `AddonPageLoader` can say "this admin UI is too old" instead of mounting a
 * page into a library that lacks what it imports.
 *
 * Warn-and-run: only a declaration this file understands (`>=x.y.z`) can
 * refuse, and an unknown host version never refuses.
 */

export const UI_LIBRARY_PACKAGE = '@camstack/ui-library'

/** The part of a share-scope entry this check reads. */
interface DeclaredShare {
  readonly from?: unknown
  readonly shareConfig?: { readonly requiredVersion?: unknown }
}

export interface UiLibraryRequirementProblem {
  /** The lowest ui-library the remote declared. */
  readonly required: string
  /** The ui-library this host runs. */
  readonly host: string
}

function isDeclaredShare(value: unknown): value is DeclaredShare {
  return typeof value === 'object' && value !== null
}

const MINIMUM = /^>=\s*(\d+)\.(\d+)\.(\d+)/
const VERSION = /^(\d+)\.(\d+)\.(\d+)/

function triple(match: RegExpMatchArray | null): readonly [number, number, number] | null {
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function isOlder(
  host: readonly [number, number, number],
  required: readonly [number, number, number],
): boolean {
  for (let i = 0; i < 3; i++) {
    const h = host[i] ?? 0
    const r = required[i] ?? 0
    if (h !== r) return h < r
  }
  return false
}

/** The ui-library `requiredVersion` strings a remote registered, by its federation name. */
export function declaredUiLibraryRanges(
  shareScopeMap: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  remoteName: string,
): readonly string[] {
  const ranges: string[] = []
  for (const scope of Object.values(shareScopeMap)) {
    const byVersion = scope[UI_LIBRARY_PACKAGE]
    if (typeof byVersion !== 'object' || byVersion === null) continue
    for (const entry of Object.values(byVersion)) {
      if (!isDeclaredShare(entry) || entry.from !== remoteName) continue
      const range = entry.shareConfig?.requiredVersion
      if (typeof range === 'string') ranges.push(range)
    }
  }
  return ranges
}

/** The first declared range the host is too old for, or `null` (also when the host version is unknown). */
export function uiLibraryRequirementProblem(
  hostVersion: string | null,
  declaredRanges: readonly string[],
): UiLibraryRequirementProblem | null {
  const host = hostVersion === null ? null : triple(hostVersion.match(VERSION))
  if (host === null || hostVersion === null) return null
  for (const range of declaredRanges) {
    const required = triple(range.match(MINIMUM))
    if (required !== null && isOlder(host, required)) {
      return { required: required.join('.'), host: hostVersion }
    }
  }
  return null
}
