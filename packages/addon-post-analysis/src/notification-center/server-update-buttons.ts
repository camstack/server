/**
 * The "apply this server update" button on a `server-update-available`
 * notification.
 *
 * Pure, and like `addon-update-buttons.ts` the interesting rules are all about
 * REFUSING to mint. Three of them, each a decision rather than a guard:
 *
 *  - **Only `server-update-available`.** Addon updates are a different family
 *    (D324). Mixing them would apply a node reboot through a grant that was
 *    written to restart addons, or the reverse.
 *  - **One node, named.** The row's `nodeId` is set by the intake only when
 *    every package belongs to the same node. A row spanning nodes gets NO
 *    button: rebooting a fleet from a button whose label could not honestly
 *    say where it lands is exactly the blunt action that must not exist. In
 *    practice the hub's emitter announces one scope per event, so this is a
 *    refusal the operator should never meet — which is the point of it being
 *    a refusal and not a fallback.
 *  - **An OWNED target.** Same blast-radius reasoning as the addon-update
 *    button: this one appears on EVERY `server-update-available` notification
 *    of every rule, so the operator never chose it per button. A shared family
 *    channel gets the D305 tap URL to `/system/nodes`, which asks who is
 *    holding the phone, instead of a link that reboots a node for whoever
 *    scrolled past it.
 *
 * What it deliberately does NOT carry:
 *
 *  - **A version.** See {@link NcServerUpdateGrant} — D313. The authority is
 *    `serverManagement.checkServerUpdate` at tap time; pinning the row's
 *    `latestVersion` would stage whatever the 6-hourly check observed.
 *  - **An icon.** Same closed train-bound vocabulary as D324: there is no
 *    member meaning "update", and inventing one would silently delete this
 *    notification on every hub older than the train carrying it.
 *
 * `destructive: true` is a RENDERING hint only (D47). The button sits beside
 * "Snooze 10 min" on the same lock screen and the two must not look alike: one
 * silences a message, the other reboots a node.
 *
 * D324's "server-update-available gets none" is reversed by D325. The tap URL
 * of the notification itself stays `/system/nodes?node=` — the button is
 * the other half of that page, not a replacement for it.
 */

import type { NcSystemEventKind, NotificationAction } from '@camstack/types'

/** The id this button travels under — in the callback and in the audit line. */
const SERVER_UPDATE_BUTTON_ID = 'server-update-apply'

/** Mint the callback URL for the button, and register what it may run. */
export type NcServerUpdateUrlMinter = (input: {
  readonly actionId: string
  readonly nodeId: string
}) => string

/**
 * Exactly the frozen row fields this decision is a function of.
 *
 * Named rather than taking the whole `systemEvent`, so the reader can see that
 * nothing else — no version, no sentence, no `data` bag — reaches it.
 */
export interface ServerUpdateButtonSubject {
  readonly kind: NcSystemEventKind
  /** The one node, when the intake found a single answer. */
  readonly nodeId?: string
}

/** Who this delivery was addressed to. Absent for a destination nobody owns. */
export type ServerUpdateButtonRecipient = { readonly ownerUserId?: string }

export interface BuildServerUpdateButtonInput {
  readonly subject: ServerUpdateButtonSubject
  readonly recipient: ServerUpdateButtonRecipient
  readonly mintUrl: NcServerUpdateUrlMinter
  /** How the button is worded, in the hub's language. Injected so this stays
   *  pure and the text catalog stays the one place words live. */
  readonly label: (input: { readonly nodeId: string }) => string
}

/** Why no button was minted. `null` = one was. Exported so the caller can LOG
 *  the drop: a branch that silently produces nothing reads as "never happened",
 *  and "why has this notification no button" must be answerable from a line. */
export type ServerUpdateButtonRefusal = 'not-a-server-update' | 'several-nodes' | 'unowned-target'

export function serverUpdateButtonRefusal(
  subject: ServerUpdateButtonSubject,
  recipient: ServerUpdateButtonRecipient,
): ServerUpdateButtonRefusal | null {
  if (subject.kind !== 'server-update-available') return 'not-a-server-update'
  if (subject.nodeId === undefined) return 'several-nodes'
  if (recipient.ownerUserId === undefined) return 'unowned-target'
  return null
}

/**
 * The button, or none.
 *
 * Returns an array rather than a nullable, so the caller composes it with the
 * other families by spreading — and so "which buttons survived" has one shape.
 */
export function buildServerUpdateButtons(
  input: BuildServerUpdateButtonInput,
): readonly NotificationAction[] {
  const subject = input.subject
  if (serverUpdateButtonRefusal(subject, input.recipient) !== null) return []
  const nodeId = subject.nodeId ?? ''
  return [
    {
      id: SERVER_UPDATE_BUTTON_ID,
      label: input.label({ nodeId }),
      url: input.mintUrl({ actionId: SERVER_UPDATE_BUTTON_ID, nodeId }),
      destructive: true,
      // The result is a NOTIFICATION, not a page: the plane answers a
      // background POST with one line nobody reads, and the outcome arrives as
      // its own message. Opening a browser tab to watch a `text/plain` "Done"
      // would be the least informative thing this button could do. Applying the
      // hub kills this process; the start announcement must leave first.
      mode: 'background',
    },
  ]
}
