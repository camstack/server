/**
 * The "apply these updates" button on an `addon-update-available` notification.
 *
 * Pure, and like `action-buttons.ts` the interesting rules are all about
 * REFUSING to mint. Three of them, and each is a decision rather than a guard:
 *
 *  - **Only `addon-update-available`.** `server-update-available` is a
 *    different family (D325) — a node reboot, not an addon apply. That kind
 *    mints `server-update-apply`, not this button. D305 still sends it to the
 *    Cluster page, which is the tap target of the notification itself.
 *  - **One node, named.** The row's `nodeId` is set by the intake only when
 *    every package belongs to the same node. A row spanning nodes gets NO
 *    button: the caller logs it, and a fleet-wide restart from a button whose
 *    label could not honestly say where it lands is exactly the blunt action
 *    that must not exist. In practice the hub's emitter announces one scope per
 *    event (`UpdateAvailabilityEmitter.emitList`), so this is a refusal the
 *    operator should never meet — which is the point of it being a refusal and
 *    not a fallback.
 *  - **A package list, non-empty.** `packageNames` is frozen on the outbox row
 *    at intake and is the whole of what the button will apply.
 *  - **An OWNED target.** The snooze button already refuses a destination
 *    nobody owns, and this one follows it — for a stronger reason. A sequence
 *    button is opt-in per rule ("do not author one for a sequence you would not
 *    want a forwarded screenshot to run", D47); this one appears on EVERY
 *    `addon-update-available` notification of every rule, so the operator never
 *    made that choice per button. Narrowing it to destinations that belong to a
 *    person is the choice made for them: a shared family channel gets the tap
 *    URL to `/system/addons`, which asks who is holding the phone, instead of a
 *    link that restarts a node for whoever scrolled past it.
 *
 * What it deliberately does NOT carry:
 *
 *  - **A version.** See {@link NcAddonUpdateGrant} — D313.
 *  - **An icon.** `NotificationActionIcon` is a closed, TRAIN-BOUND vocabulary:
 *    an addon that emits a token the running hub's Zod does not know does not
 *    lose the icon, it loses the whole `send`. There is no member meaning
 *    "update", and inventing one here would silently delete this notification
 *    on every hub older than the train carrying it.
 *
 * `destructive: true` is set, and it is a RENDERING hint only (D47). It is
 * here because the button sits beside "Snooze 10 min" on the same lock screen
 * and the two must not look alike: one silences a message, the other restarts
 * every addon on a node.
 */

import type { NcSystemEventKind, NotificationAction } from '@camstack/types'

/** The id this button travels under — in the callback and in the audit line. */
const ADDON_UPDATE_BUTTON_ID = 'addon-update-apply'

/** Mint the callback URL for the button, and register what it may run. */
export type NcAddonUpdateUrlMinter = (input: {
  readonly actionId: string
  readonly packages: readonly string[]
  readonly nodeId: string
}) => string

/**
 * Exactly the frozen row fields this decision is a function of.
 *
 * Named rather than taking the whole `systemEvent`, so the reader can see that
 * nothing else — no version, no sentence, no `data` bag — reaches it.
 */
export interface AddonUpdateButtonSubject {
  readonly kind: NcSystemEventKind
  /** Every package the row named, frozen at intake. */
  readonly packageNames?: readonly string[]
  /** The one node, when the intake found a single answer. */
  readonly nodeId?: string
}

/** Who this delivery was addressed to. Absent for a destination nobody owns. */
export type AddonUpdateButtonRecipient = { readonly ownerUserId?: string }

export interface BuildAddonUpdateButtonInput {
  readonly subject: AddonUpdateButtonSubject
  readonly recipient: AddonUpdateButtonRecipient
  readonly mintUrl: NcAddonUpdateUrlMinter
  /** How the button is worded, in the hub's language. Injected so this stays
   *  pure and the text catalog stays the one place words live. */
  readonly label: (input: { readonly count: number; readonly nodeId: string }) => string
}

/** Why no button was minted. `null` = one was. Exported so the caller can LOG
 *  the drop: a branch that silently produces nothing reads as "never happened",
 *  and "why has this notification no button" must be answerable from a line. */
export type AddonUpdateButtonRefusal =
  | 'not-an-addon-update'
  | 'no-packages'
  | 'several-nodes'
  | 'unowned-target'

export function addonUpdateButtonRefusal(
  subject: AddonUpdateButtonSubject,
  recipient: AddonUpdateButtonRecipient,
): AddonUpdateButtonRefusal | null {
  if (subject.kind !== 'addon-update-available') return 'not-an-addon-update'
  if ((subject.packageNames ?? []).length === 0) return 'no-packages'
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
export function buildAddonUpdateButtons(
  input: BuildAddonUpdateButtonInput,
): readonly NotificationAction[] {
  const subject = input.subject
  if (addonUpdateButtonRefusal(subject, input.recipient) !== null) return []
  const packages = subject.packageNames ?? []
  const nodeId = subject.nodeId ?? ''
  return [
    {
      id: ADDON_UPDATE_BUTTON_ID,
      label: input.label({ count: packages.length, nodeId }),
      url: input.mintUrl({ actionId: ADDON_UPDATE_BUTTON_ID, packages, nodeId }),
      destructive: true,
      // The result is a NOTIFICATION, not a page: the plane answers a
      // background POST with one line nobody reads, and the outcome arrives as
      // its own message minutes later. Opening a browser tab to watch a
      // `text/plain` "Done" would be the least informative thing this button
      // could do.
      mode: 'background',
    },
  ]
}
