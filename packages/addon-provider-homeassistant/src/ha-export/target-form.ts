/**
 * The form of one export target (`integration-instances`): its name, the Home Assistant
 * connection it pushes to, which hub address its image links use, and (collapsed) how often it
 * re-announces. The devices exported to it are not a form field: they are chosen per device or
 * in the Devices dialog of the target.
 */
import { type ConfigUISchema, linkFieldDescriptor } from '@camstack/types'
import { HA_CONNECTION_LINK, MIN_RECONCILE_INTERVAL_SEC } from './target-records.js'

const NS = 'provider-homeassistant:globalSettings'

export function buildTargetForm(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'ha-export-target',
        title: 'Home Assistant target',
        titleKey: `${NS}.s_ha-export-target.title`,
        description:
          'Where the export pushes devices. A target with no existing connection pushes nothing and keeps its devices. Export needs the CamStack custom component installed in Home Assistant (HACS).',
        descriptionKey: `${NS}.s_ha-export-target.description`,
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'name',
            label: 'Name',
            labelKey: `${NS}.s_ha-export-target.name.label`,
          },
          {
            ...linkFieldDescriptor('connectionId', HA_CONNECTION_LINK, {
              label: 'Home Assistant connection',
              description: 'The Home Assistant instance this target pushes to.',
            }),
            labelKey: `${NS}.s_ha-export-target.connectionId.label`,
            descriptionKey: `${NS}.s_ha-export-target.connectionId.description`,
          },
          {
            type: 'select',
            key: 'mediaRole',
            label: 'Image links',
            labelKey: `${NS}.s_ha-export-target.mediaRole.label`,
            description:
              'The hub address this Home Assistant fetches image links from. Public endpoint is the default, so notifications show images away from home; when none is set the internal address is used.',
            descriptionKey: `${NS}.s_ha-export-target.mediaRole.description`,
            options: [
              { value: 'internal', label: 'Internal (LAN address)' },
              {
                value: 'publicEndpoint',
                label: 'Public endpoint (reachable from outside)',
              },
            ],
            default: 'publicEndpoint',
          },
        ],
      },
      // Tuning, not setup: collapsed so the form opens on what an operator has to check.
      {
        id: 'ha-export-advanced',
        title: 'Advanced',
        titleKey: `${NS}.s_ha-export-advanced.title`,
        style: 'accordion',
        defaultCollapsed: true,
        columns: 1,
        fields: [
          {
            type: 'number',
            key: 'reconcileIntervalSec',
            label: 'Reconcile interval (s)',
            labelKey: `${NS}.s_ha-export-advanced.reconcileIntervalSec.label`,
            description: `Full re-announce and re-push cadence; at least ${MIN_RECONCILE_INTERVAL_SEC} s.`,
            descriptionKey: `${NS}.s_ha-export-advanced.reconcileIntervalSec.description`,
            default: 300,
          },
        ],
      },
    ],
  }
}
