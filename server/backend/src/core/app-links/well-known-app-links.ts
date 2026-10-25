/**
 * well-known-app-links — the two files a Universal/App Link needs the DOMAIN
 * to vouch for.
 *
 * The viewer app already declares `applinks:<domain>` (iOS) and an
 * `autoVerify` intent filter (Android) — what was missing is the other half
 * of the handshake: the domain serving `/.well-known/apple-app-site-association`
 * and `/.well-known/assetlinks.json`. Modelled on the Zentik notifier, which
 * runs this exact pair in production.
 *
 * The AASA scopes the app to the viewer mount only (`/viewer/camstack/*`):
 * the hub root also serves the admin UI and data planes, and a tap on those
 * must stay in the browser.
 *
 * Android's verification additionally needs the signing-cert SHA-256
 * fingerprints, which live in the EAS keystore and cannot be derived here —
 * they arrive via `CAMSTACK_ANDROID_CERT_SHA256` (comma-separated). Empty is
 * ACCEPTED and produces a valid file that fails auto-verification (the OS
 * shows a disambiguation dialog): same trade-off the Zentik file ships with.
 */

/** Apple team + bundle ids, mirrored from the viewer's app.config.ts. */
const APPLE_TEAM_ID = 'C3F24V5NS5'
const BUNDLE_ID = 'com.apocaliss92.camstack'
const BUNDLE_ID_DEV = 'com.apocaliss92.camstack.dev'

/** The only path family the app claims on this domain. */
const VIEWER_COMPONENT = '/viewer/camstack/*'

export interface AppLinkFiles {
  readonly appleAppSiteAssociation: Record<string, unknown>
  readonly assetLinks: readonly Record<string, unknown>[]
}

export function buildAppLinkFiles(androidCertSha256: readonly string[]): AppLinkFiles {
  const appIds = [`${APPLE_TEAM_ID}.${BUNDLE_ID}`, `${APPLE_TEAM_ID}.${BUNDLE_ID_DEV}`]
  return {
    appleAppSiteAssociation: {
      applinks: {
        apps: [],
        details: [
          {
            appIDs: appIds,
            components: [{ '/': VIEWER_COMPONENT, comment: 'Viewer deep links' }],
          },
          // Legacy `paths` block for pre-iOS-13 parsers, as Zentik ships.
          { appID: appIds[0], paths: [VIEWER_COMPONENT] },
        ],
      },
      webcredentials: { apps: appIds },
    },
    assetLinks: [BUNDLE_ID, BUNDLE_ID_DEV].map((pkg) => ({
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: pkg,
        sha256_cert_fingerprints: [...androidCertSha256],
      },
    })),
  }
}

/** Parse the comma-separated env form; junk and empties dropped. */
export function parseCertFingerprints(raw: string | undefined): readonly string[] {
  if (raw === undefined) return []
  return raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/.test(s))
}
