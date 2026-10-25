/**
 * WHICH electron-updater feed each of the two products reads — the whole
 * answer, in one place, for both the publish side and the runtime.
 *
 * ── What this prevents ─────────────────────────────────────────────────────
 * One source tree ships twice (ADR-0402), and both products published to the
 * same GitHub release with the same (default) channel. electron-updater's feed
 * is ONE file per channel per platform — `latest-mac.yml`, `latest-linux.yml`,
 * `latest.yml` — so the two builds overwrote each other's. Measured on release
 * `v1.2.338`: the live `latest-mac.yml` read
 *
 *     version: 1.2.338
 *     path: CamStackViewer-1.2.338-arm64.dmg
 *
 * The viewer leg finishes last and wins, so the FULL CamStack app's macOS
 * updater was pointed at the reduced product. It failed safe only by accident:
 * Squirrel.Mac applies a `.zip`, the viewer shipped only a `.dmg`, and
 * `MacUpdater` threw `ERR_UPDATER_ZIP_FILE_NOT_FOUND` instead of installing the
 * wrong product over the right one. (ADR-0584.)
 *
 * ── The mechanism ──────────────────────────────────────────────────────────
 * `publish.channel` names the feed on BOTH sides, and the two sides must agree
 * or the fix is half a fix:
 *
 *   - publish  — app-builder-lib writes `${channel}${osSuffix}${archSuffix}.yml`
 *                (`getUpdateInfoFileName`, app-builder-lib 26.15.3);
 *   - runtime  — `GitHubProvider.channel` is `updater.channel || options.channel`
 *                (`options` being the publish config electron-builder bakes into
 *                `Resources/app-update.yml`), fed through the same suffix rules
 *                (`Provider.getChannelFilePrefix`, electron-updater 6.8.9).
 *
 * The node product KEEPS `latest`. That is not cosmetic: every CamStack desktop
 * install in the field has an `app-update.yml` with no channel in it and asks
 * for `latest-mac.yml` forever. Moving the node product would strand that
 * installed base; leaving it there rescues it the moment the viewer stops
 * overwriting its feed.
 */

import type { DesktopProduct } from './desktop-product'

/** The full app's channel. Must stay `latest`: the installed base asks for it. */
export const NODE_UPDATE_CHANNEL = 'latest'

/** The reduced app's channel — `viewer-mac.yml`, `viewer-linux.yml`, `viewer.yml`. */
export const VIEWER_UPDATE_CHANNEL = 'viewer'

/** The platforms electron-updater names a feed file for. */
export const UPDATE_FEED_PLATFORMS = ['darwin', 'linux', 'win32'] as const

export type UpdateFeedPlatform = (typeof UPDATE_FEED_PLATFORMS)[number]

/** Pure: the update channel this product publishes to and reads from. */
export function updateChannelForProduct(product: DesktopProduct): string {
  return product === 'viewer' ? VIEWER_UPDATE_CHANNEL : NODE_UPDATE_CHANNEL
}

/**
 * Pure: the feed file a channel resolves to, replicating the naming both
 * electron-builder and electron-updater apply. `arch` is the build/runtime
 * architecture; only linux carries it, and only when it is not x64.
 */
export function updateFeedFileName(
  channel: string,
  platform: UpdateFeedPlatform,
  arch: string,
): string {
  if (platform === 'darwin') return `${channel}-mac.yml`
  if (platform === 'win32') return `${channel}.yml`
  return arch === 'x64' ? `${channel}-linux.yml` : `${channel}-linux-${arch}.yml`
}
