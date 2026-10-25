/**
 * The two knobs the clip-catalog refresh exposes, and the words that stop them
 * meaning two things silently.
 *
 * Both are declared HERE and read in `clip-refresh.ts` / `addon.ts` in the
 * same change. `scripts/check-settings-key-has-reader.ts` fails a settings key
 * whose only appearances are declaration-shaped, and it is right to: this repo
 * has shipped nine knobs that wrote a store nobody read. That guard is the
 * reason the refresh was designed in the morning and not declared until its
 * reader existed.
 */
import type { ConfigUISchema } from '@camstack/types'
import {
  CLIP_CATALOG_FORCED_WAKE_KEY,
  CLIP_CATALOG_REFRESH_MINUTES_DEFAULT,
  CLIP_CATALOG_REFRESH_MINUTES_KEY,
  CLIP_CATALOG_REFRESH_MINUTES_MAX,
  CLIP_CATALOG_REFRESH_OFF,
} from './clip-refresh.js'

/** The section id, so the addon's declaration and this schema cannot drift. */
export const CLIP_REFRESH_SECTION_ID = 'clip-catalog-refresh'

/**
 * The one sentence the interval must always carry.
 *
 * It does TWO different things depending on what the camera is, and a knob
 * that silently means two things on two cameras is how this repo has shipped
 * settings nobody could reason about. So the difference is in the operator's
 * own text, at both levels, not only in a record.
 */
export const CLIP_CATALOG_REFRESH_MINUTES_DESCRIPTION =
  'On a standalone battery camera the timer only marks the catalog as ageing; it never wakes the camera. 0 turns it off.'

export const CLIP_CATALOG_FORCED_WAKE_DESCRIPTION =
  'Let the timer wake a standalone battery camera: one wake per interval, at the battery’s cost. No effect on hub children or mains cameras.'

/**
 * The addon-level (global) default. Per-camera overrides live on the device,
 * under the SAME key, and a device that sets nothing — or resets — resolves to
 * this value (`resolveClipCatalogRefreshMinutes`).
 */
export function buildClipRefreshSettingsSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: CLIP_REFRESH_SECTION_ID,
        title: 'Clip catalog refresh',
        description:
          'Default for every camera; a camera can override it in its Recording settings.',
        columns: 1,
        fields: [
          {
            type: 'number',
            key: CLIP_CATALOG_REFRESH_MINUTES_KEY,
            label: 'Refresh interval (min)',
            description: CLIP_CATALOG_REFRESH_MINUTES_DESCRIPTION,
            default: CLIP_CATALOG_REFRESH_MINUTES_DEFAULT,
            min: CLIP_CATALOG_REFRESH_OFF,
            max: CLIP_CATALOG_REFRESH_MINUTES_MAX,
            step: 5,
          },
        ],
      },
    ],
  }
}

/**
 * The per-camera section: the interval override, and — only where it can mean
 * anything — the forced wake.
 *
 * `forcedWake` is a plain persisted switch on purpose. It is NOT a
 * `device-action-button` and there is no custom action behind it, so nothing
 * that dispatches device actions (a schedule, an automation, a rule) can spend
 * a battery camera's wakes; the only way to turn it on is an operator editing
 * this camera's settings.
 */
export function buildClipRefreshDeviceSection(input: {
  readonly isHubChild: boolean
  readonly isBattery: boolean
}): readonly ConfigUISchema['sections'][number][] {
  const forcedWakeApplies = input.isBattery && !input.isHubChild
  return [
    {
      id: CLIP_REFRESH_SECTION_ID,
      tab: 'recording',
      title: 'Clip catalog refresh',
      description: 'Leave the interval empty to use the default from the Reolink addon settings.',
      columns: 1,
      fields: [
        {
          type: 'number',
          key: CLIP_CATALOG_REFRESH_MINUTES_KEY,
          label: 'Refresh interval (min)',
          description: CLIP_CATALOG_REFRESH_MINUTES_DESCRIPTION,
          min: CLIP_CATALOG_REFRESH_OFF,
          max: CLIP_CATALOG_REFRESH_MINUTES_MAX,
          step: 5,
        },
        // Hidden where it would be inert: a switch that does nothing on this
        // camera is a switch the operator has to learn to ignore, and D62's
        // rule is that a knob names the authority it writes or it does not
        // ship. A hub child and a mains camera are never woken by this timer.
        ...(forcedWakeApplies
          ? [
              {
                type: 'boolean' as const,
                key: CLIP_CATALOG_FORCED_WAKE_KEY,
                label: 'Wake this camera to refresh',
                description: CLIP_CATALOG_FORCED_WAKE_DESCRIPTION,
                default: false,
                style: 'switch' as const,
              },
            ]
          : []),
      ],
    },
  ]
}
