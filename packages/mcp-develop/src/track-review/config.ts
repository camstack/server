/**
 * How the review tools find their hub: the shared `@camstack/develop` chain
 * (`connectHub`), the same one `camstack deploy` and `scripts/hub/hub.mjs` use.
 * Hub address: `CAMSTACK_HUB_URL`, the scratchpad file, else the cached
 * `camstack login` session. Credential: `CAMSTACK_HUB_TOKEN`, then
 * `CAMSTACK_HUB_TOKEN_FILE`, then the login session (renewed when about to
 * expire). TLS is never disabled — a self-signed hub is trusted by naming its
 * CA (`CAMSTACK_HUB_CA_FILE`) or saving it next to the session.
 *
 * A token is never printed, logged or returned.
 */
import {
  adminCredentialHint,
  connectHub,
  type HubConnection,
  type HubTransport,
} from '@camstack/develop'
import { createReviewHub, type ReviewHub } from './hub-api.js'

type Env = Readonly<Record<string, string | undefined>>

export class HubConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HubConfigError'
  }
}

/** `read` tools work with any credential; `write` tools need an admin one. */
export type ReviewAccess = 'read' | 'write'

export interface ReviewHubOptions {
  readonly env?: Env
  /** The session cache directory (tests); defaults to `~/.camstack`. */
  readonly sessionDir?: string
  readonly transport?: HubTransport
  readonly workspaceRoot?: string
}

interface ConnectedReviewHub {
  readonly hub: ReviewHub
  readonly connection: HubConnection
}

const REMEDY =
  'Run `camstack login <host>` (admin account for the write tools), or set CAMSTACK_HUB_TOKEN_FILE to a file holding one token.'

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

async function connect(options: ReviewHubOptions): Promise<ConnectedReviewHub> {
  const env = options.env ?? process.env
  const token = nonBlank(env['CAMSTACK_HUB_TOKEN'])
  const tokenFile = nonBlank(env['CAMSTACK_HUB_TOKEN_FILE'])
  try {
    const connection = await connectHub({
      workspaceRoot: options.workspaceRoot ?? process.cwd(),
      env,
      ...(token !== undefined ? { token } : {}),
      ...(tokenFile !== undefined ? { tokenFile } : {}),
      ...(options.sessionDir !== undefined ? { sessionDir: options.sessionDir } : {}),
      ...(options.transport !== undefined ? { transport: options.transport } : {}),
    })
    return { hub: createReviewHub(connection.client), connection }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new HubConfigError(`${message}\n${REMEDY}`)
  }
}

/**
 * One lazily-resolved hub for the process. `write` is refused up front, before
 * any hub call, when the credential is not admin.
 */
export function createReviewHubProvider(
  options: ReviewHubOptions = {},
): (access?: ReviewAccess) => Promise<ReviewHub> {
  let pending: Promise<ConnectedReviewHub> | undefined
  return async (access = 'read') => {
    const attempt = (pending ??= connect(options))
    let connected: ConnectedReviewHub
    try {
      connected = await attempt
    } catch (err) {
      if (pending === attempt) pending = undefined
      throw err
    }
    if (access === 'write' && connected.connection.tier !== 'admin') {
      throw new HubConfigError(
        `This operation writes to the hub and needs an admin login. ${adminCredentialHint()}`,
      )
    }
    return connected.hub
  }
}
