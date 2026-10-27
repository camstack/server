/**
 * Shared display-name resolution for per-ADDON provider rows
 * (`<IntegrationHub>` pages: Remote Access, Mesh Networks, TURN servers,
 * Authentication, Log destinations). `addons.listCapabilityProviders` returns only
 * `{ addonId, mode, isActive }`, so pages cross-reference `addons.list`.
 *
 * Preference: the ADDON-level `name` ("Cloudflare Tunnel", "Tailscale
 * Funnel") wins over the bundle-level `packageDisplayName`
 * ("Cloudflare", "Tailscale") — a bundle ships multiple addons, and
 * labelling two rows of one page with the same bundle name is ambiguous.
 * (`Integrations.tsx` groups by PACKAGE and correctly prefers
 * `packageDisplayName` — do not reuse this helper there.)
 */

interface RawAddonManifest {
  readonly manifest?: {
    readonly id?: string
    readonly name?: string
    readonly packageDisplayName?: string
  }
}

export function buildAddonDisplayNameMap(addons: readonly unknown[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const raw of addons) {
    const manifest = (raw as RawAddonManifest | null)?.manifest
    if (!manifest?.id) continue
    out.set(manifest.id, manifest.name ?? manifest.packageDisplayName ?? manifest.id)
  }
  return out
}
