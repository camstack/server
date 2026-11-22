/**
 * The cell that shows and edits ONE whole-capability link (D1076): the device a
 * cap — or a slot of it — is served from. One picker over the devices that
 * bind the source cap, a state badge when the stored link no longer holds, and
 * the refusal the server gave. It stores nothing itself: the caller owns the
 * `capLink` feature and reacts to `onChange`.
 */
import type { CapLinkState } from '@camstack/types'
import type { JSX } from 'react'
import { useUiText } from '../contexts/ui-text'
import { Badge } from '../primitives/badge'
import { DeviceValuePicker } from './device-value-picker'

/** A link that is not stored yet reads `unlinked`. */
export type CapLinkCellState = CapLinkState | 'unlinked'

export interface CapLinkCellProps {
  /** The device the link is declared on (its room is suggested first). */
  readonly deviceId: number
  /** The capability the source device must bind. */
  readonly sourceCap: string
  /** The linked source device; null when none is stored or it is gone. */
  readonly sourceDeviceId: number | null
  readonly state: CapLinkCellState
  /** Pick (a device id) or clear (null). */
  readonly onChange: (sourceDeviceId: number | null) => void
  /** The customization is not read yet, or a save is running. */
  readonly disabled?: boolean
  /** The refusal the last change got; shown, never swallowed. */
  readonly error?: string | null
  /** One line under the picker; absent = the default sentence. */
  readonly hint?: string
  readonly testId?: string
}

export function CapLinkCell(props: CapLinkCellProps): JSX.Element {
  const t = useUiText()
  const stateBadge =
    props.state === 'source-gone' ? (
      <Badge variant="warning" data-testid={`${props.testId ?? 'cap-link'}-gone`}>
        {t('uiLibrary.capLink.sourceGone', 'Source device removed')}
      </Badge>
    ) : props.state === 'disabled' ? (
      <Badge variant="neutral" data-testid={`${props.testId ?? 'cap-link'}-disabled`}>
        {t('uiLibrary.capLink.disabled', 'Link switched off')}
      </Badge>
    ) : null
  return (
    <span className="flex flex-col gap-1" data-testid={props.testId ?? 'cap-link'}>
      {stateBadge}
      <DeviceValuePicker
        pick="device"
        noun="device"
        requires={{ caps: [props.sourceCap] }}
        contextDeviceId={props.deviceId}
        recentKey={`cap-link-${props.sourceCap}`}
        testId={`${props.testId ?? 'cap-link'}-picker`}
        disabled={props.disabled === true}
        value={props.sourceDeviceId === null ? null : { deviceId: props.sourceDeviceId }}
        onChange={(picked) => props.onChange(picked === null ? null : picked.deviceId)}
      />
      {props.error !== undefined && props.error !== null && props.error !== '' ? (
        <span role="alert" className="text-[11px] text-danger break-words">
          {props.error}
        </span>
      ) : (
        <span className="text-[11px] text-foreground-muted">
          {props.hint ??
            t(
              'uiLibrary.capLink.hint',
              'The whole capability follows this device, not single values.',
            )}
        </span>
      )}
    </span>
  )
}
