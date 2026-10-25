/**
 * The bare specifiers an ESM addon may leave unbundled and expect the HOST
 * framework to provide. Self-contained addons (the standard) inline
 * @camstack/types, @camstack/sdk, zod, @trpc/* — so for them only
 * @camstack/system survives as genuinely host-provided. Framework-mode (legacy)
 * addons additionally leave the types/sdk/zod/trpc set external. Listing the
 * full union here lets one resolver hook serve both modes: for a self-contained
 * addon the extra entries simply never appear as live imports.
 */
export const HOST_EXTERNAL_SPECIFIERS: readonly string[] = [
  '@camstack/system',
  // `@camstack/shm-ring` is gone (D763): the package was deleted, and no
  // published addon version imports it.
  '@camstack/types',
  '@camstack/sdk',
  'zod',
  '@trpc/server',
  '@trpc/client',
  // Common native deps that addons genuinely import (sharp: image work in the
  // detection / post-analysis / benchmark addons; node-av: the media runners) —
  // resolved from the host framework's node_modules so addons need no local
  // node_modules after a tarball-extract swap.
  // NOTE: better-sqlite3 is deliberately NOT host-external. No addon imports it
  // — it is used only by @camstack/system's sqlite-storage builtin (hub
  // process), whose module already lives in the framework dir and resolves it
  // there natively. Leaving it out means a stray `import 'better-sqlite3'` from
  // an ADDON fails to resolve instead of being silently redirected, enforcing
  // that addons persist through the storage cap, never a private database.
  'sharp',
  'node-av',
  // node-pty: the terminal addon's real native pty (`.node`). Declared on
  // @camstack/server so the framework closure carries it; addons resolve it here
  // instead of a per-addon install (which never happened — it is an
  // optionalDependency the stripper drops — so this is the ONLY way it resolves).
  'node-pty',
  // ssh2 (remote-storage): pure-JS but ships optional native accelerators that
  // cannot be bundled — resolved from the framework closure instead.
  'ssh2',
]

/** True when `specifier` is one of the host-provided packages or a subpath of one. */
export function isHostExternal(specifier: string): boolean {
  for (const name of HOST_EXTERNAL_SPECIFIERS) {
    if (specifier === name || specifier.startsWith(`${name}/`)) return true
  }
  return false
}
