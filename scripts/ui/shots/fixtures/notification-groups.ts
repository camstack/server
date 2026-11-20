/**
 * System → Notifications → Targets with a notifier group (D1071): the targets of
 * `notification-targets` plus a core-owned `Group` kind and one group of two members. The kind
 * descriptor comes from the core builtin, so the form is the one the hub serves.
 */
import { groupTargetKind } from '../../../../packages/system/src/builtins/core-notifier/group-descriptor'
import base from './notification-targets'
import { defineFixtures } from './_define'

const groupKind = groupTargetKind()
const GROUP_WIDGET = {
  id: 'notifier/group-members',
  placement: 'connection',
} as const

type Handler = (input: { addonId: string; kind?: string; id: string | null }) => unknown
const handler = (key: string): Handler => {
  const value = base.handlers[key]
  return typeof value === 'function' ? (value as Handler) : () => value
}

export default defineFixtures({
  area: 'notification-groups',
  description: 'Targets page with a core notifier group of two members (the group editor)',
  handlers: {
    ...base.handlers,
    'notificationOutput.listTargetKinds': [
      ...(base.handlers['notificationOutput.listTargetKinds'] as readonly unknown[]),
      groupKind,
    ],
    'capabilities.getCapability': (i: { name: string }) => ({
      name: i.name,
      mode: i.name === 'notification-output' ? 'collection' : 'singleton',
      providers:
        i.name === 'notification-output'
          ? ['notifiers', 'import-alexa', 'core-notifier']
          : [i.name],
      activeProvider: i.name === 'notification-output' ? null : i.name,
      disabledProviders: [],
    }),
    'integrationInstances.describe': (i: { addonId: string }) =>
      i.addonId === 'core-notifier'
        ? {
            role: 'services',
            instanceMode: 'multiple',
            kind: 'target',
            canTest: false,
            mintsId: true,
            kinds: [
              {
                id: 'notify-group',
                label: 'Group',
                functionCap: 'notification-output',
                canTest: false,
                widgets: [GROUP_WIDGET],
              },
            ],
          }
        : handler('integrationInstances.describe')({
            addonId: i.addonId,
            id: null,
          }),
    'integrationInstances.listInstances': (i: { addonId: string }) =>
      i.addonId === 'core-notifier'
        ? [
            {
              id: 'group-everyone',
              name: 'Everyone',
              kind: 'notify-group',
              configured: true,
              enabled: true,
              formValues: {
                name: 'Everyone',
                members: [
                  {
                    targetId: 'email-alerts',
                    enabled: true,
                    when: { kind: 'always' },
                    fields: ['title', 'body'],
                    minPriority: 3,
                    throttleSec: 60,
                  },
                  {
                    targetId: 'alexa-echo-1',
                    enabled: true,
                    when: {
                      kind: 'alarm',
                      deviceId: 12,
                      states: ['armed_away', 'armed_night'],
                    },
                    fields: ['title'],
                    templates: { title: 'Alert: {{title}}' },
                  },
                ],
              },
            },
          ]
        : handler('integrationInstances.listInstances')({
            addonId: i.addonId,
            id: null,
          }),
    'integrationInstances.instanceFormSchema': (i: {
      addonId: string
      kind?: string
      id: string | null
    }) =>
      i.addonId === 'core-notifier'
        ? groupKind.configSchema
        : handler('integrationInstances.instanceFormSchema')(i),
  },
})
