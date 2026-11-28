/**
 * Bring the running Home Connect managers in line with the enabled integrations:
 *
 * - signed in       -> upsert (a changed connection is applied to the running manager);
 * - signed out      -> (no token on the record, or no record) the manager stops and the devices
 *                      go offline; the integration still exists, so its devices are KEPT;
 * - locked keychain -> left as it is: stored, not absent (D49);
 * - incomplete      -> (a token that is there but the account does not parse) logged with its
 *                      gap and left as it is: a settings gap is not a sign out, nor a deletion;
 * - gone / disabled -> the manager stops and the caller drops the devices that belonged to it.
 *
 * "Gone" is judged over EVERY id the addon still holds something for — a running manager, an
 * instance record, a device — not only the running managers: a signed-out integration has no
 * manager, and its devices must still go when it is deleted.
 */
import { errMsg, type IScopedLogger } from '@dominevo/types'
import {
  appliancesWithoutCredential,
  connectionFromSettings,
  homeConnectSettingsGap,
  logHomeConnectSettingsGap,
} from './config.js'
import type { HomeConnectClientRegistry } from './home-connect-client-registry.js'
import type { HomeConnectStored } from './home-connect-instances.js'

export interface HomeConnectIntegrationRef {
  readonly id: string
  readonly name: string
}

export interface HomeConnectReconcileDeps {
  readonly listEnabled: () => Promise<readonly HomeConnectIntegrationRef[]>
  /** Every integration id the addon holds something for: instance records and devices. */
  readonly knownIds: () => Promise<readonly string[]>
  /** The record, resolved; null when there is none. */
  readonly storedOf: (integrationId: string) => Promise<HomeConnectStored | null>
  readonly registry: Pick<
    HomeConnectClientRegistry,
    'upsert' | 'remove' | 'retain' | 'list' | 'has' | 'getInfo'
  >
  /** The integration has no sign-in: its devices are offline. */
  readonly onSignedOut: (integrationId: string) => void
  /** The integration is gone: forget its devices. */
  readonly onVanished: (integrationId: string) => Promise<void>
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
}

export async function reconcileHomeConnectIntegrations(
  deps: HomeConnectReconcileDeps,
): Promise<void> {
  const enabled = await deps.listEnabled()
  const present = new Set(enabled.map((integration) => integration.id))
  for (const integration of enabled) {
    await reconcileOne(deps, integration)
  }
  const known = new Set([...deps.registry.list(), ...(await deps.knownIds())])
  const vanished = [...known].filter((id) => !present.has(id))
  await deps.registry.retain(present)
  for (const integrationId of vanished) await deps.onVanished(integrationId)
}

async function reconcileOne(
  deps: HomeConnectReconcileDeps,
  integration: HomeConnectIntegrationRef,
): Promise<void> {
  const tags = { integrationId: integration.id }
  try {
    const stored = await deps.storedOf(integration.id)
    if (stored !== null && stored.locked) {
      deps.logger.warn('Home Connect reconcile skipped: the keychain is locked', { tags })
      return
    }
    const settings = stored?.settings ?? {}
    const connection = connectionFromSettings(settings)
    if (connection === null) {
      if (stored !== null && homeConnectSettingsGap(settings) !== 'token-missing') {
        logHomeConnectSettingsGap(deps.logger, integration.id, settings)
        return
      }
      await stopSignedOut(deps, integration.id)
      return
    }
    for (const haId of appliancesWithoutCredential(settings)) {
      deps.logger.warn('Home Connect appliance has no usable pairing key — cannot connect to it', {
        tags,
        meta: { haId },
      })
    }
    await deps.registry.upsert(integration.id, integration.name, connection)
    const applianceCount = deps.registry.getInfo(integration.id)?.info['applianceCount']
    deps.logger.info('Home Connect integration reconciled', {
      tags,
      meta: { applianceCount: typeof applianceCount === 'number' ? applianceCount : 0 },
    })
  } catch (err) {
    deps.logger.warn('Home Connect reconcile failed for integration', {
      tags,
      meta: { error: errMsg(err) },
    })
  }
}

async function stopSignedOut(deps: HomeConnectReconcileDeps, integrationId: string): Promise<void> {
  if (deps.registry.has(integrationId)) {
    await deps.registry.remove(integrationId)
    deps.logger.info('Home Connect integration has no sign-in — stopped, devices offline', {
      tags: { integrationId },
    })
  }
  deps.onSignedOut(integrationId)
}
