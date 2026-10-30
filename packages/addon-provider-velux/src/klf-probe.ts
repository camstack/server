import type { ConnectionOptions } from 'node:tls'
import { errMsg } from '@camstack/types'
import { Connection, Gateway } from 'klf-200-api'
import { loginFailure } from './klf-gateway-client.js'

/** Seconds allowed for the TLS handshake plus password exchange of a probe. */
const PROBE_LOGIN_TIMEOUT_S = 15

/** Options of {@link probeKlfGateway}. */
export interface KlfProbeOptions {
  readonly host: string
  readonly password: string
  /** Replaces the library's built-in certificate trust (spec seam). */
  readonly tls?: ConnectionOptions
}

/** What a successful probe learned about the gateway. */
export interface KlfProbeResult {
  /** Firmware version, or null when the gateway logged us in but did not answer GW_GET_VERSION. */
  readonly firmware: string | null
}

/**
 * Opens ONE session, authenticates, reads the firmware version and closes the
 * session again, whatever happens. The gateway accepts two sessions in total, so
 * a probe never lingers and never keeps the house status monitor or the node
 * list. A refused password rejects with `VeluxLoginRefusedError`.
 */
export async function probeKlfGateway(options: KlfProbeOptions): Promise<KlfProbeResult> {
  const connection =
    options.tls === undefined
      ? new Connection(options.host)
      : new Connection(options.host, options.tls)
  try {
    try {
      await connection.loginAsync(options.password, PROBE_LOGIN_TIMEOUT_S)
    } catch (err) {
      throw loginFailure(err)
    }
    try {
      const { SoftwareVersion } = await new Gateway(connection).getVersionAsync()
      return { firmware: SoftwareVersion.toString() }
    } catch {
      // The login is what the probe proves; the version is a bonus.
      return { firmware: null }
    }
  } finally {
    try {
      await connection.logoutAsync()
    } catch (err) {
      // The socket is being discarded either way.
      void errMsg(err)
    }
  }
}
