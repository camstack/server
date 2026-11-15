/**
 * Sign in / sign out of an EXISTING HomeCom instance, written through the instance record — the
 * owner of the tokens (keychain-backed secret fields). The record's change hook reconciles the
 * integration: new tokens are applied to the running manager, cleared ones stop it.
 */
import { SECRET_CLEAR, type IIntegrationInstancesProvider } from '@camstack/types'
import type { HomeComFinishedSignIn } from './homecom-sign-in.js'

/** The slice of the instances helper these writes go through. */
export type HomeComInstanceWriter = Pick<IIntegrationInstancesProvider, 'updateInstance'>

/** Forget the account: the three secrets are cleared in the keychain, the account labels reset. */
export async function signOutHomeComInstance(
  integrationId: string,
  instances: HomeComInstanceWriter,
): Promise<void> {
  await instances.updateInstance({
    id: integrationId,
    values: {
      token: SECRET_CLEAR,
      refresh: SECRET_CLEAR,
      username: SECRET_CLEAR,
      accountLabel: '',
      gatewayCount: 0,
    },
  })
}

/**
 * Store a finished sign-in on the instance. The gateway (and its brand / region) is written only
 * when the sign-in settled on one: a choice still open keeps the stored gateway.
 */
export async function storeHomeComSignIn(
  integrationId: string,
  finished: HomeComFinishedSignIn,
  instances: HomeComInstanceWriter,
): Promise<void> {
  await instances.updateInstance({
    id: integrationId,
    values: {
      token: finished.token,
      refresh: finished.refresh,
      username: finished.username,
      accountLabel: finished.accountLabel,
      gatewayCount: finished.gatewayCount,
      ...(finished.gatewayId !== undefined ? { gatewayId: finished.gatewayId } : {}),
      ...(finished.brand !== undefined ? { brand: finished.brand } : {}),
      ...(finished.region !== undefined ? { region: finished.region } : {}),
    },
  })
}
