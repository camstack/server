/**
 * Which credential a UniFi connection signs in with, and the client that speaks it:
 *  - an API key alone → the UniFi OS Integration API (`UnifiLiveClient`): no PoE on/off;
 *  - a local account alone → the classic Network API through aiounifi in a Python worker
 *    (`UnifiAiounifiClient`), on a UniFi OS console or a legacy controller;
 *  - both → `UnifiDualClient`: the API key for everything it did before, the local account for
 *    PoE on/off, the per-port readings and the websocket's live changes.
 */
import type {
  UnifiControllerClient,
  UnifiControllerClientFactory,
} from './unifi-client-contract.js'
import { UnifiAiounifiClient } from './unifi-client-aiounifi.js'
import { UnifiDualClient } from './unifi-client-dual.js'
import { type UnifiFetch, UnifiLiveClient } from './unifi-client-live.js'
import { UnifiNoCredentialError } from './unifi-errors.js'
import type { UnifiWorkerChannel } from './unifi-worker-channel.js'
import type { UnifiSecretFiles } from './unifi-worker-files.js'

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

/** What the clients are built over: undici for the API key, the aiounifi worker for the account. */
export interface UnifiClientDeps {
  readonly fetchFor: (allowSelfSigned: boolean) => UnifiFetch
  /** Starts one aiounifi worker process (one per connection). */
  readonly openWorker: () => Promise<UnifiWorkerChannel>
  readonly secretFiles: UnifiSecretFiles
}

/** Build the client factory. The returned factory throws {@link UnifiNoCredentialError}. */
export function makeUnifiClientFactory(deps: UnifiClientDeps): UnifiControllerClientFactory {
  return (input): UnifiControllerClient => {
    const integration = (): UnifiLiveClient =>
      new UnifiLiveClient({
        host: input.host,
        port: input.port,
        apiKey: input.apiKey,
        site: input.site,
        fetchImpl: deps.fetchFor(input.allowSelfSigned),
      })
    const account = (): UnifiAiounifiClient =>
      new UnifiAiounifiClient({
        host: input.host,
        port: input.port,
        username: input.username,
        password: input.password,
        site: input.site,
        allowSelfSigned: input.allowSelfSigned,
        openChannel: deps.openWorker,
        secretFiles: deps.secretFiles,
      })
    switch (unifiCredentialOf(input)) {
      case 'api-key':
        return integration()
      case 'local-account':
        return account()
      case 'both':
        return new UnifiDualClient({
          integration: integration(),
          classic: account(),
        })
      case null:
        throw new UnifiNoCredentialError()
    }
  }
}
