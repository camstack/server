/**
 * Google OAuth redirect origin — same role as hub OAuth2 / sign-in
 * (`local-network` cap: `roles.publicEndpoint`), never `internal` (LAN / agents).
 * Google rejects non-localhost `http://` redirect URIs for Web clients.
 */
export function pickOauthRedirectOrigin(book: {
  readonly roles: {
    readonly publicEndpoint: { readonly resolved: string | null }
    readonly internal: { readonly resolved: string | null }
  }
}): string | null {
  return book.roles.publicEndpoint.resolved ?? book.roles.internal.resolved ?? null
}
