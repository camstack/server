/**
 * The notification targets as the admin pages read them: the instances of the function cap
 * `notification-output` (D1013 rule 5), shaped as the `Target` the rule editor and the pickers
 * work with. `data` is `undefined` until every holder has answered, so an unanswered read never
 * looks like "no targets" (D315).
 */
import { notificationTargetKindOf, type Target } from '@camstack/types'
import { useInstancesOfCap, type LinkableInstance } from '@camstack/ui-library'
import { useMemo } from 'react'

const NOTIFICATION_OUTPUT_CAP = 'notification-output'

export function targetsFromInstances(instances: readonly LinkableInstance[]): readonly Target[] {
  return instances.map(
    (instance): Target => ({
      id: instance.id,
      name: instance.name,
      kind: notificationTargetKindOf(instance.recordKind),
      addonId: instance.addonId,
      enabled: instance.enabled,
      config: { ...instance.formValues },
    }),
  )
}

export interface NotificationTargetsRead {
  readonly data: readonly Target[] | undefined
  readonly isError: boolean
}

export function useNotificationTargets(): NotificationTargetsRead {
  const instances = useInstancesOfCap({ functionCap: NOTIFICATION_OUTPUT_CAP })
  const data = useMemo(
    () => (instances.data === undefined ? undefined : targetsFromInstances(instances.data)),
    [instances.data],
  )
  return { data, isError: instances.isError }
}
