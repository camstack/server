import { useState } from 'react'
import { Button, FormField, ItemFormDialog, Select } from '@camstack/ui-library'
import { Link2 } from 'lucide-react'
import {
  LINK_PRESS_ACTIONS,
  type CcuLink,
  type LinkEndpoint,
  type LinkPressAction,
} from '../ccu/ccu-schemas.js'
import { useT } from '../i18n/index.js'
import { endpointLabel } from './link-labels.js'

export interface LinkDraft {
  readonly sender: string
  readonly receiver: string
  readonly short: LinkPressAction
  readonly long: LinkPressAction
}

export interface LinkFormDialogProps {
  /** `null` creates a link; a link edits its profile (its ends are fixed). */
  readonly link: CcuLink | null
  readonly senders: readonly LinkEndpoint[]
  readonly receivers: readonly LinkEndpoint[]
  readonly onClose: () => void
  readonly onSave: (draft: LinkDraft) => Promise<void>
}

function isPressAction(value: string): value is LinkPressAction {
  return LINK_PRESS_ACTIONS.some((known) => known === value)
}

function endpointOption(endpoint: LinkEndpoint): { value: string; label: string } {
  const device = endpoint.deviceName === null ? '' : ` — ${endpoint.deviceName}`
  return {
    value: endpoint.address,
    label: `${endpointLabel(endpoint)}${device} (${endpoint.address})`,
  }
}

/** Create a key → switch link, or change the short / long press of one; saving hands the draft to the caller, which asks the operator. */
export function LinkFormDialog(props: LinkFormDialogProps) {
  const { link, senders, receivers, onClose, onSave } = props
  const { t } = useT()
  const current = link?.profile?.kind === 'switch' ? link.profile : null
  const [sender, setSender] = useState(link?.sender.address ?? '')
  const [receiver, setReceiver] = useState(link?.receiver.address ?? '')
  const [short, setShort] = useState<LinkPressAction>(current?.short ?? 'toggle')
  const [long, setLong] = useState<LinkPressAction>(current?.long ?? 'toggle')
  const [saving, setSaving] = useState(false)

  const actionOptions = LINK_PRESS_ACTIONS.map((value) => ({
    value,
    label: t(`links.action_${value}`),
  }))
  const canSave = sender !== '' && receiver !== '' && !saving

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave({ sender, receiver, short, long })
    } finally {
      setSaving(false)
    }
  }

  return (
    <ItemFormDialog
      open
      onClose={onClose}
      icon={Link2}
      width="md"
      title={link === null ? t('links.newLink') : t('links.editProfile')}
      testId="hm-link-dialog"
      footer={
        <Button type="button" onClick={() => void save()} disabled={!canSave}>
          {t('links.save')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {link === null ? (
          <>
            <FormField
              label={t('links.fieldSender')}
              description={t('links.fieldSenderHint')}
              required
            >
              <Select
                aria-label={t('links.fieldSender')}
                value={sender}
                onChange={(event) => setSender(event.target.value)}
                options={[{ value: '', label: t('links.pick') }, ...senders.map(endpointOption)]}
              />
            </FormField>
            <FormField
              label={t('links.fieldReceiver')}
              description={t('links.fieldReceiverHint')}
              required
            >
              <Select
                aria-label={t('links.fieldReceiver')}
                value={receiver}
                onChange={(event) => setReceiver(event.target.value)}
                options={[{ value: '', label: t('links.pick') }, ...receivers.map(endpointOption)]}
              />
            </FormField>
          </>
        ) : (
          <p className="text-sm text-foreground">
            {endpointLabel(link.sender)} → {endpointLabel(link.receiver)}
          </p>
        )}
        <FormField label={t('links.fieldShort')}>
          <Select
            aria-label={t('links.fieldShort')}
            value={short}
            onChange={(event) => {
              if (isPressAction(event.target.value)) setShort(event.target.value)
            }}
            options={actionOptions}
          />
        </FormField>
        <FormField label={t('links.fieldLong')}>
          <Select
            aria-label={t('links.fieldLong')}
            value={long}
            onChange={(event) => {
              if (isPressAction(event.target.value)) setLong(event.target.value)
            }}
            options={actionOptions}
          />
        </FormField>
      </div>
    </ItemFormDialog>
  )
}
