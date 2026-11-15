/**
 * Sign out of an EXISTING Home Connect instance, written through the instance record — the owner
 * of the tokens (keychain-backed secret fields). The record's change hook reconciles the
 * integration: a record with no token stops its manager and takes its devices offline.
 */
import { type IIntegrationInstancesProvider, SECRET_CLEAR } from '@camstack/types'
import { APPLIANCE_SECRETS_KEY } from './config.js'

/** The slice of the instances helper the sign out goes through. */
export type HomeConnectInstanceWriter = Pick<IIntegrationInstancesProvider, 'updateInstance'>

/**
 * Forget the account: the token, the refresh token and the appliance pairing keys (the sign-in
 * field's `secretKeys`) are cleared in the keychain and the account label resets. The paired
 * appliance list stays, so a sign in to the same account finds the same appliances.
 */
export async function signOutHomeConnectInstance(
  integrationId: string,
  instances: HomeConnectInstanceWriter,
): Promise<void> {
  await instances.updateInstance({
    id: integrationId,
    values: {
      token: SECRET_CLEAR,
      refresh: SECRET_CLEAR,
      [APPLIANCE_SECRETS_KEY]: SECRET_CLEAR,
      accountLabel: '',
    },
  })
}
