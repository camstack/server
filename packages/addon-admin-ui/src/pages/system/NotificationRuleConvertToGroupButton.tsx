/**
 * "Convert to group" on a rule that delivers to several notifiers: makes one notifier group holding
 * those notifiers and points the rule at the group. Shown only when the rule can be converted.
 */
import {
  NOTIFIER_GROUP_ADDON_ID,
  NOTIFIER_GROUP_KIND,
  notificationTargetKindName,
  type NcRule,
} from '@camstack/types'
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useAlert,
  useConfirm,
  useSystem,
} from '@camstack/ui-library'
import { useMutation } from '@tanstack/react-query'
import { Users } from 'lucide-react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { canConvertToGroup, planRuleGroup, type RuleGroupPlan } from './notification-rule-to-group'
import { useNotificationTargets } from './use-notification-targets'

interface NotificationRuleConvertToGroupButtonProps {
  readonly rule: NcRule
  readonly targetName: (targetId: string) => string
  /** Called once the rule points at the new group. */
  readonly onConverted: () => void
}

export function NotificationRuleConvertToGroupButton({
  rule,
  targetName,
  onConverted,
}: NotificationRuleConvertToGroupButtonProps): ReactElement | null {
  const { t } = useTranslation()
  const system = useSystem()
  const confirm = useConfirm()
  const alert = useAlert()
  const targets = useNotificationTargets()

  const convert = useMutation({
    mutationFn: async (plan: RuleGroupPlan): Promise<void> => {
      const instances = system.trpcClient.integrationInstances
      const created = await instances.createInstance.mutate({
        addonId: NOTIFIER_GROUP_ADDON_ID,
        name: rule.name,
        kind: notificationTargetKindName(NOTIFIER_GROUP_KIND),
      })
      await instances.updateInstance.mutate({
        addonId: NOTIFIER_GROUP_ADDON_ID,
        id: created.id,
        values: { members: [...plan.members] },
      })
      await system.trpcClient.notificationRules.updateRule.mutate({
        ruleId: rule.id,
        patch: { targets: [{ targetId: created.id }], targetOverrides: {}, disabledTargetIds: [] },
      })
    },
    onSuccess: onConverted,
    onError: (err: unknown) =>
      void alert({
        title: t('notificationRules.toGroup.failed', 'The rule was not converted'),
        message: err instanceof Error ? err.message : String(err),
      }),
  })

  if (!canConvertToGroup(rule, targets.data)) return null
  const label = t('notificationRules.toGroup.action', 'Convert to group')

  const start = async (): Promise<void> => {
    const plan = planRuleGroup(rule)
    const lost = plan.notCarried.map(
      (item) =>
        `${targetName(item.targetId)}: ${t(`notificationRules.toGroup.notCarried.${item.setting}`, item.setting)}`,
    )
    const ok = await confirm({
      title: label,
      message:
        t(
          'notificationRules.toGroup.message',
          'A notifier group named "{{name}}" is created with the {{count}} notifiers of this rule, and the rule delivers to that group.',
          { name: rule.name, count: plan.members.length },
        ) +
        (lost.length > 0
          ? ` ${t('notificationRules.toGroup.lost', 'These per-notifier settings are not kept:')} ${lost.join('; ')}.`
          : ''),
      confirmLabel: label,
    })
    if (ok) convert.mutate(plan)
  }

  return (
    <Tooltip>
      <TooltipTrigger>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          disabled={convert.isPending}
          onClick={() => void start()}
          aria-label={label}
        >
          <Users className="h-3.5 w-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
