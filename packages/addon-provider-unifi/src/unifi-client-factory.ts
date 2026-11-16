/**
 * Which credential a UniFi connection signs in with, and the client that speaks it:
 *  - an API key alone → the UniFi OS Integration API (`UnifiLiveClient`): no PoE on/off;
 *  - a local account alone → the classic Network API (`UnifiClassicClient`), on a UniFi OS
 *    console or a legacy controller;
 *  - both → `UnifiDualClient`: the API key for everything it did before, the local account for
 *    PoE on/off and the per-port readings.
 */
import type {
  UnifiControllerClient,
  UnifiControllerClientFactory,
} from './unifi-client-contract.js'
import { UnifiClassicClient } from './unifi-client-classic.js'
import { UnifiDualClient } from './unifi-client-dual.js'
import { makeUndiciFetch, type UnifiFetch, UnifiLiveClient } from './unifi-client-live.js'
import { UnifiNoCredentialError } from './unifi-errors.js'
import { makeUndiciHttp, type UnifiHttp, UnifiSession } from './unifi-session.js'

export type UnifiCredentialKind = 'api-key' | 'local-account' | 'both'

/** The credential fields of a connection. */
export interface UnifiCredentialFields {
  readonly apiKey: string
  readonly username: string
  readonly password: string
}

/** The credentials the connection signs in with, or null when it has none. */
export function unifiCredentialOf(fields: UnifiCredentialFields): UnifiCredentialKind | null {
  const account = fields.username !== '' && fields.password !== ''
  if (fields.apiKey !== '') return account ? 'both' : 'api-key'
  return account ? 'local-account' : null
}

/** The transports a client is built over; production uses undici. */
export interface UnifiTransports {
  readonly fetchFor: (allowSelfSigned: boolean) => UnifiFetch
  readonly httpFor: (allowSelfSigned: boolean) => UnifiHttp
}

const undiciTransports: UnifiTransports = {
  fetchFor: makeUndiciFetch,
  httpFor: makeUndiciHttp,
}

/** Build the client factory over the given transports. Throws {@link UnifiNoCredentialError}. */
export function makeUnifiClientFactory(transports: UnifiTransports): UnifiControllerClientFactory {
  return (input): UnifiControllerClient => {
    const integration = (): UnifiLiveClient =>
      new UnifiLiveClient({
        host: input.host,
        port: input.port,
        apiKey: input.apiKey,
        site: input.site,
        fetchImpl: transports.fetchFor(input.allowSelfSigned),
      })
    const classic = (): UnifiClassicClient =>
      new UnifiClassicClient({
        site: input.site,
        session: new UnifiSession({
          host: input.host,
          port: input.port,
          username: input.username,
          password: input.password,
          http: transports.httpFor(input.allowSelfSigned),
        }),
      })
    switch (unifiCredentialOf(input)) {
      case 'api-key':
        return integration()
      case 'local-account':
        return classic()
      case 'both':
        return new UnifiDualClient({
          integration: integration(),
          classic: classic(),
        })
      case null:
        throw new UnifiNoCredentialError()
    }
  }
}

/** The factory the addon wires: one live client per connection, over undici. */
export const liveUnifiClientFactory: UnifiControllerClientFactory =
  makeUnifiClientFactory(undiciTransports)
