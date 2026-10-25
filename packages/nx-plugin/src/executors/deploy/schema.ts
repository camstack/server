/**
 * Option schema for the CamStack addon `deploy` executor.
 * Mirrors `schema.json` (the Nx-facing JSON schema).
 */
export interface DeployExecutorSchema {
  /** Hub base URL. Falls back to $CAMSTACK_SERVER, ~/.camstackrc, then http://localhost:4443. */
  readonly server?: string
  /** Auth token (Bearer). Prefer $CAMSTACK_TOKEN or ~/.camstackrc over baking it into project.json. */
  readonly token?: string
  /** Skip the `build` target dependency and pack whatever is already on disk. */
  readonly skipBuild?: boolean
  /** Run `npm pack` but skip the upload — emit the .tgz path to stdout. */
  readonly packOnly?: boolean
  /** Keep the .tgz after a successful upload (default: delete). */
  readonly keepTarball?: boolean
  /** Override the rc file path (default: $HOME/.camstackrc). */
  readonly rcPath?: string
}
