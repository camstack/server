/**
 * The grid's own section on the camera page — built HERE, not derived by the
 * framework.
 *
 * The section this returns is what `getDeviceSettingsContribution` hands the
 * device-page aggregation. It carries the layout widget, and it carries the
 * placement with it: the addon names its own tab, location and order, the way
 * any other setting does.
 *
 * The alternative the framework offers — a `deviceConfig.ui` block on the cap —
 * renders the same widget, and is what seven other widgets still use. It was
 * rejected here for two reasons that are not cosmetic:
 *
 *  - placement would be a CAP declaration, so changing where a grid's editor
 *    lives would mean a framework change and a published server;
 *  - it cannot DECLINE. A `deviceConfig.ui` section is emitted for every device
 *    the cap is bound to, so a camera that is not a grid would get a panel that
 *    renders its own "this is not a grid" state — a UI that exists to say it
 *    should not exist.
 *
 * `recording` is the precedent (`recorder/recording-device-settings.ts`):
 * returning `null` is how it keeps the Recording tab off a device that is not
 * a camera.
 */
import type { ConfigUISchema } from '@camstack/types'

/** The widget id, registered in `ui-library`'s `HOST_WIDGETS`. */
export const GRID_LAYOUT_WIDGET_ID = 'host/camera-grid-layout'

/**
 * The layout section, or `null` when this device is not a grid.
 *
 * `isGrid` is the ANSWER to "is this a grid", never "do we know yet". A caller
 * that cannot tell must not call this — an unresolved read rendered as `null`
 * would hide the editor from a real grid (D315).
 */
export function buildGridDeviceSchema(isGrid: boolean): ConfigUISchema | null {
  if (!isGrid) return null
  return {
    sections: [
      {
        id: 'camera-grid-layout',
        // Config, not a top tab. A section with no `location` falls into the
        // device page's Config tab and is grouped into a sub-tab by its `tab`
        // id (`DeviceAggregateSection`: the default path filters out exactly
        // `location === 'top-tab'`), so `general` puts the editor in the main
        // Config view, under Identity.
        //
        // It sat at `tab: 'streaming'` with no location first, which is inside
        // Config but behind a sub-tab whose own definition in `config-ui.ts`
        // calls it what "remains for older payloads that haven't been
        // retagged" — the operator could not find it there.
        tab: 'general',
        title: 'Grid layout',
        titleKey: 'server:gridDevice.s_camera-grid-layout.title',
        order: 20,
        fields: [
          {
            type: 'widget' as const,
            key: '_gridLayout',
            label: '',
            labelKey: 'server:gridDevice.s_camera-grid-layout._gridLayout.label',
            widgetId: GRID_LAYOUT_WIDGET_ID,
          },
        ],
      },
    ],
  }
}
