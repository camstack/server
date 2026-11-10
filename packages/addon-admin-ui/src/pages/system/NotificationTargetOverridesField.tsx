/**
 * The per-target settings of the summary, timelapse and calendar-events
 * editors (#487, D1032): the SAME panel the notification rule editor shows
 * (`NotificationRuleTargetSettings`), fed from what an editor already holds —
 * the picker's target options — plus the notifier catalog it reads itself.
 *
 * `surface` is the kind of rule being edited and decides the fields offered
 * (`TARGET_SETTINGS_SURFACES`). The catalog is read with the key the rule
 * editor uses, so opening either shares one answer.
 */
import type { NcTargetOverrides, NcTemplateVarDescriptor } from '@camstack/types'
import { type NotificationTargetOption, useSystem } from '@camstack/ui-library'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { varsForContext } from '../../components/notifications/template-field.helpers'
import { useTemplateCatalog } from '../../components/notifications/use-template-catalog'
import { NotificationRuleTargetSettings } from './NotificationRuleTargetSettings'
import type { DeliveryKindRef } from './rule-form-delivery'
import { type TargetSettingsSurface, targetsFromOptions } from './rule-form-target-settings'

export interface NotificationTargetOverridesFieldProps {
  readonly surface: Exclude<TargetSettingsSurface, 'rule'>
  readonly targetIds: readonly string[]
  readonly targets: readonly NotificationTargetOption[]
  readonly overrides: NcTargetOverrides
  /** The rule's own priority — what a target without an override inherits. */
  readonly rulePriority: number
  readonly onChange: (next: NcTargetOverrides) => void
  /** The template catalog family, when this kind has one (calendar events has none). */
  readonly templateFamily?: 'summary' | 'timelapse'
}

/** What each selected notifier declares; `[]` until the catalog answers (never a guess). */
export function useTargetKinds(): readonly DeliveryKindRef[] {
  const system = useSystem()
  return (
    useQuery({
      queryKey: ['notificationOutput', 'listTargetKinds', 'forRuleDelivery'],
      queryFn: (): Promise<readonly DeliveryKindRef[]> =>
        system.trpcClient.notificationOutput.listTargetKinds.query({}),
    }).data ?? []
  )
}

export function NotificationTargetOverridesField(props: NotificationTargetOverridesFieldProps) {
  const kinds = useTargetKinds()
  const catalog = useTemplateCatalog()
  const targets = useMemo(() => targetsFromOptions(props.targets), [props.targets])
  const family = props.templateFamily
  const varsFor = (field: 'title' | 'body'): readonly NcTemplateVarDescriptor[] | undefined =>
    catalog.data !== undefined && family !== undefined
      ? varsForContext(catalog.data, { family, field })
      : undefined
  return (
    <NotificationRuleTargetSettings
      surface={props.surface}
      targetIds={props.targetIds}
      targets={targets}
      kinds={kinds}
      overrides={props.overrides}
      rulePriority={props.rulePriority}
      onOverridesChange={props.onChange}
      varsFor={varsFor}
    />
  )
}
