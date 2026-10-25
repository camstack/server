/**
 * SDK client configuration types.
 *
 * NVR types are now in nvr.ts (shared across app and proxy).
 */

export interface HlsInfo {
  hlsUrl: string
}

/** Public provider info (returned by providers.list). */
export interface ProviderInfo {
  id: string
  type: string
  name: string
}

// ─── Client config ──────────────────────────────────────────────────

export interface ProxyClientConfig {
  /**
   * Primary proxy URL (e.g. "http://192.168.10.100:4000").
   * Can also be an array of URLs to race.
   * The first successful connection wins.
   */
  proxyUrl: string | string[]
  /** Optional auth token for admin endpoints. */
  token?: string
  /** Transport: "websocket" (default) or "http" (REST fallback). */
  transport?: 'websocket' | 'http'
  /** Connection timeout per URL in ms (default: 10000). */
  connectTimeoutMs?: number
}

export interface DirectClientConfig {
  directUrl: string
  type: 'direct'
  username?: string
  password?: string
}

export type BackendConnectionState = 'connected' | 'disconnected' | 'connecting'

export type CamStackClientConfig = ProxyClientConfig | DirectClientConfig

export function isProxyConfig(config: CamStackClientConfig): config is ProxyClientConfig {
  return 'proxyUrl' in config
}
