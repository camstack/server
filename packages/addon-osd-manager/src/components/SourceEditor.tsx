import { useMemo } from 'react'
import { Input, Label, Select } from '@camstack/ui-library'
import type { OsdNamedTemplate, OsdSource } from '@camstack/types'
import { useT } from '../i18n/index.js'

interface SourceEditorProps {
  readonly source: OsdSource
  readonly templates: readonly OsdNamedTemplate[]
  readonly onChange: (source: OsdSource) => void
}

type SourceKind = OsdSource['kind']

function isSourceKind(value: string): value is SourceKind {
  return value === 'none' || value === 'static' || value === 'template'
}

/** Editor for one `OsdSource` — nothing, a fixed text, or a named device template. */
export function SourceEditor({ source, templates, onChange }: SourceEditorProps) {
  const { t } = useT()
  const kindOptions = useMemo(
    () => [
      { value: 'none', label: t('source.kind.none') },
      { value: 'static', label: t('source.kind.static') },
      { value: 'template', label: t('source.kind.template') },
    ],
    [t],
  )
  const templateOptions = useMemo(
    () => templates.map((tpl) => ({ value: tpl.id, label: tpl.name || tpl.id })),
    [templates],
  )

  return (
    <div className="space-y-2">
      <div>
        <Label htmlFor="osd-source-kind">{t('source.label')}</Label>
        <Select
          id="osd-source-kind"
          value={source.kind}
          options={kindOptions}
          onChange={(e) => {
            const kind = e.target.value
            if (!isSourceKind(kind)) return
            if (kind === 'none') onChange({ kind: 'none' })
            else if (kind === 'static') onChange({ kind: 'static', text: '' })
            else onChange({ kind: 'template', templateId: templates[0]?.id ?? '' })
          }}
        />
      </div>

      {source.kind === 'none' ? (
        <p className="text-xs text-foreground-subtle" data-testid="osd-source-none-hint">
          {t('source.noneHint')}
        </p>
      ) : null}

      {source.kind === 'static' && (
        <div>
          <Label htmlFor="osd-source-static-text">{t('source.text')}</Label>
          <Input
            id="osd-source-static-text"
            value={source.text}
            maxLength={64}
            onChange={(e) => onChange({ kind: 'static', text: e.target.value })}
          />
        </div>
      )}

      {source.kind === 'template' && (
        <div>
          <Label htmlFor="osd-source-template">{t('source.namedTemplate')}</Label>
          {templateOptions.length === 0 ? (
            <p className="text-xs text-foreground-muted">{t('source.noTemplates')}</p>
          ) : (
            <Select
              id="osd-source-template"
              value={source.templateId}
              options={templateOptions}
              onChange={(e) => onChange({ kind: 'template', templateId: e.target.value })}
            />
          )}
        </div>
      )}
    </div>
  )
}
