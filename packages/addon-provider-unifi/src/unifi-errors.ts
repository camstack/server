/**
 * The typed failures of a UniFi controller connection. Each names a cause an operator can act on;
 * `classifyUnifiError` (unifi-connection-test.ts) turns them into a test verdict and a reason.
 */

/** The console refused the credential: the API key, or the username + password (HTTP 401 / 403). */
export class UnifiAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnifiAuthError'
  }
}

/** No credential to sign in with: neither an API key nor a username + password. */
export class UnifiNoCredentialError extends Error {
  constructor() {
    super(
      'unifi: no credential — enter an API key, or the username and password of a local account',
    )
    this.name = 'UnifiNoCredentialError'
  }
}

/** The account asks for a second factor (or is a UI.com cloud account); CamStack cannot answer one. */
export class UnifiMfaRequiredError extends Error {
  constructor() {
    super(
      'unifi: this account requires two-factor sign-in — use a LOCAL account of the console (not a UI.com account) without two-factor sign-in',
    )
    this.name = 'UnifiMfaRequiredError'
  }
}

/** The configured site is not on the console; carries the sites it does have. */
export class UnifiSiteNotFoundError extends Error {
  readonly site: string
  readonly available: readonly string[]
  constructor(site: string, available: readonly string[]) {
    const list = available.length > 0 ? `; the console has: ${available.join(', ')}` : ''
    super(`unifi: site "${site}" not found on the console${list}`)
    this.name = 'UnifiSiteNotFoundError'
    this.site = site
    this.available = available
  }
}

/** A feature the controller API in use does not offer — a refusal, never a fake success. */
export class UnifiUnsupportedError extends Error {
  readonly feature: string
  constructor(feature: string, message: string) {
    super(message)
    this.name = 'UnifiUnsupportedError'
    this.feature = feature
  }
}

/** The console answered with an unexpected status or body. */
export class UnifiApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'UnifiApiError'
    this.status = status
  }
}
