export interface HubAuth {
  readonly server: string
  readonly token: string
  readonly tier: 'admin' | 'protected'
  readonly source: 'session'
}

export interface HubAuthOptions {
  /** Explicit hub address; otherwise $CAMSTACK_HUB_URL, scratchpad/.hub-url or the session. */
  readonly server?: string
}

/** The token always comes from the `dominevo login` session (D1101). */
export function resolveHubAuth(opts?: HubAuthOptions): Promise<HubAuth>
