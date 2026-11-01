/**
 * Where the running CLI lives (D988). The installer's managed layout is
 *
 *   <root>/runtime/        the Node the CLI runs on
 *   <root>/cli/<version>/  one staged CLI per version
 *   <root>/current         symlink to the active cli/<version>
 *   <root>/previous        symlink to the one before (for rollback)
 *
 * with `<root>` = `$CAMSTACK_HOME` or `~/.local/share/camstack`. The CLI's
 * sign-in sessions live in `~/.camstack` and are never part of this tree.
 * Detection is pure: a path in, a layout out — nothing is read from disk.
 */
import * as path from 'node:path'
import { detectCliInstall, type CliInstall } from './mcp/ops-update-cli.js'

export type InstallLayout =
  | { readonly kind: 'managed'; readonly root: string }
  | { readonly kind: 'npm-global'; readonly install: CliInstall }
  | { readonly kind: 'npx'; readonly install: CliInstall }
  | { readonly kind: 'other'; readonly install: CliInstall }

export function managedRoot(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  const override = env['CAMSTACK_HOME']
  return override !== undefined && override !== ''
    ? override
    : path.join(home, '.local', 'share', 'camstack')
}

/** `entryPath` is the resolved path of the running CLI entry. */
export function detectInstallLayout(
  entryPath: string,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): InstallLayout {
  const root = managedRoot(env, home)
  const rel = path.relative(root, entryPath)
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  if (inside) {
    const top = rel.split(path.sep)[0]
    if (top === 'cli' || top === 'current' || top === 'previous') return { kind: 'managed', root }
  }
  const install = detectCliInstall(entryPath)
  if (install.method === 'npm-global') return { kind: 'npm-global', install }
  if (install.method === 'npx') return { kind: 'npx', install }
  return { kind: 'other', install }
}
