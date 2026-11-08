/**
 * Browse the Flipper-IRDB community library (category, brand, file) and fill
 * the bindings from a remote's `.ir` file. The folders and the file are read
 * from GitHub when opened and parsed here by the one parser; nothing is stored
 * and the operator applies the result explicitly, like the SmartIR import.
 */
import type { SmartIrDraft } from '@camstack/types'
import { Button, Input } from '@camstack/ui-library'
import { ChevronRight, FileText, Folder } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  createFlipperIrdbClient,
  type FlipperIrdbClient,
  type FlipperIrdbEntry,
  FlipperIrdbError,
  filterEntries,
} from './flipper-irdb-client'
import { type FlipperIrImport, importFlipperIr } from './remote-config-model'

export interface FlipperIrdbPanelProps {
  /** The transmitter the imported codes are sent through; null until one is picked. */
  readonly transmitterId: number | null
  readonly onApply: (draft: SmartIrDraft) => void
  /** A client to read through; the default reads GitHub. */
  readonly client?: FlipperIrdbClient
}

type Listing =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly entries: readonly FlipperIrdbEntry[] }
  | { readonly status: 'error'; readonly error: FlipperIrdbError }

function toFlipperError(err: unknown): FlipperIrdbError {
  return err instanceof FlipperIrdbError ? err : new FlipperIrdbError('network', 'request failed')
}

export function FlipperIrdbPanel({
  transmitterId,
  onApply,
  client,
}: FlipperIrdbPanelProps): ReactNode {
  const { t } = useTranslation()
  const irdb = useMemo(() => client ?? createFlipperIrdbClient(), [client])
  const [path, setPath] = useState('')
  const [query, setQuery] = useState('')
  const [listing, setListing] = useState<Listing>({ status: 'loading' })
  const [fileError, setFileError] = useState<FlipperIrdbError | null>(null)
  const [result, setResult] = useState<FlipperIrImport | null>(null)

  useEffect(() => {
    let live = true
    setListing({ status: 'loading' })
    irdb
      .list(path)
      .then((entries) => {
        if (live) setListing({ status: 'ready', entries })
      })
      .catch((err: unknown) => {
        if (live) setListing({ status: 'error', error: toFlipperError(err) })
      })
    return () => {
      live = false
    }
  }, [irdb, path])

  const open = (entry: FlipperIrdbEntry): void => {
    setResult(null)
    setFileError(null)
    if (entry.kind === 'dir') {
      setQuery('')
      setPath(entry.path)
      return
    }
    irdb
      .readFile(entry.path)
      .then((text) => setResult(importFlipperIr(text, transmitterId)))
      .catch((err: unknown) => setFileError(toFlipperError(err)))
  }

  const errorText = (error: FlipperIrdbError): string => {
    if (error.code === 'rate-limited' && error.resetAtMs !== null) {
      return t('remote.flipper.error.rate-limitedAt', {
        time: new Date(error.resetAtMs).toLocaleTimeString(),
      })
    }
    return t(`remote.flipper.error.${error.code}`)
  }

  const segments = path === '' ? [] : path.split('/')
  const shown = listing.status === 'ready' ? filterEntries(listing.entries, query) : []

  return (
    <div className="space-y-2" data-testid="flipper-import">
      <p className="text-xs text-foreground-muted">{t('remote.flipper.hint')}</p>
      <nav
        className="flex flex-wrap items-center gap-1 text-xs"
        aria-label={t('remote.flipper.title')}
      >
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setPath('')
            setQuery('')
            setResult(null)
          }}
        >
          {t('remote.flipper.root')}
        </Button>
        {segments.map((segment, index) => (
          <span key={segment + String(index)} className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3 text-foreground-subtle" aria-hidden />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setPath(segments.slice(0, index + 1).join('/'))
                setQuery('')
                setResult(null)
              }}
            >
              {segment}
            </Button>
          </span>
        ))}
      </nav>
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('remote.flipper.search')}
        aria-label={t('remote.flipper.search')}
        data-testid="flipper-search"
      />
      {listing.status === 'loading' && (
        <p className="text-xs text-foreground-muted">{t('remote.flipper.loading')}</p>
      )}
      {listing.status === 'error' && (
        <p role="alert" className="text-xs text-danger" data-testid="flipper-error">
          {errorText(listing.error)}
        </p>
      )}
      {listing.status === 'ready' && shown.length === 0 && (
        <p className="text-xs text-foreground-muted">{t('remote.flipper.empty')}</p>
      )}
      {shown.length > 0 && (
        <ul className="max-h-48 space-y-0.5 overflow-y-auto" data-testid="flipper-entries">
          {shown.map((entry) => (
            <li key={entry.path}>
              <Button
                size="sm"
                variant="ghost"
                className="w-full justify-start"
                onClick={() => open(entry)}
              >
                {entry.kind === 'dir' ? (
                  <Folder className="mr-1 h-3 w-3" aria-hidden />
                ) : (
                  <FileText className="mr-1 h-3 w-3" aria-hidden />
                )}
                <span className="truncate">{entry.name}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      {fileError !== null && (
        <p role="alert" className="text-xs text-danger" data-testid="flipper-file-error">
          {errorText(fileError)}
        </p>
      )}
      {result?.status === 'refused' && (
        <p role="alert" className="text-xs text-danger" data-testid="flipper-refused">
          {t(`remote.flipper.refused.${result.reason}`)}
        </p>
      )}
      {result?.status === 'ok' && (
        <div className="space-y-2" data-testid="flipper-summary">
          <p className="text-xs text-foreground">
            {t('remote.import.summary', { count: result.bound })}
          </p>
          {result.skipped.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-warning">
                {t('remote.import.skipped', { count: result.skipped.length })}
              </p>
              <ul className="max-h-24 space-y-0.5 overflow-y-auto text-[11px] text-foreground-muted">
                {result.skipped.map((s) => (
                  <li key={`${s.name}:${s.reason}`}>
                    {s.name} — {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Button
            size="sm"
            disabled={result.bound === 0}
            onClick={() => {
              onApply(result.draft)
              setResult(null)
            }}
            data-testid="flipper-apply"
          >
            {t('remote.import.apply')}
          </Button>
        </div>
      )}
    </div>
  )
}
