/**
 * The controls the two SCHEDULED-PRODUCER editors (Summaries, Timelapses) share.
 *
 * Both author a rule that fires on a window, both pick cameras and delivery
 * targets, both refuse to save a rule that could never produce, and both have a
 * Test button that DELIVERS a real notification to real phones. Duplicating any
 * of that would mean two dialogs that drift — most dangerously the confirm on
 * Test, which is the only thing standing between a curious click and everyone
 * in the household getting a notification at 15:00.
 *
 * Presentational only: no queries, no mutations, no router. Every one of these
 * takes its value and its setter.
 */

import {
  Button,
  Dialog,
  DialogContent,
  Input,
  NotificationTargetsField,
  Switch,
  type NotificationTargetOption,
  type NotificationTargetsFieldProps,
} from '@camstack/ui-library'
import { AlertTriangle, Info, Send } from 'lucide-react'
import type { ReactNode } from 'react'
import { TemplateField, TemplatePreview } from '../../components/notifications/TemplateField'
import { varsForContext } from '../../components/notifications/template-field.helpers'
import { useTemplateCatalog } from '../../components/notifications/use-template-catalog'
import { DevicePicker } from './DevicePicker'
import type { DeviceFleetView } from './device-fleet-view'
import { useTranslation } from 'react-i18next'

export const DIGEST_LABEL_CLASS = 'block text-[11px] font-medium text-foreground mb-1'
export const DIGEST_HINT_CLASS = 'mt-1 text-[10px] text-foreground-subtle'

// ── Layout ───────────────────────────────────────────────────────────

export interface DigestSectionProps {
  readonly title: string
  readonly hint?: string
  readonly children: ReactNode
}

/** A titled block. The hint sits under the TITLE, not under the last control:
 *  it explains what the block is for, which is a thing you read first. */
export function DigestSection({ title, hint, children }: DigestSectionProps) {
  return (
    <div className="rounded-md border border-border px-3 py-3">
      <div className="mb-2 text-[11px] font-semibold text-foreground">{title}</div>
      {hint !== undefined && <p className="mb-2 text-[10px] text-foreground-subtle">{hint}</p>}
      <div className="space-y-3">{children}</div>
    </div>
  )
}

// ── Blocking problems / non-blocking warnings ────────────────────────

export interface DigestProblemsProps {
  readonly problems: readonly string[]
  readonly testId?: string
}

/**
 * Why Save is disabled, in words.
 *
 * A disabled button with no reason is the failure this replaces: the operator
 * concludes the page is broken, not that the rule is. Each entry is a sentence,
 * not a field name.
 */
export function DigestProblems({ problems, testId = 'digest-problems' }: DigestProblemsProps) {
  const { t } = useTranslation()
  if (problems.length === 0) return null
  return (
    <div
      className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-danger"
      data-testid={testId}
    >
      <div className="mb-1 flex items-center gap-1.5 font-medium">
        <AlertTriangle className="h-3.5 w-3.5" />
        {t(
          'system.notificationDigestFields.thisRuleCouldNeverProduce',
          'This rule could never produce anything, so it cannot be saved:',
        )}
      </div>
      <ul className="list-disc space-y-0.5 pl-4">
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </div>
  )
}

export interface DigestWarningsProps {
  readonly warnings: readonly string[]
  readonly testId?: string
}

/** What is odd but allowed. Never blocks — a warning that blocks is a rule. */
export function DigestWarnings({ warnings, testId = 'digest-warnings' }: DigestWarningsProps) {
  const { t } = useTranslation()
  if (warnings.length === 0) return null
  return (
    <div
      className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning"
      data-testid={testId}
    >
      <div className="mb-1 flex items-center gap-1.5 font-medium">
        <Info className="h-3.5 w-3.5" />
        {t('system.notificationDigestFields.worthKnowing', 'Worth knowing:')}
      </div>
      <ul className="list-disc space-y-0.5 pl-4">
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </div>
  )
}

// ── Cameras ──────────────────────────────────────────────────────────

export interface DigestCameraOption {
  readonly id: number
  readonly name: string
}

export interface DigestCameraFieldProps {
  readonly cameras: readonly DigestCameraOption[]
  readonly value: readonly number[]
  readonly onChange: (next: number[]) => void
  /** The whole fleet `cameras` is drawn from, and whether it ANSWERED. A
   *  selected id `cameras` lacks is a removable row: "Device #<id> — removed"
   *  when the answered fleet lacks it, its name when it is not a camera,
   *  "Device #<id>" while the fleet has not answered (D315, D49). */
  readonly fleet: DeviceFleetView
  /** Said under the list — what "no camera" costs on THIS surface. */
  readonly hint?: string
}

/**
 * Which cameras the rule covers — the smart picker (`DevicePicker`, D636):
 * the selection as chips, a searchable grouped list only to change it.
 *
 * An empty selection is NOT "every camera" here — it is a rule that can never
 * produce, and the caller's problem list refuses it. That is the opposite of
 * the notification-rule device condition, which is why the empty chip row
 * says "No camera selected" rather than "every camera".
 */
export function DigestCameraField({
  cameras,
  value,
  onChange,
  fleet,
  hint,
}: DigestCameraFieldProps) {
  return (
    <div className="space-y-1">
      <DevicePicker
        devices={cameras}
        listState={fleet.state}
        fleet={fleet}
        value={value}
        onChange={onChange}
        emptyLabel="No camera selected"
        testId="digest-camera-picker"
      />
      {hint !== undefined && <p className={DIGEST_HINT_CLASS}>{hint}</p>}
    </div>
  )
}

// ── Targets ──────────────────────────────────────────────────────────
//
// Lives in `@camstack/ui-library` as `NotificationTargetsField` so scripts
// and ConfigUISchema forms share the same control. These aliases keep the
// digest editors' call sites stable.

export type DigestTargetOption = NotificationTargetOption
export type DigestTargetsFieldProps = NotificationTargetsFieldProps

/** @deprecated Prefer `NotificationTargetsField` from `@camstack/ui-library`. */
export function DigestTargetsField(props: DigestTargetsFieldProps) {
  const { t } = useTranslation()
  return (
    <NotificationTargetsField
      {...props}
      testIdPrefix={props.testIdPrefix ?? 'digest-target'}
      emptyMessage={
        props.emptyMessage ??
        t(
          'system.notificationDigestFields.noDeliveryTargetIsConfigured',
          'No delivery target is configured. Add one on the Targets tab first — without one the artefact is rendered and thrown away.',
        )
      }
    />
  )
}

// ── Scalars ──────────────────────────────────────────────────────────

export interface DigestNumberFieldProps {
  readonly label: string
  readonly value: number | undefined
  readonly onChange: (next: number | undefined) => void
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly hint?: ReactNode
  /** Shown in the box when the value is `undefined` — what absence MEANS. */
  readonly emptyPlaceholder?: string
  readonly testId?: string
  readonly disabled?: boolean
}

/**
 * A number that may legitimately be ABSENT.
 *
 * Absence is a value on both of these rules (no minimum importance; derive the
 * dense cadence), and it is never the same thing as zero — so an empty box
 * yields `undefined` and the placeholder says what the hub will do with it.
 */
export function DigestNumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  hint,
  emptyPlaceholder,
  testId,
  disabled = false,
}: DigestNumberFieldProps) {
  return (
    <div>
      <label className={DIGEST_LABEL_CLASS}>{label}</label>
      <Input
        type="number"
        value={value === undefined ? '' : String(value)}
        disabled={disabled}
        {...(min !== undefined ? { min } : {})}
        {...(max !== undefined ? { max } : {})}
        {...(step !== undefined ? { step } : {})}
        {...(emptyPlaceholder !== undefined ? { placeholder: emptyPlaceholder } : {})}
        {...(testId !== undefined ? { 'data-testid': testId } : {})}
        onChange={(e) => {
          const raw = e.target.value.trim()
          if (raw.length === 0) {
            onChange(undefined)
            return
          }
          const parsed = Number(raw)
          if (Number.isFinite(parsed)) onChange(parsed)
        }}
      />
      {hint !== undefined && <p className={DIGEST_HINT_CLASS}>{hint}</p>}
    </div>
  )
}

export interface DigestSwitchFieldProps {
  readonly label: string
  readonly checked: boolean
  readonly onChange: (next: boolean) => void
  readonly hint?: string
  readonly testId?: string
}

export function DigestSwitchField({
  label,
  checked,
  onChange,
  hint,
  testId,
}: DigestSwitchFieldProps) {
  return (
    <div>
      <label className="flex items-center gap-2 text-[11px] font-medium text-foreground">
        <Switch
          checked={checked}
          onCheckedChange={onChange}
          aria-label={label}
          {...(testId !== undefined ? { 'data-testid': testId } : {})}
        />
        {label}
      </label>
      {hint !== undefined && <p className={DIGEST_HINT_CLASS}>{hint}</p>}
    </div>
  )
}

// ── Notification text ────────────────────────────────────────────────

export interface DigestTemplateFieldsProps {
  readonly title: string
  readonly body: string
  readonly onTitleChange: (next: string) => void
  readonly onBodyChange: (next: string) => void
  /** Which scheduled producer this is — picks the catalog's vocabulary. */
  readonly family: 'timelapse' | 'summary'
  readonly testIdPrefix: string
}

/**
 * The notification's own words.
 *
 * The chip vocabulary comes from the hub's catalog, filtered by `family`: the
 * two producers supply different vocabularies, and a hardcoded legend that
 * promised `{{detections}}` on a surface that never fills it would be a
 * documented lie.
 */
export function DigestTemplateFields({
  title,
  body,
  onTitleChange,
  onBodyChange,
  family,
  testIdPrefix,
}: DigestTemplateFieldsProps) {
  const { t } = useTranslation()
  const catalog = useTemplateCatalog()
  const varsFor = (field: 'title' | 'body') =>
    catalog.data ? varsForContext(catalog.data, { family, field }) : undefined
  return (
    <div className="space-y-2">
      <TemplateField
        label={t('system.notificationDigestFields.notificationTitle', 'Notification title')}
        value={title}
        onChange={onTitleChange}
        vars={varsFor('title')}
        testId={`${testIdPrefix}-title`}
      />
      <TemplateField
        label={t('system.notificationDigestFields.notificationBody', 'Notification body')}
        value={body}
        onChange={onBodyChange}
        vars={varsFor('body')}
        multiline
        testId={`${testIdPrefix}-body`}
      />
      <p className="text-[10px] text-foreground-subtle">
        {t(
          'system.notificationDigestFields.leaveBothBlankToUse',
          "Leave both blank to use the hub's own wording (editable on the Texts tab).",
        )}
      </p>
      <TemplatePreview
        context={{ family, field: 'body' }}
        title={title}
        body={body}
        testId={`${testIdPrefix}-preview`}
      />
    </div>
  )
}

// ── The Test confirm ─────────────────────────────────────────────────

export interface DigestTestConfirmProps {
  readonly open: boolean
  readonly ruleName: string
  /** What the run will cover, in words ("the last 3 hours"). */
  readonly windowDescription: string
  /** Where it will land, in words ("2 targets"). */
  readonly targetDescription: string
  readonly pending: boolean
  readonly onConfirm: () => void
  readonly onCancel: () => void
  /** A choice the run itself needs — the timelapse renders ONE camera. */
  readonly extra?: ReactNode
  /** Refuse the send while the choice above is unmade. */
  readonly confirmDisabled?: boolean
}

/**
 * The confirm in front of a Test that DELIVERS.
 *
 * Both test actions run the real producer down to the real outbox: the
 * notification lands on every phone the rule addresses, at whatever time the
 * button was pressed. That is the point — a test that stops before the notifier
 * does not test the thing that breaks — and it is exactly why it may not be one
 * click. The dialog names the window and the recipients, because "Test" on its
 * own reads like a dry run.
 */
export function DigestTestConfirm({
  open,
  ruleName,
  windowDescription,
  targetDescription,
  pending,
  onConfirm,
  onCancel,
  extra,
  confirmDisabled = false,
}: DigestTestConfirmProps) {
  const { t } = useTranslation()
  if (!open) return null
  return (
    <Dialog open onOpenChange={(next) => !next && onCancel()}>
      <DialogContent width="sm">
        <div className="space-y-3" data-testid="digest-test-confirm">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Send className="h-4 w-4 text-warning" />
            {t(
              'system.notificationDigestFields.sendARealNotificationNow',
              'Send a real notification now?',
            )}
          </h3>
          <p className="text-xs text-foreground-subtle">
            {t('system.notificationDigestFields.confirmSend', {
              rule: ruleName,
              window: windowDescription,
              target: targetDescription,
            })}
          </p>
          <p className="text-[11px] text-foreground-subtle">
            {t(
              'system.notificationDigestFields.itDoesNotConsumeThe',
              'It does not consume the schedule: the next scheduled run still happens.',
            )}
          </p>
          {extra}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" type="button" onClick={onCancel}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              size="sm"
              type="button"
              disabled={pending || confirmDisabled}
              onClick={onConfirm}
              data-testid="digest-test-confirm-send"
            >
              {pending
                ? t('system.notificationDigestFields.sending', 'Sending…')
                : t('system.notificationDigestFields.produceAndSend', 'Produce and send')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
