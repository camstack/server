/**
 * Installs the boot installer REFUSED to make (planning#447, D989).
 *
 * The installer runs before any service exists, so it cannot raise an alert.
 * It records what it held back here; the hub's boot, once the alerts provider
 * is up, reads the list and raises one alert per package. The list lives in the
 * process: it describes this boot only.
 */
export type HeldInstallCode = 'no-compatible-version' | 'registry-unreadable' | 'requirements-unmet'

export interface HeldInstall {
  readonly packageName: string
  /** What was asked for (`latest`, or a version). */
  readonly spec: string
  readonly code: HeldInstallCode
  /** One line naming the versions on both sides, or why the read failed. */
  readonly reason: string
  readonly serverVersion: string | null
}

const held = new Map<string, HeldInstall>()

export function recordHeldInstall(entry: HeldInstall): void {
  held.set(entry.packageName, entry)
}

export function clearHeldInstall(packageName: string): void {
  held.delete(packageName)
}

export function listHeldInstalls(): readonly HeldInstall[] {
  return [...held.values()]
}
