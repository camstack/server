/**
 * The seam between the SMB provider and `samba-client`.
 *
 * `samba-client@7` is a thin wrapper around the **`smbclient` binary** — it
 * shells out through `execa` rather than speaking SMB in JavaScript. That is
 * the whole reason it was chosen over the pure-JS options: every SMB client on
 * npm is a fork of the abandoned `@marsaud/smb2` (last publish 2022), whereas
 * `smbclient` is Samba's own tool, maintained by the people who define the
 * protocol. It is the client the operator has been running in production
 * against this same NAS.
 *
 * The cost is stated plainly because it does not go away: **the provider
 * cannot work without the `smbclient` binary on PATH.** It is absent from the
 * CamStack container image. The binary is obtained through the framework's
 * manifest-declared system dependencies (`camstack.addons[].systemDependencies`
 * → `installManifestSystemDeps`), which runs before this addon's capabilities
 * register — and when that fails, {@link SmbBinaryUnavailableError} is what
 * every method of the provider raises, so a missing binary reads as a REFUSAL
 * and never as an empty share.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** The binary every operation ultimately runs. */
export const SMB_BINARY = 'smbclient'

/** How long the one-shot `command -v smbclient` probe may take. */
const PROBE_TIMEOUT_MS = 10_000

/**
 * Raised by every provider method when `smbclient` is not on PATH.
 *
 * A distinct type, not a generic `Error`, because the difference between
 * "this share is empty" and "this provider cannot run" is the difference
 * between a location that D293's delete guard will let an operator destroy
 * and one it will not.
 */
export class SmbBinaryUnavailableError extends Error {
  constructor() {
    super(
      `smb-storage: the "${SMB_BINARY}" binary is not available on this node. ` +
        `It is declared in the addon manifest under camstack.addons[].systemDependencies ` +
        `and installed by the runner before this addon initialises; check the runner log ` +
        `for "system dependency install failed". Until it resolves, this provider refuses ` +
        `every operation — its locations are UNREACHABLE, which is not the same as empty.`,
    )
    this.name = 'SmbBinaryUnavailableError'
  }
}

/** One entry of a remote directory listing. */
export interface SmbItem {
  readonly name: string
  readonly type: string
  readonly size: number
  readonly modifyTime: Date
}

/** Connection parameters, as `samba-client` accepts them. */
export interface SmbClientOptions {
  readonly address: string
  readonly username?: string
  readonly password?: string
  readonly domain?: string
  readonly port?: number
  readonly directory?: string
  readonly timeout?: number
  readonly maxProtocol?: string
  /**
   * Replace a failed command's message with the captured smbclient output.
   *
   * ALWAYS true here. `samba-client` puts the password on the argv of
   * `smbclient`, and without this flag `execa` embeds the full command line —
   * password included — in the error message it throws. Those messages travel
   * to the operator through `testConfig`'s free-text `error` field.
   */
  readonly maskCmd?: boolean
}

/** The subset of `samba-client` this provider uses. */
export interface SmbClientLike {
  sendFile(localPath: string, destination: string): Promise<unknown>
  getFile(remotePath: string, destination: string, workingDir?: string): Promise<unknown>
  deleteFile(fileName: string): Promise<unknown>
  mkdir(remotePath: string, cwd?: string): Promise<unknown>
  list(remotePath: string): Promise<readonly SmbItem[]>
  execute(
    smbCommand: string,
    smbCommandArgs: string | readonly string[],
    workingDir?: string,
  ): Promise<unknown>
}

/** Constructs a client for one connection. The test seam. */
export type SmbClientFactory = (options: SmbClientOptions) => SmbClientLike

/**
 * Default factory — a real `samba-client`.
 *
 * Imported lazily so that merely LOADING this module (which the addon does at
 * boot, before the binary check) never fails on a host where the package's
 * own dependency tree is incomplete. A provider that cannot be constructed
 * takes its three sibling providers down with it: they share
 * `execution.group: "remote-storage"`, so one throw at import time respawns
 * SFTP, S3 and WebDAV too.
 */
export async function defaultSmbClientFactory(options: SmbClientOptions): Promise<SmbClientLike> {
  const mod = await import('samba-client')
  const SambaClient = mod.default
  return new SambaClient({ ...options, maskCmd: true })
}

/** Is `smbclient` on PATH? */
export async function probeSmbBinary(): Promise<boolean> {
  try {
    await execFileAsync('command', ['-v', SMB_BINARY], {
      timeout: PROBE_TIMEOUT_MS,
      shell: '/bin/sh',
    })
    return true
  } catch {
    return false
  }
}
