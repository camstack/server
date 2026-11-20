/**
 * The `group` target kind a core-notifier serves: the descriptor the add flow lists, and the record
 * kinds it is stored in. A group has no secrets and no destination of its own (D634): its body is a
 * name, a switch and the `members` rows, and every member keeps its own credentials.
 */
import {
  NOTIFIER_GROUP_ADDON_ID,
  NOTIFIER_GROUP_KIND,
  notificationTargetKinds,
  type TargetKind,
  type TargetKindCaps,
  unionTargetKindCaps,
} from '@camstack/types'

/** The form of a group: one editable list of member rows (the full editor is a custom dialog). */
export function groupConfigSchema(): TargetKind['configSchema'] {
  return {
    sections: [
      {
        id: 'members',
        title: 'Members',
        fields: [
          {
            type: 'editable-array',
            key: 'members',
            label: 'Members',
            description: 'The notifiers this group delivers to, each with its own policy.',
            itemFields: [
              {
                type: 'text',
                key: 'targetId',
                label: 'Notifier',
                required: true,
              },
              { type: 'boolean', key: 'enabled', label: 'Enabled' },
            ],
          },
        ],
      },
    ],
  }
}

/** The group kind; `caps` is the union of what its members deliver (D1030). */
export function groupTargetKind(caps: TargetKindCaps): TargetKind {
  return {
    kind: NOTIFIER_GROUP_KIND,
    label: 'Group',
    icon: 'users',
    addonId: NOTIFIER_GROUP_ADDON_ID,
    configSchema: groupConfigSchema(),
    destinationKeys: [],
    supportsDiscovery: false,
    caps,
  }
}

/** Before any member is known a group delivers title and body. */
export const EMPTY_GROUP_CAPS: TargetKindCaps = unionTargetKindCaps([])

export const groupRecordKinds = notificationTargetKinds([groupTargetKind(EMPTY_GROUP_CAPS)])
