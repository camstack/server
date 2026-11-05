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
