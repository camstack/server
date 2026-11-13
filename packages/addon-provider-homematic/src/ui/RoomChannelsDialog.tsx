import { useMemo, useState } from 'react'
import { Button, Checkbox, Input, ItemFormDialog } from '@camstack/ui-library'
import { DoorOpen } from 'lucide-react'
import type { CcuRoom, LinkEndpoint } from '../ccu/ccu-schemas.js'
import { useT } from '../i18n/index.js'
import { endpointLabel } from './link-labels.js'

export interface RoomChannelsDialogProps {
  readonly room: CcuRoom
  readonly channels: readonly LinkEndpoint[]
  readonly onClose: () => void
  /** Hands the whole member list to the caller, which asks the operator before the CCU write. */
  readonly onSave: (channels: readonly string[]) => Promise<void>
}

function matches(endpoint: LinkEndpoint, needle: string): boolean {
  if (needle === '') return true
  const haystack = [endpoint.address, endpoint.name ?? '', endpoint.deviceName ?? '']
  return haystack.some((text) => text.toLowerCase().includes(needle))
}

/** Pick the channels a CCU room holds. */
export function RoomChannelsDialog(props: RoomChannelsDialogProps) {
  const { room, channels, onClose, onSave } = props
  const { t } = useT()
  const [members, setMembers] = useState<readonly string[]>(() =>
    room.channels.map((channel) => channel.address),
  )
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const needle = search.trim().toLowerCase()
  const visible = useMemo(
    () => channels.filter((endpoint) => matches(endpoint, needle)),
    [channels, needle],
  )

  const toggle = (address: string): void =>
    setMembers((prev) =>
      prev.includes(address) ? prev.filter((a) => a !== address) : [...prev, address],
    )

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave(members)
    } finally {
      setSaving(false)
    }
  }

  return (
    <ItemFormDialog
      open
      onClose={onClose}
      icon={DoorOpen}
      width="md"
      title={t('rooms.channelsTitle', { name: room.name })}
      testId="hm-room-channels-dialog"
      footer={
        <Button type="button" onClick={() => void save()} disabled={saving}>
          {t('rooms.save')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          aria-label={t('rooms.search')}
          placeholder={t('rooms.search')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <p className="text-xs text-foreground-subtle">
          {t('rooms.selected', { count: members.length })}
        </p>
        <ul className="flex flex-col gap-1">
          {visible.map((endpoint) => (
            <li key={endpoint.address}>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <Checkbox
                  checked={members.includes(endpoint.address)}
                  onChange={() => toggle(endpoint.address)}
                />
                <span>{endpointLabel(endpoint)}</span>
                <span className="text-xs text-foreground-subtle">
                  {endpoint.deviceName === null
                    ? endpoint.address
                    : `${endpoint.deviceName} · ${endpoint.address}`}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>
    </ItemFormDialog>
  )
}
