import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

/**
 * Cloudflare bundle — 2 entries (cloudflare-tunnel, cloudflare-turn).
 *
 * Merges the former `@camstack/addon-cloudflare-tunnel` and
 * `@camstack/addon-cloudflare-turn` packages into a single multi-entry
 * bundle (same pattern as `@camstack/addon-pipeline`). Each addon keeps
 * its own id + capabilities + runner — only the npm package is merged,
 * NOT the processes (no shared `execution.group`).
 *
 * Node-only addons (cloudflared spawned from PATH, Cloudflare REST API,
 * crypto-derived TURN credentials). No React widgets, no native deps →
 * 'self-contained' externals.
 */
export default buildLibPreset({
  entries: {
    'tunnel/cloudflare-tunnel.addon': 'src/tunnel/cloudflare-tunnel.addon.ts',
    'turn/cloudflare-turn.addon': 'src/turn/cloudflare-turn.addon.ts',
  },
  externals: 'self-contained',
})
