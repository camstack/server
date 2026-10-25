import { z } from 'zod'

/**
 * Persisted per-camera hardware config for a Wyze camera.
 *
 * The P2P connection parameters (`mac`, `p2pId`, `enr`, `ip`,
 * `productModel`) come from the Wyze cloud's `getCameraList()` blob — NOT
 * a LAN scan. They are everything `WyzeDTLSConn` needs to open the local
 * P2P/DTLS session. `ip` is the camera's last-known local address; the
 * cloud returns it, but DHCP can move the camera, so the provider
 * re-pulls the cloud list (debounced) before each materialize to refresh
 * a stale ip (`refreshCameraIps`).
 *
 * `resolution` / `bitrate` are operator-tunable stream knobs (the
 * `frameSize` / `bitrate` args of `createWyzeRfc4571Server`).
 */
export const WyzeResolutionSchema = z.enum(['fhd', 'hd', 'low', 'qhd'])
export type WyzeResolution = z.infer<typeof WyzeResolutionSchema>

export const WyzeBitrateSchema = z.enum(['max', 'sd'])
export type WyzeBitrate = z.infer<typeof WyzeBitrateSchema>

export const WyzeMotionSourceSchema = z.enum(['cloud', 'boa'])
export type WyzeMotionSource = z.infer<typeof WyzeMotionSourceSchema>

export const wyzeCameraSchema = z.object({
  /**
   * Owning Wyze integration id (account). Stamped at adopt/create so the
   * camera resolves its per-account {@link WyzeCloudClient} from the client
   * registry (multi-account: one integration = one account = one client).
   * Optional for back-compat with cameras persisted under the legacy
   * single-global-credentials model — those resolve via the migration
   * fallback until re-adopted.
   */
  integrationId: z.string().default(''),
  /** Hardware MAC — globally unique, the stableId discriminator. */
  mac: z.string().describe('Wyze camera MAC (hardware id)'),
  /** P2P UID (TUTK) — the cloud `device_params.p2p_id`. */
  p2pId: z.string().describe('Wyze P2P UID'),
  /** Encryption key — the cloud `enr`. */
  enr: z.string().describe('Wyze ENR encryption key'),
  /** Last-known local IP from the cloud. Refreshed before each dial. */
  ip: z.string().describe('Last-known local IP'),
  /** Product model (e.g. WYZE_CAKP2JFUS). Needed by WyzeDTLSConn. */
  productModel: z.string().describe('Wyze product model'),
  /** Whether the camera wants DTLS (`device_params.dtls === 1`). */
  dtls: z.number().int().default(0),
  /** Firmware version string (display only). */
  firmwareVer: z.string().default(''),
  /** Stream resolution knob → `createWyzeRfc4571Server.frameSize`. */
  resolution: WyzeResolutionSchema.default('fhd'),
  /** Stream bitrate knob → `createWyzeRfc4571Server.bitrate`. */
  bitrate: WyzeBitrateSchema.default('max'),
  /**
   * Motion event source. `cloud` (default) polls the Wyze events API —
   * works while the camera is asleep, no P2P needed. `boa` reads the
   * on-camera SD-card poller, which requires an active P2P session + an
   * inserted SD card (only available while streaming).
   */
  motionSource: WyzeMotionSourceSchema.default('cloud'),
})

export type WyzeCameraConfig = z.infer<typeof wyzeCameraSchema>
