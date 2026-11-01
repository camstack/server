/**
 * What an addon version declares it needs (`camstack.requires`, D989), judged
 * against what this node runs. The declaration is read from the registry's
 * version document of the TARGET; an unreadable or absent block is "declares
 * nothing", an unreadable running server is "unknown", which never passes.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  PackageRequiresSchema,
  unmetRequirements,
  type PackageRequires,
  type UnmetRequirement,
} from '@camstack/types'
import { readInstalledAddonVersions } from './installed-addon-versions.js'
import { resolveHubClosurePackageDir } from './package-dir-utils.js'

/** `camstack.requires` of one registry version document; `undefined` when it declares none. */
export function requiresOfVersionDoc(
  doc: Readonly<Record<string, unknown>>,
): PackageRequires | undefined {
  const camstack = doc['camstack']
  if (typeof camstack !== 'object' || camstack === null) return undefined
  const parsed = PackageRequiresSchema.safeParse((camstack as Record<string, unknown>)['requires'])
  return parsed.success ? parsed.data : undefined
}

/** The version of the `@camstack/server` this process runs, or `null` when it cannot be read. */
export function readRunningServerVersion(): string | null {
  const dir = resolveHubClosurePackageDir('@camstack/server')
  if (dir === null) return null
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'))
    const version =
      typeof raw === 'object' && raw !== null ? (raw as { version?: unknown }).version : null
    return typeof version === 'string' && version.length > 0 ? version : null
  } catch {
    return null
  }
}

export interface AddonRequirementContext {
  readonly serverVersion: string | null
  /** Resolved only when the target names an addon minimum. */
  readonly addonsDir: () => string
}

/** The requirements of a target version this node does not meet. Wrappers do not bind an addon move. */
export function unmetAddonRequirements(
  requires: PackageRequires | undefined,
  context: AddonRequirementContext,
): readonly UnmetRequirement[] {
  return unmetRequirements(requires, {
    server: context.serverVersion,
    addons:
      Object.keys(requires?.addons ?? {}).length > 0
        ? readInstalledAddonVersions(context.addonsDir())
        : {},
    wrapper: null,
  })
}
