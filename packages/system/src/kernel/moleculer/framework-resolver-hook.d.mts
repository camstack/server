/**
 * Type declarations for the plain-ESM loader hook `framework-resolver-hook.mjs`.
 *
 * The hook ships as raw `.mjs` (it runs as a Node module-resolution loader, no
 * TS build step). The hub registers it via a URL string, so only the spec
 * imports it as a typed module — these declarations describe that surface.
 */

export interface FrameworkResolverInitData {
  frameworkDir?: string
}

export interface ResolveContext {
  parentURL?: string
  conditions?: string[]
  importAttributes?: Record<string, string>
}

export interface ResolveResult {
  url: string
  shortCircuit?: boolean
  format?: string | null
}

export type NextResolve = (
  specifier: string,
  context: ResolveContext,
) => ResolveResult | Promise<ResolveResult>

export function initialize(data: FrameworkResolverInitData): void

export function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): Promise<ResolveResult>
