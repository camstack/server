/**
 * The post-swap required-addon update (planning#447, D989).
 *
 * A server closure declares the oldest addon packages it works with
 * (`camstack.requires.addons`). After the swap the hub holds back an addon below
 * that minimum (`core/addon/hub-spawn-gate.ts`) so it cannot crash-loop; this
 * job is what brings it current. It runs on every boot, whether or not the
 * operator enabled auto-update: the minimum is a fact the server needs, not a
 * preference. Agents follow by the registration reconcile (D840), never from
 * here.
 *
 * A failed update raises ONE alert per package and the boot goes on: the held
 * addon stays unspawned and logged, the rest of the node is up. A package that
 * recovers (a later boot succeeds) resolves its alert.
 */
import type { Alert, IScopedLogger } from '@camstack/types'
import { compareVersions, errMsg, minimumOf } from '@camstack/types'

export const REQUIRED_ADDON_UPDATE_CATEGORY = 'addon.required-update-failed'

/** The slice of the `alerts` provider this job needs. */
export interface RequiredAddonAlertsPort {
  emit(alert: Alert): Promise<unknown>
  update(input: { readonly alertId: string; readonly patch: Partial<Alert> }): Promise<unknown>
  /** Optional: lets a boot resolve the held-install alert of a package a later boot installed. */
  list?(input?: { readonly limit?: number }): Promise<readonly Alert[]>
}

/** What `AddonPackageService.updatePackage` answers, narrowed to what the job reads. */
export interface RequiredAddonUpdateOutcome {
  readonly success: boolean
  readonly error?: string
}

export interface RequiredAddonUpdateDeps {
  /** What the running server requires: package name -> `>=X.Y.Z`. */
  readonly minimums: Readonly<Record<string, string>>
  /** Installed package versions; `null` is an unreadable copy. */
  readonly installed: () => Readonly<Record<string, string | null>>
  readonly updatePackage: (name: string) => Promise<RequiredAddonUpdateOutcome>
  readonly getAlerts: () => RequiredAddonAlertsPort | undefined
  readonly logger: IScopedLogger
  readonly now?: () => number
}

export interface RequiredAddonUpdateReport {
  readonly updated: readonly string[]
  readonly failed: readonly {
    readonly name: string
    readonly reason: string
  }[]
}

export function requiredAddonAlertId(packageName: string): string {
  return `required-addon-update:${packageName}`
}

/** Packages installed below their minimum. An unreadable copy is below (a failed read is not a pass). */
export function addonsBelowMinimum(
  minimums: Readonly<Record<string, string>>,
  installed: Readonly<Record<string, string | null>>,
): readonly {
  readonly name: string
  readonly installed: string | null
  readonly minimum: string
}[] {
  const below: { name: string; installed: string | null; minimum: string }[] = []
  for (const [name, range] of Object.entries(minimums)) {
    const minimum = minimumOf(range)
    if (minimum === null) continue
    // A package that is not installed is not stale: nothing runs, nothing to update.
    if (!(name in installed)) continue
    const have = installed[name] ?? null
    if (have === null || compareVersions(have, minimum) < 0) {
      below.push({ name, installed: have, minimum })
    }
  }
  return below
}

function failureAlert(name: string, reason: string, now: number): Alert {
  return {
    id: requiredAddonAlertId(name),
    category: REQUIRED_ADDON_UPDATE_CATEGORY,
    severity: 'critical',
    title: `${name} could not be updated`,
    message: `The running server needs a newer ${name} and updating it failed (${reason}). The addon stays stopped until an update succeeds; the rest of the node is running.`,
    status: 'active',
    read: false,
    createdAt: now,
    updatedAt: now,
    source: { type: 'addon', id: name },
    metadata: { packageName: name },
  }
}

export async function runRequiredAddonUpdates(
  deps: RequiredAddonUpdateDeps,
): Promise<RequiredAddonUpdateReport> {
  const now = deps.now ?? Date.now
  const below = addonsBelowMinimum(deps.minimums, deps.installed())
  const updated: string[] = []
  const failed: { name: string; reason: string }[] = []
  for (const item of below) {
    deps.logger.info('Updating an addon the running server requires', {
      meta: {
        name: item.name,
        installed: item.installed,
        minimum: item.minimum,
      },
    })
    const outcome = await deps.updatePackage(item.name).catch(
      (error: unknown): RequiredAddonUpdateOutcome => ({
        success: false,
        error: errMsg(error),
      }),
    )
    if (outcome.success) {
      updated.push(item.name)
      await resolveAlert(deps, item.name)
      continue
    }
    const reason = outcome.error ?? 'the update did not succeed'
    failed.push({ name: item.name, reason })
    deps.logger.warn('Required addon update failed — the addon stays held back', {
      meta: {
        name: item.name,
        installed: item.installed,
        minimum: item.minimum,
        reason,
      },
    })
    await raiseAlert(deps, item.name, reason, now())
  }
  return { updated, failed }
}

async function raiseAlert(
  deps: RequiredAddonUpdateDeps,
  name: string,
  reason: string,
  now: number,
): Promise<void> {
  const alerts = deps.getAlerts()
  if (alerts === undefined) {
    deps.logger.warn('Required addon update alert skipped — alerts capability missing', {
      meta: { name },
    })
    return
  }
  try {
    await alerts.emit(failureAlert(name, reason, now))
  } catch (error: unknown) {
    deps.logger.warn('Required addon update alert emit failed', {
      meta: { name, error: errMsg(error) },
    })
  }
}

async function resolveAlert(deps: RequiredAddonUpdateDeps, name: string): Promise<void> {
  const alerts = deps.getAlerts()
  if (alerts === undefined) return
  try {
    await alerts.update({
      alertId: requiredAddonAlertId(name),
      patch: { status: 'completed', read: true },
    })
  } catch (error: unknown) {
    deps.logger.debug('Required addon alert resolve skipped', {
      meta: { name, error: errMsg(error) },
    })
  }
}

export function heldInstallAlertId(packageName: string): string {
  return `install-held:${packageName}`
}

/** One install the boot installer refused (`HeldInstall` of `@camstack/server/system`). */
export interface HeldInstallReport {
  readonly packageName: string
  readonly spec: string
  readonly code: 'no-compatible-version' | 'registry-unreadable' | 'requirements-unmet'
  readonly reason: string
}

export const HELD_INSTALL_CATEGORY = 'addon.install-held'

/**
 * The boot installer cannot raise an alert (it runs before any service); the
 * installs it held back are raised here, once the alerts provider is up.
 */
export async function raiseHeldInstallAlerts(input: {
  readonly held: readonly HeldInstallReport[]
  readonly getAlerts: () => RequiredAddonAlertsPort | undefined
  readonly logger: IScopedLogger
  readonly now?: () => number
}): Promise<void> {
  const alerts = input.getAlerts()
  const now = (input.now ?? Date.now)()
  if (alerts !== undefined) await resolveInstalledHeldAlerts(alerts, input.held, input.logger)
  if (input.held.length === 0) return
  for (const h of input.held) {
    if (alerts === undefined) {
      input.logger.warn('A held install could not be raised — alerts capability missing', {
        meta: { name: h.packageName, code: h.code, reason: h.reason },
      })
      continue
    }
    const alert: Alert = {
      id: heldInstallAlertId(h.packageName),
      category: HELD_INSTALL_CATEGORY,
      severity: 'critical',
      title: `${h.packageName} was not installed`,
      message: `The boot installer did not install ${h.packageName} (${h.spec}): ${h.reason}. The addon is missing until a compatible version can be installed.`,
      status: 'active',
      read: false,
      createdAt: now,
      updatedAt: now,
      source: { type: 'addon', id: h.packageName },
      metadata: { packageName: h.packageName, code: h.code },
    }
    try {
      await alerts.emit(alert)
    } catch (error: unknown) {
      input.logger.warn('Held install alert emit failed', {
        meta: { name: h.packageName, error: errMsg(error) },
      })
    }
  }
}

/**
 * The held list lives in the process, so a boot that installs the package starts with
 * it empty while the alert of the earlier boot is still active: resolve every active
 * held-install alert whose package this boot did not hold.
 */
async function resolveInstalledHeldAlerts(
  alerts: RequiredAddonAlertsPort,
  held: readonly HeldInstallReport[],
  logger: IScopedLogger,
): Promise<void> {
  if (alerts.list === undefined) return
  const stillHeld = new Set(held.map((h) => h.packageName))
  try {
    const existing = await alerts.list({ limit: 500 })
    for (const alert of existing) {
      if (alert.category !== HELD_INSTALL_CATEGORY || alert.status !== 'active') continue
      const name = alert.source?.id
      if (name === undefined || stillHeld.has(name)) continue
      await alerts.update({
        alertId: alert.id,
        patch: { status: 'completed', read: true },
      })
    }
  } catch (error: unknown) {
    logger.warn('Held install alert resolve failed', {
      meta: { error: errMsg(error) },
    })
  }
}
