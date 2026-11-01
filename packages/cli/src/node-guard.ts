/**
 * The Node version the CLI needs, checked before anything else is loaded.
 * Kept free of imports on purpose: it runs on the Node that is installed, which
 * may be too old to even parse the rest of the CLI.
 */

export const MIN_NODE_MAJOR = 24
/** `EX_CONFIG`: the environment is not set up to run this. */
export const NODE_TOO_OLD_EXIT_CODE = 78
export const INSTALLER_COMMAND = 'curl -fsSL https://camstack-docs.zentik.app/install.sh | sh'

export type NodeGuardVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string; readonly exitCode: number }

/** `24.1.0` -> 24; NaN-safe: an unreadable version is treated as too old. */
export function nodeMajorOf(version: string): number {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10)
  return Number.isNaN(major) ? 0 : major
}

export function checkNodeVersion(version: string): NodeGuardVerdict {
  if (nodeMajorOf(version) >= MIN_NODE_MAJOR) return { ok: true }
  return {
    ok: false,
    exitCode: NODE_TOO_OLD_EXIT_CODE,
    message:
      `camstack needs Node ${MIN_NODE_MAJOR} or newer (this is Node ${version}). ` +
      `Install it with the camstack installer: ${INSTALLER_COMMAND}`,
  }
}
