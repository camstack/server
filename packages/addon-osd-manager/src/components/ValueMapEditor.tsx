import { Button, Input, Label } from '@camstack/ui-library'
import { useT } from '../i18n/index.js'

interface ValueMapEditorProps {
  readonly valueMap: Record<string, string> | undefined
  readonly onChange: (valueMap: Record<string, string> | undefined) => void
}

/** Key/value editor for `valueMap` — raw source value → display text. */
export function ValueMapEditor({ valueMap, onChange }: ValueMapEditorProps) {
  const { t } = useT()
  const entries = Object.entries(valueMap ?? {})

  function setEntries(next: readonly (readonly [string, string])[]) {
    if (next.length === 0) {
      onChange(undefined)
      return
    }
    onChange(Object.fromEntries(next))
  }

  return (
    <div className="space-y-2">
      <Label>{t('valueMap.label')}</Label>
      {entries.map(([key, value], index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            aria-label={t('valueMap.keyAria', { n: index + 1 })}
            value={key}
            placeholder={t('valueMap.rawPlaceholder')}
            onChange={(e) => {
              const next = [...entries]
              next[index] = [e.target.value, value]
              setEntries(next)
            }}
          />
          <span className="text-foreground-muted text-xs">→</span>
          <Input
            aria-label={t('valueMap.textAria', { n: index + 1 })}
            value={value}
            placeholder={t('valueMap.displayPlaceholder')}
            onChange={(e) => {
              const next = [...entries]
              next[index] = [key, e.target.value]
              setEntries(next)
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t('valueMap.removeAria', { n: index + 1 })}
            onClick={() => setEntries(entries.filter((_, i) => i !== index))}
          >
            ✕
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setEntries([...entries, ['', '']])}
      >
        {t('valueMap.add')}
      </Button>
    </div>
  )
}
