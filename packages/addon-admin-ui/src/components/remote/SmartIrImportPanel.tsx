/**
 * Fill the bindings from a SmartIR file, pasted or picked. The file is parsed
 * in the browser by the one parser and never stored: only the bindings it
 * produces reach the config, and the operator applies them explicitly.
 */
import type { SmartIrDraft } from '@camstack/types'
import { Button, FormField, FileInput, Textarea } from '@camstack/ui-library'
import { FileUp } from 'lucide-react'
import { type ChangeEvent, type ReactNode, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { importSmartIr, type SmartIrImport } from './remote-config-model'

export interface SmartIrImportPanelProps {
  /** The transmitter the imported codes are sent through; null until one is picked. */
  readonly transmitterId: number | null
  readonly onApply: (draft: SmartIrDraft) => void
}

export function SmartIrImportPanel({ transmitterId, onApply }: SmartIrImportPanelProps): ReactNode {
  const { t } = useTranslation()
  const fileInput = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [result, setResult] = useState<SmartIrImport | null>(null)

  const parse = (source: string): void => {
    setResult(source.trim() === '' ? null : importSmartIr(source, transmitterId))
  }

  const onFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    setFileName(file.name)
    const source = await file.text()
    setText(source)
    parse(source)
  }

  return (
    <div className="space-y-2" data-testid="smartir-import">
      <p className="text-xs text-foreground-muted">{t('remote.import.hint')}</p>
      <FormField label={t('remote.import.pasteLabel')}>
        <Textarea
          value={text}
          rows={5}
          onChange={(e) => {
            setText(e.target.value)
            setFileName(null)
            setResult(null)
          }}
          className="w-full rounded border border-border bg-surface px-2 py-1 font-mono text-[11px]"
          data-testid="smartir-text"
        />
      </FormField>
      <div className="flex flex-wrap items-center gap-2">
        <FileInput
          ref={fileInput}
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => void onFile(e)}
          data-testid="smartir-file"
        />
        <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()}>
          <FileUp className="mr-1 h-3 w-3" aria-hidden />
          {t('remote.import.chooseFile')}
        </Button>
        {fileName !== null && (
          <span className="truncate font-mono text-[11px] text-foreground-subtle">{fileName}</span>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={text.trim() === ''}
          onClick={() => parse(text)}
          data-testid="smartir-read"
        >
          {t('remote.import.read')}
        </Button>
      </div>
      {result?.status === 'refused' && (
        <p role="alert" className="text-xs text-danger" data-testid="smartir-refused">
          {t(`remote.import.refused.${result.reason}`)}
        </p>
      )}
      {result?.status === 'ok' && (
        <div className="space-y-2" data-testid="smartir-summary">
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
              setText('')
              setFileName(null)
              setResult(null)
            }}
            data-testid="smartir-apply"
          >
            {t('remote.import.apply')}
          </Button>
        </div>
      )}
    </div>
  )
}
