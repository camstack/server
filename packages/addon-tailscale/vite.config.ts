import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

/**
 * Tailscale bundle — 2 addons under one self-contained package:
 *   • client  — joins the host to a tailnet (mesh-network + network-access)
 *   • ingress — Serve/Funnel exposure of the hub (network-access)
 *
 * Each addon keeps its own id + runner; we bundle the PACKAGE only.
 * Both `index` entries are emitted so the package `exports` (`./client`,
 * `./ingress`) resolve, alongside the `.addon` manifest entries the
 * kernel loads via `await import(entry)`.
 */
export default buildLibPreset({
  entries: {
    'client/index': 'src/client/index.ts',
    'client/tailscale.addon': 'src/client/tailscale.addon.ts',
    'ingress/index': 'src/ingress/index.ts',
    'ingress/tailscale-ingress.addon': 'src/ingress/tailscale-ingress.addon.ts',
  },
  externals: 'self-contained',
})
