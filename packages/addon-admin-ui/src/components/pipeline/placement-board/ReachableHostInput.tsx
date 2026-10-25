/**
 * ReachableHostInput — per-node override for the LAN host a cross-node decoder
 * dials to reach this node's restream.
 *
 * Blank commits `null` (clears the override → auto-detect). The first
 * auto-detected interface IP is shown as the placeholder so the operator sees
 * what the runner would use by default and only types a value to override it.
 *
 * An explicit "Save" button commits the draft (Enter does too, as a shortcut);
 * it is disabled until the draft actually differs from the persisted value, so
 * there's always a visible, working affordance to persist an edit — not just
 * an implicit blur-to-save that's easy to miss and gives no feedback.
 */
import { useEffect, useState } from 'react'
import { AlertCircle, Check, Loader2 } from 'lucide-react'
import { Button, Input } from '@camstack/ui-library'
import type { ReachableHostSaveStatus } from './board-model'
import { useTranslation } from 'react-i18next'

export interface ReachableHostInputProps {
  readonly nodeId: string
  readonly value: string | null
  readonly detectedHosts: readonly string[]
  readonly status: ReachableHostSaveStatus
  readonly errorMessage: string | null
  readonly onCommit: (nodeId: string, reachableHost: string | null) => void
}

export function ReachableHostInput({
  nodeId,
  value,
  detectedHosts,
  status,
  errorMessage,
  onCommit,
}: ReachableHostInputProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(value ?? '')

  useEffect(() => {
    setDraft(value ?? '')
  }, [value])

  const detected = detectedHosts[0]
  const placeholder = detected !== undefined ? `auto: ${detected}` : 'auto-detect'
  const pending = status === 'pending'
  const trimmed = draft.trim()
  const dirty = trimmed !== (value ?? '')
  const canSave = dirty && !pending

  const commit = (): void => {
    if (!canSave) return
    onCommit(nodeId, trimmed.length > 0 ? trimmed : null)
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        aria-label={t(
          'placementBoard.reachableHostInput.reachableHostFor',
          'Reachable host for {{nodeId}}',
          { nodeId },
        )}
        type="text"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={draft}
        disabled={pending}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
          if (event.key === 'Escape') setDraft(value ?? '')
        }}
        className="w-36"
      />
      <Button
        variant="outline"
        size="sm"
        onClick={commit}
        disabled={!canSave}
        aria-label={t(
          'placementBoard.reachableHostInput.saveReachableHostFor',
          'Save reachable host for {{nodeId}}',
          { nodeId },
        )}
        title={t('placementBoard.reachableHostInput.saveReachableHost', 'Save reachable host')}
      >
        {pending ? (
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        ) : (
          <Check className="h-3 w-3" aria-hidden="true" />
        )}
        {t('common.save', 'Save')}
      </Button>
      {!dirty && !pending && status === 'success' && (
        <Check
          className="h-3.5 w-3.5 shrink-0 text-success"
          aria-label={t('placementBoard.reachableHostInput.saved', 'Saved')}
          role="img"
        />
      )}
      {status === 'error' && (
        <span
          title={
            errorMessage ??
            t(
              'placementBoard.reachableHostInput.failedToSaveReachableHost',
              'Failed to save reachable host',
            )
          }
        >
          <AlertCircle
            className="h-3.5 w-3.5 shrink-0 text-danger"
            aria-label={
              errorMessage ??
              t(
                'placementBoard.reachableHostInput.failedToSaveReachableHost',
                'Failed to save reachable host',
              )
            }
            role="img"
          />
        </span>
      )}
    </div>
  )
}
