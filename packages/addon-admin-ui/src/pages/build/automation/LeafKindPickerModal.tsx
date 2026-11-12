/**
 * The one condition-kind modal of the automation editor: "Add row" in the
 * trigger tree, "Add condition" in a step's guard and "Change type" on a row
 * all open this, so the labels, categories and disabled reasons are written
 * once. The searching, ranking and grouping are the library's.
 */
import type {
  AutomationLeafCategory,
  AutomationLeafContext,
  AutomationLeafKind,
} from '@camstack/types'
import { ConditionKindPicker, type KindDisabledReason, type KindTexts } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { leafKindDescription, leafKindExample, leafKindLabel } from './recipe-parts'
import { useInsideAutomation } from './trigger-rows-context'

/** Kinds that read the run's trigger: meaningless where no trigger exists. */
const NEEDS_A_TRIGGER: readonly AutomationLeafKind[] = ['triggered-by']

export interface LeafKindPickerModalProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly mode: 'add' | 'change'
  readonly context: AutomationLeafContext
  readonly underNot: boolean
  readonly treeFull: boolean
  /** The kind of the row being changed (`change` mode): highlighted when the modal opens. */
  readonly current?: AutomationLeafKind
  readonly onPick: (kind: AutomationLeafKind) => void
}

function textsOf(kind: AutomationLeafKind): KindTexts {
  return {
    label: leafKindLabel(kind),
    description: leafKindDescription(kind),
    example: leafKindExample(kind),
  }
}

export function LeafKindPickerModal({
  open,
  onOpenChange,
  mode,
  context,
  underNot,
  treeFull,
  current,
  onPick,
}: LeafKindPickerModalProps) {
  const { t } = useTranslation()
  const insideAutomation = useInsideAutomation()
  return (
    <ConditionKindPicker
      open={open}
      onOpenChange={onOpenChange}
      title={
        mode === 'add'
          ? t('automation.leafPicker.title', 'Add a row')
          : t('automation.leafPicker.changeTitle', 'Change the row type')
      }
      context={context}
      underNot={underNot}
      treeFull={treeFull}
      {...(mode === 'change' && current !== undefined ? { current } : {})}
      {...(insideAutomation ? {} : { hidden: NEEDS_A_TRIGGER })}
      recentKey={`automation-${context}`}
      textsOf={textsOf}
      categoryLabelOf={(category: AutomationLeafCategory) =>
        t(`automation.leafPicker.category.${category}`)
      }
      reasonOf={(reason: KindDisabledReason) => t(`automation.leafPicker.reason.${reason}`)}
      onPick={(kind) => {
        onPick(kind)
        onOpenChange(false)
      }}
    />
  )
}
