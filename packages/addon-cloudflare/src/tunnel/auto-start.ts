/**
 * Whether cloudflare-tunnel may spawn `cloudflared` at boot / config-reload.
 *
 * Constructor defaults are `mode: 'quick'`. A settings store that has not
 * answered therefore looks exactly like "the operator wants a trycloudflare
 * URL". Auto-starting that is how a named hostname (the one the notification
 * centre still mints) went Cloudflare 530: the named tunnel never connected.
 *
 * An empty store that DID answer is a real choice — a fresh install still
 * auto-starts quick. Only "never answered" is refused.
 */
export function shouldAutoStartTunnel(input: {
  readonly settingsStoreReady: boolean
  readonly mode: 'quick' | 'custom'
  readonly hasCustomToken: boolean
  readonly hasCustomHostname: boolean
}): boolean {
  if (!input.settingsStoreReady) return false
  if (input.mode === 'quick') return true
  return input.hasCustomToken && input.hasCustomHostname
}
