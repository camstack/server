import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

// Mirror of host-externals.ts isHostExternal — kept inline because loader
// hooks run as raw ESM (no TS build). The host-externals.spec + this file's
// spec both pin the list; if they drift a test fails.
const HOST_EXTERNAL_SPECIFIERS = [
  '@camstack/system',
  '@camstack/types',
  '@camstack/sdk',
  'zod',
  '@trpc/server',
  '@trpc/client',
  // Common native deps addons genuinely import (sharp, node-av) — resolved from
  // the framework's node_modules. better-sqlite3 is intentionally excluded: no
  // addon imports it (only @camstack/system's hub-side sqlite-storage builtin),
  // so a stray addon import must fail rather than be silently redirected. Keep
  // in sync with host-externals.ts (a spec pins both).
  'sharp',
  'node-av',
  'node-pty',
  'ssh2',
]

function isHostExternal(specifier) {
  for (const name of HOST_EXTERNAL_SPECIFIERS) {
    if (specifier === name || specifier.startsWith(`${name}/`)) return true
  }
  return false
}

let anchorParentURL = null

// Receives { frameworkDir } via module.register(..., { data }). Computes the
// anchor file URL inside frameworkDir/node_modules so nextResolve walks up from
// there and finds @camstack/* via standard package resolution (honors exports).
export function initialize(data) {
  const frameworkDir = data && typeof data.frameworkDir === 'string' ? data.frameworkDir : null
  anchorParentURL = frameworkDir
    ? pathToFileURL(path.join(frameworkDir, 'node_modules', '__camstack_resolver_anchor__.js')).href
    : null
}

export async function resolve(specifier, context, nextResolve) {
  if (anchorParentURL && isHostExternal(specifier)) {
    return nextResolve(specifier, { ...context, parentURL: anchorParentURL })
  }
  return nextResolve(specifier, context)
}
