/**
 * The `group` target kind a core-notifier serves: the descriptor the add flow lists, and the record
 * kinds it is stored in. A group has no secrets and no destination of its own (D634): its body is a
 * name, a switch and the `members` rows, and every member keeps its own credentials.
 */
import {
  NOTIFIER_GROUP_ADDON_ID,
  NOTIFIER_GROUP_KIND,
  notificationTargetKinds,
  type NotificationTargetRecordKind,
  type TargetKind,
  type TargetKindCaps,
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

/**
 * What a group declares: every field the notification center can deliver, with generous limits, so
 * nothing is stripped before the group sees it (D1030). The group does not narrow anything itself:
 * each member is clamped to its OWN kind's caps when it is sent to.
 */
export const GROUP_CAPS: TargetKindCaps = {
  text: { title: true, body: true },
  attachments: {
    mediaTypes: ['image', 'video', 'gif', 'audio', 'icon'],
    mode: 'both',
    max: 10,
  },
  actions: 10,
  actionIcons: true,
  levels: [
    { id: 'min', label: 'Minimum', ordinal: 1 },
    { id: 'low', label: 'Low', ordinal: 2 },
    { id: 'default', label: 'Default', ordinal: 3 },
    { id: 'high', label: 'High', ordinal: 4 },
    { id: 'critical', label: 'Critical', ordinal: 5, flags: { critical: true } },
  ],
  format: ['text', 'markdown', 'html'],
  clickUrl: true,
  sound: true,
  ttl: true,
  bodyMaxLen: 10_000,
}

export function groupTargetKind(): TargetKind {
  return {
    kind: NOTIFIER_GROUP_KIND,
    label: 'Group',
    icon: 'users',
    addonId: NOTIFIER_GROUP_ADDON_ID,
    configSchema: groupConfigSchema(),
    destinationKeys: [],
    supportsDiscovery: false,
    caps: GROUP_CAPS,
  }
}

export const groupRecordKinds: Readonly<Record<string, NotificationTargetRecordKind>> =
  notificationTargetKinds([groupTargetKind()])
