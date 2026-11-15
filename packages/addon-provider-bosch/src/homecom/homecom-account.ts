/**
 * Sign in / sign out of an EXISTING HomeCom instance, written through the instance record — the
 * owner of the tokens (keychain-backed secret fields). The record's change hook reconciles the
 * integration: new tokens are applied to the running manager, cleared ones stop it.
 */
import {
  type IIntegrationInstancesProvider,
  type RecordKindHandle,
  SECRET_CLEAR,
  type SecretFieldView,
  toSecretFieldView,
} from '@camstack/types'
import type { HomeComConnectionBody } from './homecom-instances.js'
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

/** A sign-in stored on an existing instance, as the browser may see it: no secret in clear. */
export interface HomeComStoredSignIn
  extends Omit<HomeComFinishedSignIn, 'token' | 'refresh' | 'username'> {
  readonly token: SecretFieldView | null
  readonly refresh: SecretFieldView | null
  readonly username: SecretFieldView | null
}

/**
 * The answer to a sign-in on an existing instance: the tokens are on the record now, so the form
 * gets the record's "set" views (as `hydrateSchema` hands them out) in their place — a Save that
 * follows keeps them, and the values never travel to the browser.
 */
export async function storedSignInResult(
  integrationId: string,
  finished: HomeComFinishedSignIn,
  handle: Pick<RecordKindHandle<HomeComConnectionBody>, 'get'>,
): Promise<HomeComStoredSignIn> {
  const row = await handle.get(integrationId)
  const data: Readonly<Record<string, unknown>> = row?.data ?? {}
  const { token: _token, refresh: _refresh, username: _username, ...open } = finished
  return {
    ...open,
    token: toSecretFieldView(data['token']),
    refresh: toSecretFieldView(data['refresh']),
    username: toSecretFieldView(data['username']),
  }
}
