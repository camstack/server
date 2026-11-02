/**
 * System -> Settings, the Authentication section of the `system-config`
 * addon (token lifetimes, trusted proxies/networks, allowed browser origins
 * - D707). The section is the one the addon's `getGlobalSettings` draws;
 * invented values only. `withCors: false` leaves out the CORS fields, for the
 * "before" shot (`auth-settings-before.ts`).
 */

const AUTH_SECTION = {
  id: 'system-config-auth',
  title: 'Authentication',
  description: 'Token and session settings.',
  descriptionKey: 'server:global.s_system-config-auth.description',
  columns: 1,
  fields: [
    {
      type: 'text',
      key: 'tokenExpiry',
      label: 'Session lifetime',
      labelKey: 'server:global.s_system-config-auth.tokenExpiry.label',
      description:
        'How long a sign-in lasts without being used, as a duration string (e.g. 7d, 30d). Every refresh starts it again, so a device in use stays signed in; one left unopened this long must sign in again. A bare number is rejected \u2014 it would be read as milliseconds. Applies from the next sign-in or refresh.',
      descriptionKey: 'server:global.s_system-config-auth.tokenExpiry.description',
      placeholder: '30d',
      default: '30d',
      value: '30d',
    },
    {
      type: 'text',
      key: 'accessTokenExpiry',
      label: 'Access token lifetime',
      labelKey: 'server:global.s_system-config-auth.accessTokenExpiry.label',
      description:
        'How long one access token lives before the app silently swaps it for a new one (e.g. 2h; between 5m and 24h, never longer than the session). Shorter limits how long a copied token is useful. Apps that predate refresh tokens get one token for the whole session instead.',
      descriptionKey: 'server:global.s_system-config-auth.accessTokenExpiry.description',
      placeholder: '2h',
      default: '2h',
      value: '2h',
    },
    {
      type: 'tags',
      key: 'trustedProxies',
      label: 'Trusted reverse proxies',
      labelKey: 'server:global.s_system-config-auth.trustedProxies.label',
      description:
        'Addresses or CIDR ranges (e.g. 192.168.1.2 or 10.0.0.0/24) of reverse proxies in front of the hub. Only a request whose direct sender is one of these \u2014 or this host itself, as with the Cloudflare tunnel \u2014 has its X-Forwarded-For / CF-Connecting-IP read as the real client address for rate limits. Leave empty unless a proxy on another host forwards to the hub.',
      descriptionKey: 'server:global.s_system-config-auth.trustedProxies.description',
      creatable: true,
      value: null,
    },
    {
      type: 'info',
      key: 'trustedNetworksWarning',
      label: 'Skipping two-factor authentication',
      labelKey: 'server:global.s_system-config-auth.trustedNetworksWarning.label',
      variant: 'danger',
      content:
        'A sign-in made DIRECTLY from a network listed below skips the second factor (TOTP or passkey): anyone on that network who knows or guesses a password gets in with the password alone \u2014 including a compromised camera or a guest device. Requests that come through the Cloudflare tunnel, the public address or any reverse proxy never skip it, whatever address they claim. Every skip is recorded in the authentication audit log. Leave empty (the default) to always ask for the second factor.',
    },
    {
      type: 'tags',
      key: 'trustedNetworks',
      label: 'Trusted networks (skip the second factor)',
      labelKey: 'server:global.s_system-config-auth.trustedNetworks.label',
      description:
        'Addresses or CIDR ranges, e.g. 192.168.1.0/24. Keep it as narrow as you can \u2014 a single trusted VLAN, not the whole LAN.',
      descriptionKey: 'server:global.s_system-config-auth.trustedNetworks.description',
      creatable: true,
      value: null,
    },
    {
      type: 'info',
      key: 'corsOriginsWarning',
      label: 'Browser origins and plain http',
      labelKey: 'server:global.s_system-config-auth.corsOriginsWarning.label',
      variant: 'warning',
      content:
        "A page served from a listed origin may read this hub's responses with the bearer token of whoever is signed in there. An http:// origin other than localhost or 127.0.0.1 sends that token in clear over the network \u2014 prefer https://. The hub's own address, the hosted viewer and the native app need no entry.",
    },
    {
      type: 'tags',
      key: 'corsOrigins',
      label: 'Allowed browser origins',
      labelKey: 'server:global.s_system-config-auth.corsOrigins.label',
      description:
        'Extra origins (scheme://host[:port], no path) of web pages allowed to call this hub from a browser, e.g. https://viewer.example or http://localhost:8081. Applies to the next request, no restart.',
      descriptionKey: 'server:global.s_system-config-auth.corsOrigins.description',
      creatable: true,
      value: null,
    },
  ],
}

/** The `auth-webauthn` addon's relying-party section (Identity -> Authentication). */
const WEBAUTHN_SECTION = {
  id: 'webauthn',
  title: 'WebAuthn / Passkey Settings',
  description:
    "Configure the relying-party (RP) identity baked into every enrolled passkey. RP ID MUST match the hub's public domain (or a parent of it) \u2014 changing it invalidates existing passkeys.",
  columns: 1,
  fields: [
    {
      type: 'text',
      key: 'rpName',
      label: 'Product name',
      description: 'Shown in the OS authenticator UI (e.g. "CamStack"). Cosmetic only.',
      value: 'CamStack',
    },
    {
      type: 'text',
      key: 'rpID',
      label: 'RP ID',
      description:
        'Hub domain (NO scheme, NO port). Empty = derive from the hub address in Network.',
      value: 'hub.example.com',
    },
    {
      type: 'number',
      key: 'challengeTtlSec',
      label: 'Challenge TTL (seconds)',
      description: 'How long an in-flight challenge stays valid. Default 300.',
      value: 300,
    },
  ],
}

const CORS_KEYS = new Set(['corsOriginsWarning', 'corsOrigins'])

export function authSettingsHandlers(withCors: boolean) {
  const section = {
    ...AUTH_SECTION,
    fields: AUTH_SECTION.fields
      .filter((field) => withCors || !CORS_KEYS.has(field.key))
      .map((field) =>
        field.key === 'corsOrigins' ? { ...field, value: ['http://localhost:8099'] } : field,
      ),
  }

  const hub = {
    id: 'hub',
    name: 'Hub',
    hostname: 'hub',
    platform: 'linux',
    arch: 'x64',
    cpuModel: 'Intel(R) Core(TM) i5-12500',
    cpuCores: 8,
    memoryMB: 16_000,
    engines: ['openvino'],
    isHub: true,
    isOnline: true,
    cpuPercent: 18.4,
    memoryPercent: 41.2,
    uptime: 4 * 86_400_000,
    lastSeen: '2026-01-01T12:00:00.000Z',
    localIps: ['192.0.2.2'],
    // The Settings page lists the hub's addons: only `system-config` matters here.
    addons: [
      { id: 'system-config', capabilities: [] },
      { id: 'auth-webauthn', capabilities: [] },
    ],
    processes: [],
    categories: [],
    rootPackage: { name: '@camstack/server', version: '1.2.500' },
  }

  return {
    'nodes.topology': [hub],
    'addonSettings.getGlobalSettings': (input: { addonId?: string }) => {
      if (input.addonId === 'system-config') return { sections: [section] }
      if (input.addonId === 'auth-webauthn') return { sections: [WEBAUTHN_SECTION] }
      return null
    },
  }
}
