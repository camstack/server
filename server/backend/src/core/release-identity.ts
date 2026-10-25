/**
 * What the About line shows: the product release (image / desktop app) and
 * the running `@camstack/server` package. They are different lines (D943).
 *
 * The product version is declared by the shell — `CAMSTACK_PRODUCT_VERSION`,
 * set by the image and by the desktop app. A dev workspace leaves it unset;
 * that is absence, not a failure. The server version is the package this
 * process loaded.
 */

export const PRODUCT_VERSION_ENV = 'CAMSTACK_PRODUCT_VERSION'

export interface ReleaseIdentity {
  readonly productVersion: string | null
  readonly serverVersion: string | null
}

export function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

export function releaseIdentityFrom(input: {
  readonly productVersionEnv: string | undefined
  readonly serverVersion: string | null
}): ReleaseIdentity {
  return {
    productVersion: blankToNull(input.productVersionEnv),
    serverVersion: blankToNull(input.serverVersion ?? undefined),
  }
}
