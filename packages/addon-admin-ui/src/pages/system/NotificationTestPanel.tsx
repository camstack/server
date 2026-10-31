/**
 * Caps-driven notification test panel (T15).
 *
 * Opened as a modal from a target row. Given the target's kind
 * descriptor (`TargetKind.caps`), it renders EXACTLY the controls the kind
 * supports — level select + priority slider, format radios, a body
 * textarea with an overflow counter, per-media-type attachment URL inputs,
 * action rows, and the optional clickUrl/sound/ttl/tag fields — then sends
 * `testTarget({ targetId, sample, addonId })` and renders the `TestResult`
 * including the `renderedAs` degradation report so the operator SEES what
 * the degrade engine did (resolved level, transcoded format, dropped
 * fields).
 *
 * All "what to show" / "what to send" logic lives in the pure
 * `notification-test-composer` module (unit-tested); this file is the thin
 * React shell around it.
 */

import type { Target, TargetKind, TestResult } from '@camstack/types'
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useSystem,
  Input,
  Radio,
  Slider,
  Textarea,
  Select,
} from '@camstack/ui-library'
import { useMutation } from '@tanstack/react-query'
import { AlertCircle, CheckCircle, Loader2, Send } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  availablePresets,
  buildPreset,
  composeTestSample,
  emptyForm,
  type TestFormState,
  type TestPresetId,
  visibleControls,
} from './notification-test-composer'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

interface NotificationTestPanelProps {
  readonly target: Target
  readonly kind: TargetKind
  readonly open: boolean
  readonly onClose: () => void
}

/**
 * Preset labels, phrased as the question the operator is answering. Which of
 * these are OFFERED is decided per kind by `availablePresets` — a preset the
 * target cannot honour is never shown, because "With video" on a target with no
 * video support teaches that the product is broken when it is the target that
 * is limited.
 */
const PRESET_LABELS: Readonly<Record<TestPresetId, string>> = {
  get text() {
    return i18n.t('system.notificationTestPanel.presetText')
  },
  get image() {
    return i18n.t('system.notificationTestPanel.presetImage')
  },
  get gif() {
    return i18n.t('system.notificationTestPanel.presetGif')
  },
  get video() {
    return i18n.t('system.notificationTestPanel.presetVideo')
  },
  get audio() {
    return i18n.t('system.notificationTestPanel.presetAudio')
  },
  get actions() {
    return i18n.t('system.notificationTestPanel.presetActions')
  },
  get critical() {
    return i18n.t('system.notificationTestPanel.presetCritical')
  },
  get overflow() {
    return i18n.t('system.notificationTestPanel.presetOverflow')
  },
}

const FIELD_CLASS =
  'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground focus:border-primary focus:ring-1 focus:ring-primary/30 outline-none'
const LABEL_CLASS = 'block text-[11px] font-medium text-foreground mb-1'

export function NotificationTestPanel({ target, kind, open, onClose }: NotificationTestPanelProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const controls = useMemo(() => visibleControls(kind.caps), [kind.caps])
  const presets = useMemo(() => availablePresets(kind.caps), [kind.caps])
  const [form, setForm] = useState<TestFormState>(() => emptyForm(kind.caps))
  const [result, setResult] = useState<TestResult | null>(null)

  const sample = useMemo(() => composeTestSample(kind.caps, form), [kind.caps, form])
  const bodyLen = form.body.length
  const overflow = bodyLen > controls.bodyMaxLen

  const patch = (p: Partial<TestFormState>): void => setForm((prev) => ({ ...prev, ...p }))

  const testMutation = useMutation({
    mutationFn: (): Promise<TestResult> =>
      // `addonId` is threaded top-level so the collection router dispatches
      // to the ONE provider that owns this target.
      system.trpcClient.notificationOutput.testTarget.mutate({
        addonId: target.addonId,
        targetId: target.id,
        sample: composeTestSample(kind.caps, form),
      }),
    onMutate: () => setResult(null),
    onSuccess: (data) => setResult(data),
    onError: (err: unknown) =>
      setResult({
        success: false,
        error:
          err instanceof Error ? err.message : i18n.t('system.notificationTestPanel.testFailed'),
      }),
  })

  const applyPreset = (id: TestPresetId): void => {
    setForm(buildPreset(kind.caps, id))
    setResult(null)
  }

  const setActionRow = (idx: number, field: 'label' | 'url', value: string): void => {
    const rows = form.actions.length > 0 ? [...form.actions] : []
    while (rows.length <= idx) rows.push({ label: '', url: '' })
    rows[idx] = { ...rows[idx]!, [field]: value }
    patch({ actions: rows })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {/* One scroller (`DialogBody`), not a `max-h-[60vh]` box nested inside
          a dialog that also scrolled: the title and the Send test button now
          hold their place while the composer's fields move. */}
      <DialogContent width="lg" className="!max-w-2xl" scroll="body">
        <DialogHeader>
          <DialogTitle>
            {t('system.notificationTestPanel.testTitle', { name: target.name, kind: kind.label })}
          </DialogTitle>
        </DialogHeader>

        <DialogBody className="space-y-4 pr-1">
          {/* Presets */}
          <div className="flex flex-wrap gap-1.5">
            {presets.map((id) => (
              <Button
                key={id}
                size="sm"
                variant="outline"
                type="button"
                onClick={() => applyPreset(id)}
              >
                {PRESET_LABELS[id]}
              </Button>
            ))}
          </div>

          {/* Level + priority */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {controls.levels.length > 0 && (
              <div>
                <label className={LABEL_CLASS}>
                  {t('system.notificationTestPanel.level', 'Level')}
                </label>
                <Select
                  wrapperClassName="inline-block w-auto"
                  className={FIELD_CLASS}
                  value={form.level}
                  onChange={(e) => patch({ level: e.target.value })}
                >
                  <option value="">
                    {t(
                      'system.notificationTestPanel.deriveFromPriority',
                      '— derive from priority —',
                    )}
                  </option>
                  {controls.levels.map((lvl) => (
                    <option key={lvl.id} value={lvl.id}>
                      {lvl.label}
                      {lvl.ordinal === null
                        ? ` (${t('system.notificationTestPanel.qualitative')})`
                        : ` (p${lvl.ordinal})`}
                    </option>
                  ))}
                </Select>
                {/* selected level detail + flags + requires hint */}
                {(() => {
                  const lvl = controls.levels.find((l) => l.id === form.level)
                  if (!lvl) return null
                  return (
                    <div className="mt-1 space-y-1">
                      {lvl.description && (
                        <p className="text-[10px] text-foreground-subtle">{lvl.description}</p>
                      )}
                      <div className="flex flex-wrap gap-1">
                        {lvl.flags?.critical && (
                          <Badge variant="danger" data-testid="flag-critical">
                            {t('system.notificationTestPanel.critical')}
                          </Badge>
                        )}
                        {lvl.flags?.silent && (
                          <Badge variant="info">{t('system.notificationTestPanel.silent')}</Badge>
                        )}
                        {lvl.flags?.noPush && <Badge variant="warning">no-push</Badge>}
                      </div>
                      {lvl.requires && lvl.requires.length > 0 && (
                        <p className="text-[10px] text-warning">
                          {t(
                            'system.notificationTestPanel.requiresTargetConfig',
                            'Requires target config:',
                          )}{' '}
                          {lvl.requires.join(', ')}
                        </p>
                      )}
                    </div>
                  )
                })()}
              </div>
            )}
            <div>
              <label className={LABEL_CLASS}>
                {t('system.notificationTestPanel.priorityOrdinal', 'Priority (ordinal):')}{' '}
                {form.priority}
              </label>
              <Slider
                min={1}
                max={5}
                step={1}
                value={form.priority}
                onChange={(e) => patch({ priority: Number(e.target.value) })}
                className="w-full accent-primary"
                aria-label={t('system.notificationTestPanel.priority')}
              />
            </div>
          </div>

          {/* Format */}
          {controls.formats.length > 0 && (
            <div>
              <label className={LABEL_CLASS}>
                {t('system.notificationTestPanel.format', 'Format')}
              </label>
              <div className="flex flex-wrap gap-2">
                {controls.formats.map((f) => (
                  <label
                    key={f}
                    className="flex items-center gap-1.5 text-xs text-foreground cursor-pointer"
                  >
                    <Radio
                      name="format"
                      className="accent-primary"
                      checked={form.format === f}
                      onChange={() => patch({ format: f })}
                    />
                    {f}
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Title + body */}
          <div>
            <label className={LABEL_CLASS}>
              {t('system.notificationTestPanel.testTitle', 'Title')}
            </label>
            <Input
              className={FIELD_CLASS}
              value={form.title}
              onChange={(e) => patch({ title: e.target.value })}
            />
          </div>
          <div>
            <label className={LABEL_CLASS}>
              {t('system.notificationTestPanel.body')}{' '}
              <span className={overflow ? 'text-danger' : 'text-foreground-subtle'}>
                ({bodyLen}/{controls.bodyMaxLen}
                {overflow ? ` — ${t('system.notificationTestPanel.overflow')}` : ''})
              </span>
            </label>
            <Textarea
              className={`${FIELD_CLASS} min-h-[80px] resize-y`}
              value={form.body}
              onChange={(e) => patch({ body: e.target.value })}
            />
          </div>

          {/* Attachments */}
          {controls.attachmentSlots.length > 0 && (
            <div>
              <label className={LABEL_CLASS}>
                {t('system.notificationTestPanel.attachments')}{' '}
                <span className="text-foreground-subtle">
                  {controls.attachmentMaxBytes
                    ? t('system.notificationTestPanel.attachmentsMetaMb', {
                        mode: controls.attachmentMode,
                        max: controls.attachmentMax,
                        mb: Math.round(controls.attachmentMaxBytes / 1024 / 1024),
                      })
                    : t('system.notificationTestPanel.attachmentsMeta', {
                        mode: controls.attachmentMode,
                        max: controls.attachmentMax,
                      })}
                </span>
              </label>
              <div className="space-y-1.5">
                {controls.attachmentSlots.map((mt) => (
                  <div key={mt} className="flex items-center gap-2">
                    <span className="text-[10px] w-12 shrink-0 text-foreground-subtle">{mt}</span>
                    <Input
                      className={FIELD_CLASS}
                      placeholder={t('system.notificationTestPanel.url', '{{mt}} URL', { mt })}
                      value={form.attachmentUrls[mt] ?? ''}
                      onChange={(e) =>
                        patch({ attachmentUrls: { ...form.attachmentUrls, [mt]: e.target.value } })
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          {controls.showActions && (
            <div>
              <label className={LABEL_CLASS}>
                {t('system.notificationTestPanel.actionsUpTo', { max: controls.maxActions })}
              </label>
              <div className="space-y-1.5">
                {Array.from({ length: Math.min(controls.maxActions, 3) }, (_v, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      className={FIELD_CLASS}
                      placeholder={t('system.notificationTestPanel.actionLabelPlaceholder')}
                      value={form.actions[i]?.label ?? ''}
                      onChange={(e) => setActionRow(i, 'label', e.target.value)}
                    />
                    <Input
                      className={FIELD_CLASS}
                      placeholder={t('system.notificationTestPanel.actionUrlPlaceholder')}
                      value={form.actions[i]?.url ?? ''}
                      onChange={(e) => setActionRow(i, 'url', e.target.value)}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Optional flag-gated fields */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {controls.showClickUrl && (
              <div>
                <label className={LABEL_CLASS}>
                  {t('system.notificationTestPanel.clickUrl', 'Click URL')}
                </label>
                <Input
                  className={FIELD_CLASS}
                  value={form.clickUrl}
                  onChange={(e) => patch({ clickUrl: e.target.value })}
                />
              </div>
            )}
            {controls.showSound && (
              <div>
                <label className={LABEL_CLASS}>
                  {t('system.notificationTestPanel.sound', 'Sound')}
                </label>
                <Input
                  className={FIELD_CLASS}
                  value={form.sound}
                  onChange={(e) => patch({ sound: e.target.value })}
                />
              </div>
            )}
            {controls.showTtl && (
              <div>
                <label className={LABEL_CLASS}>
                  {t('system.notificationTestPanel.ttlSeconds', 'TTL (seconds)')}
                </label>
                <Input
                  className={FIELD_CLASS}
                  type="number"
                  value={form.ttl}
                  onChange={(e) => patch({ ttl: e.target.value })}
                />
              </div>
            )}
            {controls.showTag && (
              <div>
                <label className={LABEL_CLASS}>
                  {t('system.notificationTestPanel.tag', 'Tag')}
                </label>
                <Input
                  className={FIELD_CLASS}
                  value={form.tag}
                  onChange={(e) => patch({ tag: e.target.value })}
                />
              </div>
            )}
          </div>

          {/* Result / renderedAs report */}
          {result && <TestResultReport result={result} />}

          {/* Debug: the exact sample that will be sent */}
          <details className="text-[10px]">
            <summary className="cursor-pointer text-foreground-subtle">
              {t('system.notificationTestPanel.payloadPreview', 'Payload preview')}
            </summary>
            <pre className="mt-1 overflow-x-auto rounded bg-surface p-2 text-foreground-subtle">
              {JSON.stringify(sample, null, 2)}
            </pre>
          </details>
        </DialogBody>

        <DialogFooter>
          <Button variant="secondary" size="sm" type="button" onClick={onClose}>
            {t('common.close', 'Close')}
          </Button>
          <Button
            size="sm"
            type="button"
            disabled={testMutation.isPending || form.body.length === 0}
            onClick={() => testMutation.mutate()}
          >
            {testMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            {t('system.notificationTestPanel.sendTest', 'Send test')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Renders the TestResult + the degrade engine's `renderedAs` block. */
function TestResultReport({ result }: { readonly result: TestResult }) {
  const { t } = useTranslation()
  const r = result.renderedAs
  return (
    <div
      className={`rounded-md border px-3 py-2 text-xs ${
        result.success ? 'border-success/40 bg-success/10' : 'border-danger/40 bg-danger/10'
      }`}
      data-testid="test-result"
    >
      <div className="flex items-center gap-2 font-medium">
        {result.success ? (
          <CheckCircle className="h-3.5 w-3.5 text-success" />
        ) : (
          <AlertCircle className="h-3.5 w-3.5 text-danger" />
        )}
        <span>
          {result.success
            ? t('system.notificationTestPanel.delivered', 'Delivered')
            : t('system.notificationTestPanel.failed', 'Failed')}
        </span>
      </div>
      {result.error && <p className="mt-1 text-danger">{result.error}</p>}
      {r && (
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-foreground-subtle">
          <dt>{t('system.notificationTestPanel.resolvedLevel', 'Resolved level')}</dt>
          <dd className="text-foreground">{r.level}</dd>
          <dt>{t('system.notificationTestPanel.formatSent', 'Format sent')}</dt>
          <dd className="text-foreground">{r.format}</dd>
          <dt>{t('system.notificationTestPanel.attachmentsSent', 'Attachments sent')}</dt>
          <dd className="text-foreground">{r.attachmentsSent}</dd>
          <dt>{t('system.notificationTestPanel.actionsSent', 'Actions sent')}</dt>
          <dd className="text-foreground">{r.actionsSent}</dd>
          <dt>{t('system.notificationTestPanel.truncated', 'Truncated')}</dt>
          <dd className="text-foreground">{r.truncated ? t('common.yes') : t('common.no')}</dd>
          <dt>{t('system.notificationTestPanel.dropped', 'Dropped')}</dt>
          <dd className="text-foreground">{r.dropped.length > 0 ? r.dropped.join(', ') : '—'}</dd>
        </dl>
      )}
    </div>
  )
}

export default NotificationTestPanel
