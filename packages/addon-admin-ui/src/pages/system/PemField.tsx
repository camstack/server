import { useRef, useState } from 'react'
import { FileUp } from 'lucide-react'
import { Button } from '@camstack/ui-library'
import { checkPem, PEM_ACCEPT, type PemKind, readPemFile } from './pem-file'
import { useTranslation } from 'react-i18next'

export interface PemFieldProps {
  readonly kind: PemKind
  readonly label: string
  readonly value: string
  readonly onChange: (next: string) => void
  readonly rows?: number
}

/**
 * One PEM input: paste into the textarea, or pick a file whose text is read
 * in the browser into the same textarea. The cap input stays a PEM string —
 * no file travels to the hub.
 */
export function PemField({ kind, label, value, onChange, rows = 6 }: PemFieldProps) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const error = readError ?? checkPem(kind, value)
  const fieldId = `pem-${kind}`

  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    setFileName(file.name)
    try {
      const text = await readPemFile(file)
      setReadError(null)
      onChange(text)
    } catch (err) {
      setReadError(
        `Could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={fieldId} className="text-[11px] text-foreground-subtle">
          {label}
        </label>
        <div className="flex min-w-0 items-center gap-2">
          {fileName !== null && (
            <span
              className="truncate font-mono text-[10px] text-foreground-subtle"
              data-testid={`${fieldId}-file-name`}
            >
              {fileName}
            </span>
          )}
          <input
            ref={inputRef}
            type="file"
            accept={PEM_ACCEPT[kind]}
            onChange={(event) => void handleFile(event)}
            className="hidden"
            data-testid={`${fieldId}-file`}
          />
          <Button
            size="sm"
            variant="outline"
            type="button"
            onClick={() => inputRef.current?.click()}
          >
            <FileUp className="mr-1 h-3 w-3" />
            {t('system.pemField.chooseFile', 'Choose file')}
          </Button>
        </div>
      </div>
      <textarea
        id={fieldId}
        value={value}
        onChange={(event) => {
          setFileName(null)
          setReadError(null)
          onChange(event.target.value)
        }}
        rows={rows}
        aria-invalid={error !== null}
        className="w-full rounded border border-border bg-surface px-2 py-1 font-mono text-[11px]"
      />
      {error !== null && (
        <p className="text-[11px] text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
