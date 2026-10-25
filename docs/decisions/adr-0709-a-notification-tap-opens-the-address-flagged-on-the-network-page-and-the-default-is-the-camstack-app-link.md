---
id: D709
title: A notification tap opens the address flagged on the Network page, and the default is the CamStack app link
status: accepted
date: 2026-10-06
supersedes:
applies-to:
  - packages/types/src/capabilities/viewer-link-url.ts
  - packages/types/src/capabilities/local-network.cap.ts
  - packages/system/src/builtins/local-network/local-network.addon.ts
  - packages/addon-post-analysis/src/notification-center/default-tap-url.ts
  - packages/addon-post-analysis/src/notification-center/artifact-plane.ts
  - packages/addon-admin-ui/src/pages/system/NetworkAddresses.tsx
---

## Context

A notification tap on a camera opened `<hub base>/viewer/camstack/camera/<id>?at=<ts>`,
with the base taken from the notification endpoint ladder. On a phone with the
CamStack app installed, that opened a browser, not the app. Only the central
link domain `https://camstack.zentik.app` can open the app, because the app
claims it as a Universal Link / App Link
(`docs/design/2026-08-19-central-link-redirect.md`).

Phase 2 of that design proposed a static rule: phone-push notifier kinds would
always get the central link, and chat kinds would always get the direct link.
On 2026-10-06 the operator rejected a central link that cannot be changed. The
choice has to start on the admin **Network** page, which already chooses the
address notification links use.

The first cut added a separate "link target: hub | app" setting next to the
notification endpoint. That was a second authority for one question. Then the
operator pointed out that the Network page already flags ONE address for
notifications (`local-network.setNotificationEndpoint`, the Notifications
column of the endpoint table). That flag is the setting. Its default had to
change.

## Decision

> **Amended by [D732](./adr-0732-a-hub-address-is-a-row-with-role-flags-and-custom-addresses-are-rows-like-detected-ones.md), 2026-10-06.** The flag is now the
> `notifications` role of one Addresses table. A typed custom address is a
> custom ROW carrying the flag, not a free value; the stored D709 value is
> migrated into one in the read path. `notificationBaseUrl` stays the store.

The address a viewer link opens is the address flagged for notifications on
the Network page. There is one store (`local-network`'s
`notificationBaseUrl`) and no second setting.

- `local-network.getConnectionEndpoints({ includeAppLink: true })` adds one
  generic entry to the palette. It is the **CamStack app link**,
  `https://camstack.zentik.app`, with `kind: 'app-link'`. It is never raced
  and never ranked: only the Network page asks for it.
- **AUTO (no explicit flag) resolves to the app link.** This is the operator's
  decision of 2026-10-06 and a change of default: before D709, AUTO resolved
  to the public tunnel, then the mesh. The operator can still flag any of the
  hub's own addresses (LAN, tunnel, Tailscale) or type a custom one.
- With the app link flagged, a viewer tap is
  `https://camstack.zentik.app/<viewer path>?<params>&hub=<hub origin>`. The
  `hub=` value is `getNotificationEndpoint().appLinkHub`. It is computed by
  `pickAppLinkHub` from the same cap's own palette: the public tunnel first,
  then Tailscale MagicDNS, HTTPS only. It can never disagree with the
  addresses the page lists. With no such address, the link is minted without
  `hub=`, and the central page asks for the hub once (design §5).
- With a hub address flagged, a viewer tap is
  `<that base>/viewer/camstack/<viewer path>?<params>`, which is the pre-D709
  form.
- Viewer paths are the routes the app claims in its AASA: `/camera/*`,
  `/events*` and `/notifications*`. Only `buildViewerLink` (`@camstack/types`)
  assembles a viewer link. The NC's default tap and the Network page's live
  preview both call it, and both read the endpoint through `viewerLinkBaseOf`.
- **The app link is not a hub address.** Admin-UI destinations (an addon
  update → `/system/addons`), signed media links and action buttons always use
  the hub ladder (`collectArtifactEndpoints` drops a flagged app link). The
  central domain hosts the viewer only.
- A rule-authored `clickUrl` still wins.
- If the flag cannot be read, the tap falls back to the hub form. The
  fallback logs a warning.

## Consequences

- Phones with the app installed open the app on every default tap, with no
  operator action. An appless phone lands on the hosted viewer, and that page
  needs `hub=` or one prior visit.
- The hub's public tunnel or MagicDNS hostname now rides in every default
  tap. The design (§6) argues this is no new disclosure, because the hub-form
  tap IS that hostname. An operator who objects flags a hub address instead.
- `NotificationEndpoint` grew `appLinkHub`, `ConnectionEndpoint.kind` grew
  `'app-link'`, and `getConnectionEndpoints` grew `includeAppLink`. Every
  exhaustive switch over the kind must handle `'app-link'` (the
  connect-a-phone ranking returns `null`). This is a framework change: it is
  live only with a `@camstack/server` that contains it. A pre-D709 hub never
  resolves to the app link, so the NC reading it keeps the hub form.
- The per-notifier-kind table of the design's §5 is not implemented. The form
  is one install-wide choice, as the operator asked.

## Enforcement

- `scripts/check-viewer-link-builder-is-the-only-source.ts` (CI `checks.yml`):
  no literal `camstack.zentik.app` outside `viewer-link-url.ts`, and no literal
  `/viewer/camstack` in the notification centre.
- Tests: `viewer-link-url.spec.ts` (forms, `hub=`, AASA paths,
  `pickAppLinkHub`), `local-network.spec.ts` (the app-link entry and its
  `hub=` from the palette), `default-tap-url.spec.ts`,
  `dispatcher-app-link-tap.spec.ts` (end to end through the dispatcher; an
  admin tap stays on the hub), `artifact-plane.spec.ts` (a flagged app link
  never becomes a media base), and `notification-link-model.spec.ts` plus
  `NotificationLinkCard.spec.tsx` (preview and custom address).

## Amendment — 2026-10-07: the flag decides the tap only (D734)

The flagged address (now the **Notification taps** role, `notificationTaps`)
decides only where a tap opens. Action buttons, attachment / media links and
admin links follow the **Public endpoint** role instead of leading with this
flag. See
[D734](adr-0734-address-roles-are-named-for-what-they-serve-and-notification-links-follow-the-public-endpoint.md).
