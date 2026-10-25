/**
 * Strict per-hop allow-list for plugin catalog catalog downloads.
 *
 * Hosts are the ones observed from the pinned revision
 * `187402b20a3be0a7fab9bceee21d857ed6ae0064` — not a generic CDN wildcard.
 */
export const PLUGIN_CATALOG_DOWNLOAD_REDIRECT_HOSTS = [
  'huggingface.co',
  'us.aws.cdn.hf.co',
] as const

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/

export function assertPluginCatalogDownloadUrl(url: URL, _hop: number): void {
  if (url.protocol !== 'https:') {
    throw new Error(`http downgrade refused: ${url.protocol}`)
  }
  if (url.username || url.password) {
    throw new Error('userinfo not allowed on download URL')
  }
  const host = url.hostname.toLowerCase()
  if (LOCAL_HOSTS.has(host) || IPV4_RE.test(host) || host.includes(':')) {
    throw new Error(`host not allowed: ${host}`)
  }
  if (!(PLUGIN_CATALOG_DOWNLOAD_REDIRECT_HOSTS as readonly string[]).includes(host)) {
    throw new Error(`host not allowed: ${host}`)
  }
}
