/**
 * The About line: product release (0.1.0 beta) and the running server
 * package. Major 0 is labelled beta (D943). The viewer app's 1.0.x line
 * is not this label.
 */

export interface ReleaseVersions {
  readonly productVersion: string | null
  readonly serverVersion: string | null
  readonly fallbackVersion: string | null
}

export interface ReleasePair {
  readonly productVersion: string | null
  readonly serverVersion: string | null
}

export type ReleaseDescription =
  | { readonly kind: 'both'; readonly productLabel: string; readonly serverVersion: string }
  | { readonly kind: 'product'; readonly productLabel: string }
  | { readonly kind: 'server'; readonly serverVersion: string }
  | { readonly kind: 'fallback'; readonly version: string }
  | { readonly kind: 'none' }

export function formatProductLabel(version: string): string {
  return version.split('.')[0] === '0' ? `${version} beta` : version
}

function present(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function describeRelease(input: ReleaseVersions): ReleaseDescription {
  const product = present(input.productVersion)
  const server = present(input.serverVersion)
  const fallback = present(input.fallbackVersion)
  if (product !== null && server !== null) {
    return { kind: 'both', productLabel: formatProductLabel(product), serverVersion: server }
  }
  if (product !== null) return { kind: 'product', productLabel: formatProductLabel(product) }
  if (server !== null) return { kind: 'server', serverVersion: server }
  if (fallback !== null) return { kind: 'fallback', version: fallback }
  return { kind: 'none' }
}

function readOptionalString(value: object, key: string): string | null {
  if (!Object.hasOwn(value, key)) return null
  const found = Reflect.get(value, key)
  return typeof found === 'string' ? found : null
}

/** A body that is not the identity shape is absence, not a guessed version. */
export function parseReleaseIdentity(value: unknown): ReleasePair | null {
  if (typeof value !== 'object' || value === null) return null
  return {
    productVersion: readOptionalString(value, 'productVersion'),
    serverVersion: readOptionalString(value, 'serverVersion'),
  }
}
