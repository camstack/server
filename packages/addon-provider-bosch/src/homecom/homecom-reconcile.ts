/**
 * Bring the running HomeCom managers in line with the enabled integrations:
 *
 * - signed in       -> upsert (a changed connection is applied to the running manager);
 * - signed out      -> the manager stops and the devices go offline; the integration still
 *                      exists, so its devices and its session alert are KEPT;
 * - unreadable      -> left as it is (a locked keychain is not a sign out, nor a deletion);
 * - gone / disabled -> the manager stops and the caller drops what belonged to it.
 *
 * "Gone" is judged over EVERY id the addon still holds something for — a running manager, an
 * instance record, a device — not only the running managers: an integration that was signed out
 * or unreadable has no manager, and its devices and alert must still go when it is deleted.
 */
import { errMsg, type IScopedLogger } from '@dominevo/types'
import type { HomeComConfig } from './config.js'
import type { HomeComClientRegistry } from './homecom-client-registry.js'

export interface HomeComIntegrationRef {
  readonly id: string
  readonly name: string
}

export interface HomeComReconcileDeps {
  readonly listEnabled: () => Promise<readonly HomeComIntegrationRef[]>
  /** Every integration id the addon holds something for: instance records and devices. */
  readonly knownIds: () => Promise<readonly string[]>
  /** Null when the instance holds no sign-in; throws when its secrets cannot be read. */
  readonly connectionOf: (integrationId: string) => Promise<HomeComConfig | null>
  readonly registry: Pick<HomeComClientRegistry, 'upsert' | 'remove' | 'retain' | 'list' | 'has'>
  readonly onNamed: (integrationId: string, name: string) => void
  /** The integration has no sign-in: its devices are offline. */
  readonly onSignedOut: (integrationId: string) => void
  /** The integration is gone: forget its alert and its devices. */
  readonly onVanished: (integrationId: string) => Promise<void>
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
}

export async function reconcileHomeComIntegrations(deps: HomeComReconcileDeps): Promise<void> {
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
  deps: HomeComReconcileDeps,
  integration: HomeComIntegrationRef,
): Promise<void> {
  const tags = { integrationId: integration.id }
  try {
    const connection = await deps.connectionOf(integration.id)
    deps.onNamed(integration.id, integration.name)
    if (connection === null) {
      if (deps.registry.has(integration.id)) {
        await deps.registry.remove(integration.id)
        deps.logger.info('HomeCom integration has no sign-in — stopped, devices offline', {
          tags,
        })
      }
      deps.onSignedOut(integration.id)
      return
    }
    await deps.registry.upsert(integration.id, integration.name, connection)
  } catch (err) {
    deps.logger.warn('HomeCom reconcile failed for integration', {
      tags,
      meta: { error: errMsg(err) },
    })
  }
}
