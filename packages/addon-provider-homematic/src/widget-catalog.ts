import type { WidgetMetadata } from '@camstack/types'

/**
 * The addon's widgets for `addon-widgets-source.listWidgets`. The bundle is
 * built by `vite.widgets.config.ts` into `dist/widgets/` (beside the page
 * bundle, which owns `dist/remoteEntry.js`).
 */
export const homematicWidgets: readonly WidgetMetadata[] = [
  {
    tab: 'device-tab',
    label: 'Homematic device',
    preAuth: false,
    kind: 'remote' as const,
    remote: {
      remoteName: 'addon_provider_homematic_widgets',
      exposedModule: './widgets',
      componentKey: 'device-panel',
    },
    stableId: 'device-panel',
    description:
      'CCU values, diagnostics, manual actuation and MASTER configuration of one device.',
    icon: 'plug',
    bundle: 'widgets/remoteEntry.js',
    hosts: ['device-tab'] as const,
    requires: { deviceContext: true, integrationContext: false },
    defaultSize: 'xl' as const,
    allowedSizes: ['lg', 'xl'] as const,
    defaultColumns: 12,
    defaultRows: 4,
  },
]
