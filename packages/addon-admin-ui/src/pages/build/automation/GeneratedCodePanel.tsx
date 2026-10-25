/**
 * The generated source — shown, never edited.
 *
 * The recipe is what the operator authored; this file is regenerated from it on
 * every save. Storing an edit made here would create a second copy that can
 * disagree with the recipe, and a second copy that can disagree is the exact
 * failure the whole recipe/codegen split exists to avoid. So it is read-only,
 * collapsed by default, and labelled as derived.
 *
 * **Eject is the one way out, and it is one-way.** It is a confirm dialog rather
 * than a tooltip because a tooltip is not a decision: after ejecting, the
 * embedded recipe is GONE from the file, the block becomes an ordinary script,
 * and this editor will not open it again. That is not a UI state to be undone —
 * it is the point. A warning the operator can walk past without acknowledging
 * would be the wrong shape for it.
 */

import { Button, CodeBlock, useConfirm } from '@camstack/ui-library'
import { ChevronDown, ChevronRight, LogOut } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

export interface GeneratedCodePanelProps {
  /** `null` when the recipe cannot compile yet — the reason is in `error`. */
  readonly code: string | null
  readonly error: string | null
  /** False while the automation has never been saved: there is no stored block
   *  to hand over, and ejecting a draft would leave nothing behind. */
  readonly canEject: boolean
  readonly ejecting: boolean
  readonly onEject: () => void
}

export function GeneratedCodePanel({
  code,
  error,
  canEject,
  ejecting,
  onEject,
}: GeneratedCodePanelProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const confirm = useConfirm()

  const askEject = async (): Promise<void> => {
    const agreed = await confirm({
      title: t(
        'automation.generatedCodePanel.ejectToCodeThisCannot',
        'Eject to code — this cannot be undone',
      ),
      message: t(
        'automation.generatedCodePanel.theRecipeIsRemovedFrom',
        'The recipe is removed from the block and it becomes an ordinary script. The visual editor will no longer open it, and there is no way back to it except authoring a new automation from scratch. The code itself is kept exactly as it is now.',
      ),
      confirmLabel: t('automation.generatedCodePanel.ejectToCode', 'Eject to code'),
      cancelLabel: t('automation.generatedCodePanel.keepItVisual', 'Keep it visual'),
      variant: 'warning',
    })
    if (agreed) onEject()
  }

  return (
    <div className="rounded border border-border">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Button variant="ghost" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          {t('automation.generatedCodePanel.generatedCode', 'Generated code')}
        </Button>
        <span className="text-xs text-foreground-subtle">
          {t(
            'automation.generatedCodePanel.derivedFromTheRecipeAbove',
            'Derived from the recipe above — regenerated on every save, never edited here.',
          )}
        </span>
        <Button
          className="ml-auto"
          variant="ghost"
          disabled={!canEject || code === null || ejecting}
          onClick={() => void askEject()}
          title={
            canEject
              ? t(
                  'automation.generatedCodePanel.takePermanentOwnershipOfThis',
                  'Take permanent ownership of this code as a script',
                )
              : t(
                  'automation.generatedCodePanel.saveTheAutomationFirstThere',
                  'Save the automation first — there is no stored block to eject yet',
                )
          }
        >
          <LogOut className="h-4 w-4" /> {t('automation.generatedCodePanel.eject')}
        </Button>
      </div>

      {open && (
        <div className="border-t border-border p-3">
          {code === null ? (
            <p className="text-xs text-warning">
              {error ??
                t(
                  'automation.generatedCodePanel.theRecipeIsNotComplete',
                  'The recipe is not complete enough to generate a block yet.',
                )}
            </p>
          ) : (
            <CodeBlock maxHeight={420}>{code}</CodeBlock>
          )}
        </div>
      )}
    </div>
  )
}
