/**
 * "Create new…" under an instance link picker (an email target's "Send with"): it creates any
 * instance the link can point at — a kind whose function is the link's cap, or one that also
 * serves it (`alsoServes`) — and hands the new id to the picker. One creatable kind opens its
 * editor at once; several open the same chooser Add uses, one tile per kind with its icon. With
 * nothing creatable the button is not rendered. Kind VALUES are data; nothing here names one.
 */
import { Button } from '@camstack/ui-library'
import { Plus } from 'lucide-react'
import { type JSX, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IntegrationWizard } from '../integrations/IntegrationWizard'
import { InstanceCreateDialog } from './InstanceCreateDialog'
import { type InstanceKindOption, useInstanceKinds } from './instance-kinds'

export interface InstanceLinkCreateProps {
  /** The cap the link points at. */
  readonly functionCap: string
  readonly disabled: boolean
  /** The instance exists: the picker selects it. */
  readonly onCreated: (id: string) => void
}

/** What the operator is creating: the chooser, or one kind's editor. */
type CreateStep =
  | { readonly at: 'closed' }
  | { readonly at: 'choose' }
  | { readonly at: 'edit'; readonly option: InstanceKindOption }

export function InstanceLinkCreate({
  functionCap,
  disabled,
  onCreated,
}: InstanceLinkCreateProps): JSX.Element | null {
  const { t } = useTranslation()
  const { options } = useInstanceKinds({ functionCap, match: 'link' })
  const [step, setStep] = useState<CreateStep>({ at: 'closed' })
  if (options.length === 0) return null
  const close = (): void => setStep({ at: 'closed' })
  const open = (): void => {
    const only = options.length === 1 ? options[0] : undefined
    setStep(only !== undefined ? { at: 'edit', option: only } : { at: 'choose' })
  }
  return (
    <>
      <Button variant="outline" size="sm" disabled={disabled} onClick={open}>
        <Plus className="h-3.5 w-3.5" /> {t('brokers.picker.createNew')}
      </Button>
      {step.at === 'choose' && (
        <IntegrationWizard
          open
          onClose={close}
          pickFrom={{
            title: t('brokers.picker.createNew'),
            providers: options.map((option) => ({
              addonId: option.addonId,
              kind: option.kind,
              name: option.label,
              description: '',
              ...(option.iconUrl !== undefined ? { iconUrl: option.iconUrl } : {}),
            })),
            onPick: (addonId, kind) => {
              const option = options.find((o) => o.addonId === addonId && o.kind === kind)
              setStep(option !== undefined ? { at: 'edit', option } : { at: 'closed' })
            },
          }}
        />
      )}
      {step.at === 'edit' && (
        <InstanceCreateDialog
          functionCap={functionCap}
          addonId={step.option.addonId}
          kind={step.option.kind}
          match="link"
          onClose={close}
          onSaved={(id) => {
            close()
            onCreated(id)
          }}
        />
      )}
    </>
  )
}
