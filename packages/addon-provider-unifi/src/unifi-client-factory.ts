/**
 * The client a UniFi connection signs in with. Only the API key is used: it reaches the UniFi OS
 * Integration API. The username + password fields are kept on the form but not used yet — the
 * local-account (classic Network API) client is not wired (planning#581).
 */
import type {
  UnifiControllerClient,
  UnifiControllerClientFactory,
} from './unifi-client-contract.js'
import { makeUndiciFetch, type UnifiFetch, UnifiLiveClient } from './unifi-client-live.js'
import { UnifiNoCredentialError } from './unifi-errors.js'

/** Build the client factory over the given fetch transport. Throws {@link UnifiNoCredentialError}. */
export function makeUnifiClientFactory(
  fetchFor: (allowSelfSigned: boolean) => UnifiFetch,
): UnifiControllerClientFactory {
  return (input): UnifiControllerClient => {
    if (input.apiKey === '') throw new UnifiNoCredentialError()
    return new UnifiLiveClient({
      host: input.host,
      port: input.port,
      apiKey: input.apiKey,
      site: input.site,
      fetchImpl: fetchFor(input.allowSelfSigned),
    })
  }
}

/** The factory the addon wires: one live client per connection, over undici. */
export const liveUnifiClientFactory: UnifiControllerClientFactory =
  makeUnifiClientFactory(makeUndiciFetch)
