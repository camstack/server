import { useState } from 'react'
import { Button, Checkbox, FormField, Input, ItemFormDialog, Select } from '@camstack/ui-library'
import { Flame } from 'lucide-react'
import { HEATING_GROUP_TYPES, type GroupCandidate, type HeatingGroup } from '../ccu/ccu-schemas.js'
import { useT } from '../i18n/index.js'

export interface GroupDraft {
  readonly name: string
  readonly type: string
  readonly members: readonly string[]
}

/** Create (no `group`) or edit (a `group`) a heating group; saving hands the draft to the caller, which asks the operator. */
export function GroupFormDialog(props: {
  readonly group: HeatingGroup | null
  readonly candidates: readonly GroupCandidate[]
  readonly onClose: () => void
  readonly onSave: (draft: GroupDraft) => Promise<void>
}) {
  const { group, candidates, onClose, onSave } = props
  const { t } = useT()
  const [name, setName] = useState(group?.name ?? '')
  const [type, setType] = useState(group?.type ?? HEATING_GROUP_TYPES[0])
  const [members, setMembers] = useState<readonly string[]>(
    () => group?.members.map((member) => member.address) ?? [],
  )
  const [saving, setSaving] = useState(false)

  const toggle = (address: string): void =>
    setMembers((prev) =>
      prev.includes(address) ? prev.filter((a) => a !== address) : [...prev, address],
    )
  const canSave = name.trim() !== '' && members.length > 0 && !saving

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave({ name, type, members })
    } finally {
      setSaving(false)
    }
  }

  return (
    <ItemFormDialog
      open
      onClose={onClose}
      icon={Flame}
      width="md"
      title={group === null ? t('heating.newGroup') : t('heating.editGroup', { name: group.name })}
      testId="hm-group-dialog"
      footer={
        <Button type="button" onClick={() => void save()} disabled={!canSave}>
          {t('heating.save')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label={t('heating.fieldName')} required>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </FormField>
        {group === null && (
          <FormField label={t('heating.fieldType')}>
            <Select
              value={type}
              onChange={(event) => setType(event.target.value)}
              options={HEATING_GROUP_TYPES.map((value) => ({
                value,
                label: t(
                  value === 'hmip.heating.group' ? 'heating.typeHmip' : 'heating.typeHomematic',
                ),
              }))}
            />
          </FormField>
        )}
        <FormField label={t('heating.fieldMembers')} description={t('heating.fieldMembersHint')}>
          {candidates.length === 0 ? (
            <p className="text-xs text-foreground-subtle">{t('heating.noCandidates')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {candidates.map((candidate) => (
                <li key={candidate.address}>
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <Checkbox
                      checked={members.includes(candidate.address)}
                      onChange={() => toggle(candidate.address)}
                    />
                    <span>{candidate.deviceName ?? candidate.address}</span>
                    <span className="text-xs text-foreground-subtle">{candidate.address}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </FormField>
      </div>
    </ItemFormDialog>
  )
}
