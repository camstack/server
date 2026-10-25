/**
 * default-tap-url — where a notification tap lands when the rule authors
 * nothing.
 *
 * Operator decision (2026-08-18, closing D1 of
 * docs/design/2026-08-18-notification-click-actions.md): the default is the
 * CAMERA AT THAT TIMELINE — the viewer's `/camera/[id]` route with its `?at=`
 * recorded seek — not the live view and not the event detail. The web form is
 * used because it resolves from a cold start on every surface today
 * (the hub serves the SPA shell for any `/viewer` path, and an existing hub
 * session bootstraps without a login screen); the `camstack://` app form
 * waits on D2 (does Zentik NAVIGATE survive a custom scheme?).
 *
 * **Which address** (D709, D734): the one flagged as **Notification taps**
 * on the admin Network page — the `notificationTaps` role, read through
 * `local-network.getNotificationEndpoint`. By default that is the CamStack
 * app link, and a tap is `https://camstack.zentik.app/camera/<id>?at=…&hub=
 * <hub origin>` — the native app opens when installed, the hosted viewer
 * otherwise. When the operator flags one of the hub's own addresses instead,
 * the tap is `<that base>/viewer/camstack/camera/<id>?at=…`. The URL itself is
 * assembled by `buildViewerLink` (@camstack/types).
 *
 * Only the TAP follows that role. Everything else a notification points at
 * off the LAN — action buttons, attachment and media links, and the admin
 * page a SYSTEM event taps into — is built on the **Public endpoint** role
 * (`publicBaseUrl` here; the artifact plane's ladder). An app link is no hub
 * address, so it could never carry those, and a hub address chosen for taps
 * says nothing about where a signed link must resolve.
 *
 * A rule-authored `clickUrl` (per-target params) always wins over this.
 * An unknown camera gets NO url — a tap that lands nowhere teaches the
 * operator the affordance is broken. And no reachable base means no URL: a
 * dead link is worse than none (same rule as the artifact plane).
 *
 * **A system event taps into the ADMIN UI, not the viewer** (2026-08-30). The
 * mapping is one module — `system-event-tap-url.ts` — and this function stays
 * the single owner of "where a tap lands", dispatching to it, so there is
 * never a second place a caller could ask.
 */

import type { ViewerLinkBase } from '@camstack/types'
import { buildViewerLink } from '@camstack/types'
import type { NcSystemEventTapSubject } from './system-event-tap-url.js'
import { systemEventTapUrl } from './system-event-tap-url.js'

export interface DefaultTapUrlInput {
  readonly deviceId: number
  readonly timestampMs: number
  /**
   * The `notificationTaps` role as a link base (`viewerLinkBaseOf` over
   * `getNotificationEndpoint`): the app form, or the hub address flagged for
   * taps. `null` = the role could not be read; a camera tap then opens the
   * hub viewer on the public endpoint, which still opens. Never applies to a
   * system event: the central domain hosts the viewer, not the admin UI.
   */
  readonly tap: ViewerLinkBase | null
  /** The `publicEndpoint` base (admin destinations); null = nothing reachable. */
  readonly publicBaseUrl: string | null
  /**
   * Set when the notification is about a system event. Its presence — not a
   * boolean — is what makes this a system tap, and its fields decide WHICH
   * admin page. See `system-event-tap-url.ts`.
   */
  readonly systemEvent?: NcSystemEventTapSubject
}

/**
 * The tap URL, or null. In the app form a camera link is minted even with no
 * `hub=` — the central page reaches the hub through the app's (or the
 * browser's) own stored hub (central-link design §5). The hub form and every
 * admin destination still need a base.
 */
export function defaultTapUrl(input: DefaultTapUrlInput): string | null {
  const publicBaseUrl =
    input.publicBaseUrl === null || input.publicBaseUrl.length === 0 ? null : input.publicBaseUrl
  if (input.systemEvent !== undefined) {
    return publicBaseUrl === null ? null : systemEventTapUrl(input.systemEvent, publicBaseUrl)
  }
  const destination = {
    kind: 'camera',
    deviceId: input.deviceId,
    atMs: input.timestampMs,
  } as const
  const base: ViewerLinkBase = input.tap ?? { form: 'hub', hubBaseUrl: publicBaseUrl }
  return buildViewerLink({ base, destination })
}
