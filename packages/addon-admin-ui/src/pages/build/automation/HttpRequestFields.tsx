/**
 * THEN → "HTTP request": one request, and optionally what the answer must be
 * for the step to pass. The result (`status`, `ok`, `json`, `text`, `error`) is
 * written to the variable named in "Save result as".
 *
 * Header values are stored as typed, in plain text: the editor says so.
 */
import {
  type AutomationHttpRequestStep,
  HTTP_BODY_MAX,
  HTTP_METHODS,
  HTTP_TIMEOUT_MAX_S,
  REACH_RETRY_INTERVAL_S,
  REACH_RETRY_MAX_S,
} from '@camstack/types'
import { Button, Input, Select, Switch, Textarea, DurationPartsInput } from '@camstack/ui-library'
import { Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { PickerLabel } from './FieldPicker'
import { operatorChoices } from './recipe-parts'
import {
  addHeader,
  canAddHeader,
  DEFAULT_HTTP_EXPECT,
  expectOn,
  expectValueOf,
  headerRows,
  httpBody,
  httpExpect,
  httpHeaders,
  httpRetry,
  httpSaveAs,
  removeHeader,
  renameHeader,
  setHeaderValue,
  wholeNumber,
} from './reach-step-model'
import { useDurationLabels } from '../../../lib/use-duration-labels'

/** Shown as written: how a step reads a variable of the run. */
const VAR_SLOT_EXAMPLE = '{{vars.name}}'

export interface HttpRequestFieldsProps {
  readonly index: number
  readonly step: AutomationHttpRequestStep
  readonly onChange: (next: AutomationHttpRequestStep) => void
}

function methodOf(value: string): AutomationHttpRequestStep['method'] {
  return HTTP_METHODS.find((m) => m === value) ?? 'GET'
}

export function HttpRequestFields({ index, step, onChange }: HttpRequestFieldsProps) {
  const { t } = useTranslation()
  const durationLabels = useDurationLabels()
  const at = String(index)
  const expect = step.expect
  const rows = headerRows(step.headers)
  const hasBody = step.method !== 'GET' && step.method !== 'DELETE'
  return (
    <div className="space-y-2" data-testid={`http-step-${at}`}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="w-28">
          <PickerLabel>{t('automation.reach.method', 'Method')}</PickerLabel>
          <Select
            data-testid={`http-method-${at}`}
            value={step.method}
            onChange={(e) => onChange({ ...step, method: methodOf(e.target.value) })}
            options={HTTP_METHODS.map((m) => ({ value: m, label: m }))}
          />
        </label>
        <label className="min-w-64 flex-1">
          <PickerLabel>{t('automation.reach.url', 'Address (URL)')}</PickerLabel>
          <Input
            data-testid={`http-url-${at}`}
            value={step.url}
            spellCheck={false}
            placeholder="http://192.168.20.158/sysinfo.json"
            onChange={(e) => onChange({ ...step, url: e.target.value })}
          />
        </label>
        <div>
          <PickerLabel>{t('automation.reach.timeout', 'Timeout (s)')}</PickerLabel>
          <DurationPartsInput
            aria-label={t('automation.reach.timeout', 'Timeout (s)')}
            seconds={step.timeoutSeconds}
            min={1}
            max={HTTP_TIMEOUT_MAX_S}
            labels={durationLabels}
            testIdPrefix={`http-timeout-${at}`}
            onChange={(seconds) => onChange({ ...step, timeoutSeconds: Math.max(1, seconds) })}
          />
        </div>
      </div>

      <div className="space-y-1">
        <PickerLabel>{t('automation.reach.headers', 'Headers')}</PickerLabel>
        {rows.map((row, row_at) => (
          <div key={String(row_at)} className="flex flex-wrap items-end gap-2">
            <Input
              className="w-40"
              data-testid={`http-header-name-${at}-${String(row_at)}`}
              aria-label={t('automation.reach.headerName', 'Header name')}
              value={row.name}
              spellCheck={false}
              placeholder="Authorization"
              onChange={(e) =>
                onChange(httpHeaders(step, renameHeader(step.headers, row_at, e.target.value)))
              }
            />
            <Input
              className="min-w-40 flex-1"
              data-testid={`http-header-value-${at}-${String(row_at)}`}
              aria-label={t('automation.reach.headerValue', 'Header value')}
              value={row.value}
              spellCheck={false}
              onChange={(e) =>
                onChange(httpHeaders(step, setHeaderValue(step.headers, row_at, e.target.value)))
              }
            />
            <Button
              variant="ghost"
              title={t('automation.reach.removeHeader', 'Remove this header')}
              onClick={() => onChange(httpHeaders(step, removeHeader(step.headers, row_at)))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          disabled={!canAddHeader(step.headers)}
          data-testid={`http-header-add-${at}`}
          onClick={() => onChange(httpHeaders(step, addHeader(step.headers)))}
        >
          <Plus className="h-4 w-4" /> {t('automation.reach.addHeader', 'Add a header')}
        </Button>
        <span className="block text-xs text-foreground-subtle">
          {t(
            'automation.reach.headersPlain',
            'Header values are saved as typed, in plain text, and are visible to anyone who can open this automation. They are never written to the run log.',
          )}
        </span>
      </div>

      {hasBody && (
        <label className="block">
          <PickerLabel>{t('automation.reach.body', 'Body')}</PickerLabel>
          <Textarea
            data-testid={`http-body-${at}`}
            value={step.body ?? ''}
            maxLength={HTTP_BODY_MAX}
            onChange={(e) => onChange(httpBody(step, e.target.value))}
          />
        </label>
      )}

      <div className="space-y-2">
        <Switch
          data-testid={`http-expect-on-${at}`}
          checked={expect !== undefined}
          label={t('automation.reach.expectOn', 'Check the answer')}
          aria-label={t('automation.reach.expectOn', 'Check the answer')}
          onCheckedChange={(on) =>
            onChange(httpExpect(step, on ? { ...DEFAULT_HTTP_EXPECT } : undefined))
          }
        />
        {expect === undefined ? (
          <span className="block text-xs text-foreground-subtle">
            {t(
              'automation.reach.expectDefault',
              'Without a check, the step passes on a 2xx answer.',
            )}
          </span>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <label className="w-40">
              <PickerLabel>{t('automation.reach.expectOf', 'The step passes when')}</PickerLabel>
              <Select
                data-testid={`http-expect-of-${at}`}
                value={expect.on}
                onChange={(e) =>
                  onChange(
                    httpExpect(
                      step,
                      expectOn(expect, e.target.value === 'json' ? 'json' : 'status'),
                    ),
                  )
                }
                options={[
                  { value: 'status', label: t('automation.reach.ofStatus', 'the status code') },
                  { value: 'json', label: t('automation.reach.ofJson', 'a JSON field') },
                ]}
              />
            </label>
            {expect.on === 'json' && (
              <label className="min-w-48 flex-1">
                <PickerLabel>{t('automation.reach.fieldPath', 'Field')}</PickerLabel>
                <Input
                  data-testid={`http-expect-field-${at}`}
                  value={expect.fieldPath ?? ''}
                  spellCheck={false}
                  placeholder="sysInfo.rawUartRemoteAddress"
                  onChange={(e) =>
                    onChange(httpExpect(step, { ...expect, fieldPath: e.target.value }))
                  }
                />
              </label>
            )}
            <label className="w-44">
              <PickerLabel>{t('automation.reach.compare', 'Is')}</PickerLabel>
              <Select
                data-testid={`http-expect-operator-${at}`}
                value={expect.operator}
                onChange={(e) => {
                  const picked = operatorChoices(undefined).find((o) => o.value === e.target.value)
                  if (picked !== undefined)
                    onChange(httpExpect(step, { ...expect, operator: picked.value }))
                }}
                options={operatorChoices(expect.on === 'status' ? 'number' : undefined).map(
                  (o) => ({
                    value: o.value,
                    label: o.label,
                  }),
                )}
              />
            </label>
            <label className="w-40">
              <PickerLabel>{t('automation.reach.expectValue', 'Value')}</PickerLabel>
              <Input
                data-testid={`http-expect-value-${at}`}
                value={String(expect.value)}
                onChange={(e) =>
                  onChange(
                    httpExpect(step, {
                      ...expect,
                      value: expectValueOf(expect.on, e.target.value),
                    }),
                  )
                }
              />
            </label>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <PickerLabel>{t('automation.reach.retry', 'Keep trying for (s)')}</PickerLabel>
          <DurationPartsInput
            aria-label={t('automation.reach.retry', 'Keep trying for (s)')}
            seconds={step.retryUntilSeconds ?? 0}
            max={REACH_RETRY_MAX_S}
            labels={durationLabels}
            testIdPrefix={`http-retry-${at}`}
            onChange={(seconds) => onChange(httpRetry(step, seconds > 0 ? seconds : undefined))}
          />
        </div>
        <label className="w-44">
          <PickerLabel>{t('automation.reach.saveAs', 'Save result as')}</PickerLabel>
          <Input
            data-testid={`http-save-as-${at}`}
            value={step.saveAs ?? ''}
            spellCheck={false}
            placeholder="sys"
            onChange={(e) => onChange(httpSaveAs(step, e.target.value))}
          />
        </label>
      </div>
      <span className="block text-xs text-foreground-subtle">
        {t(
          'automation.reach.httpHint',
          'With a time to keep trying, the request is repeated every {{every}} s until the answer is as expected; if it never is, the step fails. The address, headers and body may use {{slot}}.',
          { every: REACH_RETRY_INTERVAL_S, slot: VAR_SLOT_EXAMPLE },
        )}
      </span>
    </div>
  )
}
