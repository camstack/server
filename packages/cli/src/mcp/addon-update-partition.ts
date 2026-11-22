/**
 * An addon update list never offers an older version over a newer dev build (D942 follow-up).
 */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/**
 * True when `installed` is a prerelease build (a dev closure, `1.2.942-dev.<epoch>`)
 * whose base version is above `target`: an older registry version must never be
 * offered over it. A plain release that moved down is not this case.
 */
export function installedIsNewerDevBuild(installed: string, target: string): boolean {
  const i = SEMVER.exec(installed.trim())
  const t = SEMVER.exec(target.trim())
  if (!i || !t || i[4] === undefined) return false
  for (let k = 1; k <= 3; k += 1) {
    const a = Number(i[k])
    const b = Number(t[k])
    if (a !== b) return a > b
  }
  return false
}

export const INSTALLED_NEWER_NOTE = 'installed is newer (dev build); not an update'

export interface InstalledNewer {
  readonly name: string
  readonly installed: string
  readonly registry: string
  readonly note: typeof INSTALLED_NEWER_NOTE
}

/** Split a hub's addon update list into real updates and installs that are ahead of the registry. */
export function partitionAddonUpdates<
  T extends {
    readonly name: string
    readonly currentVersion: string
    readonly latestVersion: string
  },
>(
  updates: readonly T[],
): { readonly offer: readonly T[]; readonly installedNewer: readonly InstalledNewer[] } {
  const offer: T[] = []
  const installedNewer: InstalledNewer[] = []
  for (const u of updates) {
    if (installedIsNewerDevBuild(u.currentVersion, u.latestVersion)) {
      installedNewer.push({
        name: u.name,
        installed: u.currentVersion,
        registry: u.latestVersion,
        note: INSTALLED_NEWER_NOTE,
      })
    } else offer.push(u)
  }
  return { offer, installedNewer }
}
