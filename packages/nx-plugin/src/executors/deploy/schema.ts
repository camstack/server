/**
 * Option schema for the CamStack addon `deploy` executor.
 * Mirrors `schema.json` (the Nx-facing JSON schema).
 */
export interface DeployExecutorSchema {
  /** Hub base URL. Falls back to $CAMSTACK_SERVER, then the hub of the login session. */
  readonly server?: string
  /** Skip the `build` target dependency and pack whatever is already on disk. */
  readonly skipBuild?: boolean
  /** Run `npm pack` but skip the upload — emit the .tgz path to stdout. */
  readonly packOnly?: boolean
  /** Keep the .tgz after a successful upload (default: delete). */
  readonly keepTarball?: boolean
}
