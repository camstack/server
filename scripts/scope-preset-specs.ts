/**
 * The scope-preset SPECS — the single definition read by both
 * `generate-scope-presets.ts` (which emits `SCOPE_PRESETS`) and
 * `check-scope-preset-promises.ts` (which holds each preset's prose to what its
 * rows can actually reach).
 *
 * Separate module because the generator WRITES on import: a check script that
 * imported it would rewrite a generated file as a side effect of reading a
 * constant.
 */

export interface PresetSpec {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly rows: readonly PresetRow[]
  /**
   * The caps this preset's `description` NAMES to an operator, written down so
   * the promise is checkable. NOT emitted — `scripts/check-scope-preset-promises.ts`
   * reads it and fails the build when a named cap has no method any row of this
   * preset can reach.
   *
   * This is a hand-maintained list on purpose, and it is not the allowlist this
   * generator's header warns against: the ROWS stay derived (a new device cap
   * is still inherited by `category:device` with no edit here). What is written
   * down is only the prose claim, so that prose cannot quietly become false.
   *
   * It became necessary because it already had: `camera-operator` promised
   * "intercom" from the initial commit while every `intercom` method was
   * `auth: 'admin'`, which `adminProcedure` refuses BEFORE the scope check ever
   * runs. The grant was correct, complete, and unreachable for three months
   * (D289).
   */
  readonly promisedCaps?: readonly string[]
}

export type PresetRow =
  | {
      type: 'category'
      target: 'device' | 'system'
      access: readonly ('view' | 'create' | 'delete')[]
    }
  | { type: 'capability'; target: string; access: readonly ('view' | 'create' | 'delete')[] }
  | { type: 'addon'; target: string; access: readonly ('view' | 'create' | 'delete')[] }

export const PRESETS: readonly PresetSpec[] = [
  {
    id: 'camera-viewer',
    label: 'Camera viewer',
    description:
      'Read-only over every device — live streams, recordings, motion events, battery state. Pair with a `device` grant (an `ids` / `types` / `locations` selector) to restrict to specific cameras.',
    rows: [{ type: 'category', target: 'device', access: ['view'] }],
  },
  {
    id: 'camera-operator',
    label: 'Camera operator',
    description:
      'Everything `camera-viewer` does plus live control of every granted camera — PTZ movement, intercom talk-back and on-demand snapshots. Cannot delete devices, and grants nothing on system-scope caps (recording control, users, addons).',
    rows: [{ type: 'category', target: 'device', access: ['view', 'create'] }],
    // `recording` is deliberately absent: it is a `scope: 'system'` cap, so no
    // `category:device` row reaches it. The description used to claim
    // "recording start/stop" — it never granted that.
    promisedCaps: ['ptz', 'intercom', 'snapshot'],
  },
  {
    id: 'full-management',
    label: 'Full management',
    description:
      'Complete device + system control short of admin: view/create/delete on every device and every system capability. Use for a trusted operator who manages the whole deployment but should not hold the admin bypass.',
    rows: [
      { type: 'category', target: 'device', access: ['view', 'create', 'delete'] },
      { type: 'category', target: 'system', access: ['view', 'create', 'delete'] },
    ],
  },
  {
    id: 'cli-deployer',
    label: 'CLI deployer',
    description:
      'Push addons to the hub and tail their logs. Used by the `camstack` CLI on dev machines. No delete access — a stolen token cannot uninstall.',
    rows: [{ type: 'capability', target: 'addons', access: ['view', 'create'] }],
  },
  {
    id: 'event-listener',
    label: 'Event listener',
    description:
      'Subscribe to motion / audio events. Used by webhook bridges and Home Assistant integrations.',
    rows: [
      { type: 'capability', target: 'motion-detection', access: ['view'] },
      { type: 'capability', target: 'audio-analysis', access: ['view'] },
    ],
    // `audio-analysis` is what this preset actually buys. The
    // `capability:events[view]` row was removed on 2026-09-24 with the `events`
    // cap itself — it had never had a provider (the hub answered every
    // `events.*` call 412) so the row bought nothing before the deletion
    // either, and `check-scope-preset-promises` goes red on a promise naming a
    // cap that does not exist. `motion-detection` is NOT promised: that row is
    // inert, because the cap has no `view`-access method at all (`analyze` is
    // `create`, `reset` and `removeCamera` are `delete`). Left in place rather
    // than removed — dropping a row an operator may already hold is a separate,
    // operator-visible decision, not a drive-by (D289).
    promisedCaps: ['audio-analysis'],
  },
] as const
