export interface HubAuth {
  readonly server: string
  readonly token: string
  readonly tier: 'admin' | 'protected'
  readonly source: string
}

export interface HubAuthOptions {
  /** Explicit hub address; otherwise $CAMSTACK_HUB_URL, scratchpad/.hub-url or the session. */
  readonly server?: string
  /** Explicit token override; otherwise the `camstack login` session. */
  readonly tokenFile?: string
}

export function resolveHubAuth(opts?: HubAuthOptions): Promise<HubAuth>
