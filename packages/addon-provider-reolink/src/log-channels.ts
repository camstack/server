/**
 * The diagnostic log CHANNELS `provider-reolink` declares.
 *
 * Only this addon knows these exist. What "the Baichuan control channel" and
 * "the login handshake" mean is knowledge of the Reolink provider, and a
 * central list elsewhere would rot the first time a vendor quirk earns a third
 * channel — silently, because nothing fails when a list is merely incomplete.
 *
 * The VALUE — armed or not, for which cameras, until when — is not here. It
 * lives in the one logging settings document on the `system` cap. These are
 * declarations: inert, no state.
 *
 * ## Both are honestly per-camera, and here is why
 *
 * `ReolinkCamera` logs through `this.ctx.logger`, which the kernel builds as
 * `logger.child(stableId).withTags({ deviceId })` with the NUMERIC id
 * (`device-cap-proxy.ts`), and `ScopedLogger` merges its bound tags into every
 * line. So every line these channels admit carries `tags.deviceId`, and
 * `| json | deviceId="102"` selects exactly one camera. That is the repo rule
 * from `CLAUDE.md` — paid for with a 22% thumbnail gap and a 3-hour media
 * blackout diagnosed by hand — finally paying out.
 *
 * The hub's own dispatch lines are a different matter: `reolink-hub.ts` puts
 * the CHILD's id in `meta` and carries the HUB's id in `tags`, so those lines
 * are not per-camera filterable. Neither channel below claims them.
 */

import { declareLogChannel } from '@camstack/types'

/**
 * The Baichuan control channel itself: every protocol frame the lib sends and
 * receives, UDP keepalives, and the sleep-inference ticks on a battery camera.
 *
 * Consulted in `ReolinkCamera.getBaichuanDebugOptions`, the single place the
 * lib's `general` debug option is decided, so arming this channel turns on the
 * same protocol trace the per-camera `debugGeneral` switch does — through the
 * same funnel, with a deadline instead of forever.
 *
 * The lib is handed `libLoggerAdapter()`, which writes through
 * `this.ctx.logger.child('nodelink')` — `child()` preserves bound tags, so the
 * device tag survives and the per-camera promise holds.
 */
export const CH_BAICHUAN = declareLogChannel({
  name: 'provider-reolink.baichuan',
  description:
    'Every Baichuan protocol frame this camera sends and receives. Loud: arm it for one camera and a short window.',
  defaultLevel: 'info',
  perDevice: true,
})

/**
 * The login ceremony and the socket lifecycle around it: the pre-login dial,
 * the battery-camera wake that a login IS, login failures on a per-stream
 * RFC 4571 socket, and every reconnect that follows one.
 *
 * Consulted where the camera decides to dial and where it schedules a
 * reconnect — the two moments that explain a camera which is "there" in the
 * UI and answering nothing.
 */
export const CH_HANDSHAKE = declareLogChannel({
  name: 'provider-reolink.handshake',
  description:
    'Login and socket lifecycle for this camera. Arm it when a camera looks present but answers nothing.',
  defaultLevel: 'info',
  perDevice: true,
})
