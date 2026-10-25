/**
 * The one sentence every hub tool gives when a credential is missing, refused
 * or not strong enough: run `camstack login <host>` once; every tool then uses
 * that session (refreshed automatically). There is no second credential file
 * to look for.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** Is `name` an executable file in one of the `PATH` directories? */
function onPath(name: string, pathEnv: string | undefined): boolean {
  if (!pathEnv) return false
  return pathEnv.split(path.delimiter).some((d) => {
    if (d === '') return false
    try {
      fs.accessSync(path.join(d, name), fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

/** The checkout-local invocation: build the CLI once, then run its entry. */
export const REPO_LOCAL_LOGIN = 'npx nx run camstack:build && node packages/cli/dist/cli.js login'

/**
 * The exact command that refreshes the CLI session: `camstack login` when the
 * binary is on PATH, otherwise the checkout-local form.
 */
export function sessionLoginCommand(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return onPath('camstack', env['PATH']) ? 'camstack login' : REPO_LOCAL_LOGIN
}

/** The hub answered 401/403 to an admin-tier credential. */
export function adminRejectedHint(command: string = sessionLoginCommand()): string {
  return `the hub rejected this credential (revoked or expired). Run \`${command}\` in a terminal with an admin account.`
}

/** Why admin-tier ops are blocked locally. */
export function adminCredentialHint(command: string = sessionLoginCommand()): string {
  return `this credential is not admin-scoped. Run \`${command}\` with an admin account (the MCP never handles a password).`
}
