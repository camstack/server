/**
 * The typed failures of a UniFi controller connection. Each names a cause an operator can act on;
 * `classifyUnifiError` (unifi-connection-test.ts) turns them into a test verdict and a reason.
 */

/** The console refused the API key (HTTP 401 / 403). */
export class UnifiAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnifiAuthError'
  }
}

/** No API key to sign in with. A username + password alone is not used yet (planning#581). */
export class UnifiNoCredentialError extends Error {
  constructor() {
    super(
      'unifi: no API key — enter the API key of the UniFi console (username and password sign-in is not supported yet)',
    )
    this.name = 'UnifiNoCredentialError'
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
