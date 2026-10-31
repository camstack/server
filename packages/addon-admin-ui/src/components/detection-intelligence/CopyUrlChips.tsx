/**
 * Per-media copy-URL chips for the EventDetailPanel filmstrip.
 *
 * Offers a "Local" chip (the current admin origin's event-media URL) and,
 * when a public tunnel origin is known, a "Public" chip. Rendered as inline
 * chips rather than a floating dropdown ON PURPOSE: the modal is a native
 * top-layer `<dialog>` with translate transforms, which makes an
 * absolutely/fixed-positioned menu (or a body portal) fragile — it either
 * gets clipped by the horizontally-scrolling filmstrip or renders behind the
 * dialog backdrop. Two flat chips avoid all of that and read cleanly on
 * mobile.
 *
 * The event-media route is Bearer-gated, so a copied URL only resolves inside
 * an authenticated session — surfaced via the chip `title`.
 */
import { useCallback, useEffect, useState, type JSX } from 'react'
import { Check, Copy } from 'lucide-react'
import { usePrompt, Button } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

const COPIED_RESET_MS = 1_400

const AUTH_HINT = 'Admin-gated URL — opens only inside an authenticated session'

interface CopyChipProps {
  readonly label: string
  readonly value: string
  readonly title: string
}

function CopyChip({ label, value, title }: CopyChipProps): JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const showPrompt = usePrompt()

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), COPIED_RESET_MS)
    return () => clearTimeout(t)
  }, [copied])

  const onCopy = useCallback(() => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(value)
        setCopied(true)
      } catch {
        // Clipboard blocked (insecure context / permissions) — surface a
        // manual-copy fallback so the operator still gets the URL.
        //
        // This is the OPPOSITE intent to the password prompt: the operator has
        // to READ and select this value, so the field is `readOnly` (unmasked,
        // selected on open) and the dialog offers only a dismiss. Nothing is
        // typed, so nothing comes back.
        await showPrompt({
          title: t('detectionIntelligence.copyUrlChips.copyTheMediaUrl', 'Copy the media URL'),
          message: t(
            'detectionIntelligence.copyUrlChips.clipboardAccessWasRefusedSelect',
            'Clipboard access was refused. Select the URL below and copy it manually.',
          ),
          label: t('detectionIntelligence.copyUrlChips.url', '{{label}} URL', { label }),
          defaultValue: value,
          readOnly: true,
          cancelLabel: t('common.close', 'Close'),
        })
      }
    })()
  }, [value, label, showPrompt, t])

  return (
    <Button
      variant="unstyled"
      type="button"
      onClick={onCopy}
      title={title}
      aria-label={t('detectionIntelligence.copyUrlChips.copyUrl', 'Copy {{label}} URL', { label })}
      className={`flex min-w-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
        copied
          ? 'border-success/40 bg-success/10 text-success'
          : 'border-border text-foreground-subtle hover:border-primary hover:text-foreground'
      }`}
    >
      {copied ? (
        <Check className="h-2.5 w-2.5 shrink-0" />
      ) : (
        <Copy className="h-2.5 w-2.5 shrink-0" />
      )}
      <span className="truncate">
        {copied ? t('detectionIntelligence.copyUrlChips.copied', 'Copied') : label}
      </span>
    </Button>
  )
}

interface CopyUrlChipsProps {
  /** LAN event-media URL (current admin origin). Always present. */
  readonly localUrl: string
  /** Public tunnel event-media URL, when a `network-access` tunnel is up. */
  readonly publicUrl: string | null
}

/** Local + (optional) Public copy chips for one media row. */
export function CopyUrlChips({ localUrl, publicUrl }: CopyUrlChipsProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap gap-1">
      <CopyChip
        label={t('detectionIntelligence.copyUrlChips.local', 'Local')}
        value={localUrl}
        title={t('detectionIntelligence.copyUrlChips.copyLanUrl', 'Copy LAN URL — {{AUTH_HINT}}', {
          AUTH_HINT,
        })}
      />
      {publicUrl && (
        <CopyChip
          label={t('detectionIntelligence.copyUrlChips.public', 'Public')}
          value={publicUrl}
          title={t(
            'detectionIntelligence.copyUrlChips.copyPublicUrl',
            'Copy public URL — {{AUTH_HINT}}',
            { AUTH_HINT },
          )}
        />
      )}
    </div>
  )
}
