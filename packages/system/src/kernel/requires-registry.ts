/**
 * Reading `camstack.requires` and the version list of a package from the npm
 * registry, through the SAME doors the install uses (planning#447, D989).
 *
 * The install fetches the registry document over plain HTTP and falls back to
 * `npm` (which carries the user's npmrc: private registries, tokens). The
 * requirement read does the same, in the same order. A refusal from the HTTP
 * door for lack of auth is therefore never read as "the requirement is unmet":
 * it falls through to npm, and when npm cannot read either the read FAILS with
 * a typed {@link RegistryReadError} the caller reports as such.
 */
import { compareVersions, PackageRequiresSchema, type PackageRequires } from '@camstack/types'

export type RegistryReadFailure = 'auth' | 'unavailable'

export class RegistryReadError extends Error {
  readonly kind: RegistryReadFailure
  constructor(kind: RegistryReadFailure, message: string) {
    super(message)
    this.name = 'RegistryReadError'
    this.kind = kind
  }
}

export interface RequiresRegistry {
  /** `camstack.requires` of `packageName@spec`; `undefined` when it declares none. */
  requiresOf(packageName: string, spec: string): Promise<PackageRequires | undefined>
  /** Stable versions of the package, newest first. */
  versions(packageName: string): Promise<readonly string[]>
}

export interface RequiresRegistryDeps {
  readonly registry: string | undefined
  /** GET a registry URL; the HTTP door. */
  readonly fetchJson: (url: string) => Promise<Response>
  /** Run `npm <args>` with the user's npmrc and return stdout; the second door. */
  readonly npmView: (args: readonly string[]) => Promise<string>
}

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

function isStable(version: string): boolean {
  return !version.includes('-')
}

function parseRequires(value: unknown): PackageRequires | undefined {
  if (value === undefined || value === null) return undefined
  const parsed = PackageRequiresSchema.safeParse(value)
  if (!parsed.success) {
    throw new RegistryReadError('unavailable', 'the registry document carries a malformed requires')
  }
  return parsed.data
}

function failureOf(err: unknown): RegistryReadFailure {
  const text = err instanceof Error ? err.message : String(err)
  return /\b(E401|E403|401|403|unauthori[sz]ed|forbidden)\b/i.test(text) ? 'auth' : 'unavailable'
}

export function createRequiresRegistry(deps: RequiresRegistryDeps): RequiresRegistry {
  const base = (deps.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, '')
  const urlOf = (packageName: string): string =>
    `${base}/${encodeURIComponent(packageName).replace(/^%40/, '@')}`

  const viaNpm = async (args: readonly string[]): Promise<unknown> => {
    let stdout: string
    try {
      stdout = await deps.npmView(args)
    } catch (err) {
      throw new RegistryReadError(failureOf(err), err instanceof Error ? err.message : String(err))
    }
    const trimmed = stdout.trim()
    return trimmed.length === 0 ? undefined : JSON.parse(trimmed)
  }

  return {
    async requiresOf(packageName, spec) {
      try {
        const res = await deps.fetchJson(`${urlOf(packageName)}/${encodeURIComponent(spec)}`)
        if (res.ok) {
          const doc: unknown = await res.json()
          if (typeof doc === 'object' && doc !== null) {
            const camstack: unknown = Reflect.get(doc, 'camstack')
            const requires: unknown =
              typeof camstack === 'object' && camstack !== null
                ? Reflect.get(camstack, 'requires')
                : undefined
            return parseRequires(requires)
          }
        }
      } catch (err) {
        if (err instanceof RegistryReadError) throw err
        // network failure on the HTTP door: the npm door decides
      }
      return parseRequires(
        await viaNpm(['view', `${packageName}@${spec}`, 'camstack.requires', '--json']),
      )
    },

    async versions(packageName) {
      let names: readonly string[] | null = null
      try {
        const res = await deps.fetchJson(urlOf(packageName))
        if (res.ok) {
          const doc: unknown = await res.json()
          const versions: unknown =
            typeof doc === 'object' && doc !== null ? Reflect.get(doc, 'versions') : undefined
          if (typeof versions === 'object' && versions !== null) names = Object.keys(versions)
        }
      } catch {
        // fall through to npm
      }
      if (names === null) {
        const listed = await viaNpm(['view', packageName, 'versions', '--json'])
        names = Array.isArray(listed)
          ? listed.filter((v): v is string => typeof v === 'string')
          : typeof listed === 'string'
            ? [listed]
            : []
      }
      return names.filter(isStable).sort((a, b) => compareVersions(b, a))
    },
  }
}
