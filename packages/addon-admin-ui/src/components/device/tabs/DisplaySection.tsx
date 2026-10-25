/**
 * DisplaySection — operator UI for a device's per-device display override
 * (`DeviceMeta.display`), for EVERY device, plus a one-click "set as default
 * for this role" where the device has one.
 *
 * This is the admin half of a two-level icon design: what is chosen here is
 * global (every client draws it); the viewer keeps a local, per-phone choice
 * of its own on top. The server resolves device override → role default →
 * type icon, and this section writes the first level only.
 *
 * It used to render for role-bearing devices only — "an accessory-sensor
 * affordance" — which left a camera, a hub or a container with no way to
 * change its icon at all. The icon and the hidden flag apply to any device;
 * unit/precision still show only for numeric sensor roles, and the label only
 * where something DRAWS it (`childListName` on a child row, the role caption
 * on an accessory) — a knob that writes a store nobody reads is worse than no
 * knob (D62).
 *
 * Reads the device row via `useDeviceManagerGetDevice` (carries `display`,
 * `role`, `type`, `parentDeviceId`) and the live source unit via
 * `useDeviceCapSlice` (the sensor's cap name equals its role string). Unit
 * choices are ONLY same-dimension (`unitsForDimension`) so the picker can
 * never author a refused conversion. Writes the FULL override object
 * immutably via `useDeviceManagerSetDisplay` (empty form → `null` clears);
 * the icon and the label share that one write.
 *
 * NOT a role knob: `role` also decides which child of a container represents
 * it (`resolveContainerPrimaryChild`), and that rule is what made every
 * ESPHome shutter vanish from the viewer. A graphical setting must not be a
 * second authority over that question.
 *
 * Card chrome mirrors `DeviceInfoAdapter` — the sibling "Device Info" section
 * on the same Overview tab — via the same `InfoRow` primitive.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { DeviceDisplayOverride } from '@camstack/types'
import { DeviceType, normalizeUnit, unitDimension } from '@camstack/types'
import {
  ROLE_DESCRIPTOR,
  deviceRoleMetaOf,
  deviceTypeMetaOf,
  resolveDisplayIcon,
  useIconGlyphsVersion,
  useDeviceCapSlice,
  useDeviceManagerGetDevice,
  useDeviceManagerGetRoleDisplayDefaults,
  useDeviceManagerSetDisplay,
  useDeviceManagerSetRoleDisplayDefaults,
  useSystem,
  useUiText,
} from '@camstack/ui-library'
import { PrecisionInput } from '../../shared/PrecisionInput'
import { UnitPicker } from '../../shared/UnitPicker'
import { useQuickDetailSave } from '../quick-detail-save'
import { InfoRow } from '../overview-adapters/shared/overview-primitives'
import { DisplayIconPicker } from './DisplayIconPicker'

/** Compact form-control style shared by every row's input/select — matches
 *  the editable rows in `DeviceInfoAdapter` (`EditableNameRow`,
 *  `LocationRow`) so an override field reads like the rest of the card. */
const FIELD_CLASS =
  'w-full min-w-0 px-1.5 py-0.5 text-[11px] bg-background border border-border rounded focus:outline-none focus:border-primary disabled:opacity-50'

interface DisplaySectionProps {
  readonly deviceId: number
}

/** Editable form state — every field a string (empty = "inherit"). */
interface DisplayForm {
  readonly icon: string
  readonly label: string
  readonly unit: string
  readonly precision: string
  readonly hidden: boolean
}

const EMPTY_FORM: DisplayForm = { icon: '', label: '', unit: '', precision: '', hidden: false }

export function displayFormsEqual(a: DisplayForm, b: DisplayForm): boolean {
  return (
    a.icon === b.icon &&
    a.label === b.label &&
    a.unit === b.unit &&
    a.precision === b.precision &&
    a.hidden === b.hidden
  )
}

function formFromOverride(display: DeviceDisplayOverride | undefined): DisplayForm {
  return {
    icon: display?.icon ?? '',
    label: display?.label ?? '',
    unit: display?.unit ?? '',
    precision: display?.precision !== undefined ? String(display.precision) : '',
    hidden: display?.hidden === true,
  }
}

/** Read a live cap slice's `unit` field defensively (`unknown` slice). */
function sliceUnitOf(slice: unknown): string | undefined {
  if (typeof slice !== 'object' || slice === null) return undefined
  const raw = (slice as Record<string, unknown>)['unit']
  return typeof raw === 'string' ? raw : undefined
}

function parsePrecision(raw: string): number | undefined {
  if (raw.trim() === '') return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Build a `DeviceDisplayOverride` from the form, or `null` when fully empty.
 *
 * `perCap` is carried over from the persisted override untouched: this form
 * does not edit it, and a Save that dropped it would silently undo a
 * per-cap refinement written elsewhere.
 */
export function overrideFromForm(
  form: DisplayForm,
  persisted: DeviceDisplayOverride | undefined,
): DeviceDisplayOverride | null {
  const precision = parsePrecision(form.precision)
  const next: DeviceDisplayOverride = {
    ...(form.icon !== '' ? { icon: form.icon } : {}),
    ...(form.label.trim() !== '' ? { label: form.label.trim() } : {}),
    ...(form.unit !== '' ? { unit: form.unit } : {}),
    ...(precision !== undefined ? { precision } : {}),
    ...(form.hidden ? { hidden: true } : {}),
    ...(persisted?.perCap !== undefined ? { perCap: persisted.perCap } : {}),
  }
  return Object.keys(next).length === 0 ? null : next
}

export function DisplaySection({ deviceId }: DisplaySectionProps): ReactNode {
  const uiText = useUiText()
  // Re-render when the lazy glyph table arrives (a role default's glyph may not be loaded yet).
  useIconGlyphsVersion()
  const { t } = useTranslation()
  const system = useSystem()
  const queryClient = useQueryClient()

  const { data: device } = useDeviceManagerGetDevice({ deviceId }, { enabled: deviceId > 0 })
  const role = typeof device?.role === 'string' && device.role.length > 0 ? device.role : null
  const descriptor = role !== null ? ROLE_DESCRIPTOR[role] : undefined
  const isNumericRole = descriptor?.kind === 'numeric'
  const type = String(device?.type ?? '')
  // The label is drawn on a child row (`childListName`) and as the role
  // caption of an accessory. A top-level device without a role shows its
  // NAME, and its name is edited in Device Info — offering a label here
  // would write a value nothing renders.
  const labelIsDrawn =
    role !== null || (device?.parentDeviceId !== null && device?.parentDeviceId !== undefined)

  // Live source unit: the sensor cap name equals its role string. Typed roles
  // also carry a fixed canonical unit; the live slice unit wins when present.
  // Normalize before `unitDimension` — providers often send `C` / `F`, and the
  // unit table only knows canonical spellings (D699 display picker).
  const slice = useDeviceCapSlice(system.trpcClient, deviceId, role ?? '')
  const canonicalUnit = descriptor?.kind === 'numeric' ? descriptor.canonicalUnit : undefined
  const sourceUnitRaw = sliceUnitOf(slice) ?? canonicalUnit
  const sourceUnit =
    sourceUnitRaw !== undefined ? (normalizeUnit(sourceUnitRaw) ?? sourceUnitRaw) : undefined
  const dimension = sourceUnit !== undefined ? unitDimension(sourceUnit) : undefined

  const [form, setForm] = useState<DisplayForm | null>(null)
  // Seed the form from the persisted override once the device row lands. Kept
  // in a lazy-null state so a later refetch doesn't clobber in-progress edits.
  const effectiveForm = form ?? formFromOverride(device?.display)

  const setDisplay = useDeviceManagerSetDisplay({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
    },
  })
  const { data: roleDefaultsData } = useDeviceManagerGetRoleDisplayDefaults(
    {},
    { staleTime: 60_000, enabled: role !== null },
  )
  const setRoleDefaults = useDeviceManagerSetRoleDisplayDefaults({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
    },
  })

  const external = useQuickDetailSave()
  const baseline = formFromOverride(device?.display)
  const displayDirty = device != null && !displayFormsEqual(effectiveForm, baseline)
  const displayError = setDisplay.isError
    ? setDisplay.error instanceof Error
      ? setDisplay.error.message
      : String(setDisplay.error)
    : null
  const saveRef = useRef(async (): Promise<void> => {})
  const discardRef = useRef((): void => {})
  saveRef.current = async () => {
    if (device == null) return
    await setDisplay.mutateAsync({
      deviceId,
      display: overrideFromForm(effectiveForm, device.display),
    })
  }
  discardRef.current = () => setForm(baseline)
  const register = external?.register
  useEffect(() => {
    if (register === undefined || device == null) return
    return register({
      id: 'display',
      dirty: displayDirty,
      saving: setDisplay.isPending,
      error: displayError,
      save: () => saveRef.current(),
      discard: () => discardRef.current(),
    })
  }, [register, device, displayDirty, setDisplay.isPending, displayError])

  if (device === undefined || device === null) return null

  const update = (patch: Partial<DisplayForm>): void => {
    setForm({ ...effectiveForm, ...patch })
  }

  const onSave = (): void => {
    setDisplay.mutate({ deviceId, display: overrideFromForm(effectiveForm, device.display) })
  }

  const onReset = (): void => {
    setForm(EMPTY_FORM)
    setDisplay.mutate({ deviceId, display: null })
  }

  const onSetRoleDefault = (): void => {
    if (role === null) return
    const precision = parsePrecision(effectiveForm.precision)
    const roleLevel = {
      ...(effectiveForm.icon !== '' ? { icon: effectiveForm.icon } : {}),
      ...(effectiveForm.unit !== '' ? { unit: effectiveForm.unit } : {}),
      ...(precision !== undefined ? { precision } : {}),
    }
    const nextDefaults = { ...roleDefaultsData?.defaults, [role]: roleLevel }
    setRoleDefaults.mutate({ defaults: nextDefaults })
  }

  // What the row draws with no override — the SAME resolution the rows run
  // (`deviceLeadIcon` minus its first level): the operator's role default,
  // else the role glyph, else the type glyph. A container's inherited glyph
  // is its primary child's, which this section cannot know without the
  // children — say so instead of drawing the box.
  const roleDefaultIconKey = role !== null ? roleDefaultsData?.defaults[role]?.icon : undefined
  const roleDefaultIcon =
    roleDefaultIconKey !== undefined ? resolveDisplayIcon(roleDefaultIconKey) : undefined
  const builtIn = role !== null ? deviceRoleMetaOf(role, uiText) : deviceTypeMetaOf(type, uiText)
  const inherited = {
    icon: roleDefaultIcon ?? builtIn.icon,
    label: roleDefaultIcon !== undefined ? String(roleDefaultIconKey) : builtIn.label,
  }
  const inheritedLabel =
    role === null && type === DeviceType.Container
      ? t('deviceDisplay.inheritedContainer')
      : roleDefaultIcon !== undefined
        ? t('deviceDisplay.inheritedRoleDefault', { icon: inherited.label, role: builtIn.label })
        : t('deviceDisplay.inherited', { name: inherited.label })
  const deviceName = typeof device.name === 'string' ? device.name : `#${String(deviceId)}`
  const roleLabel = role !== null ? deviceRoleMetaOf(role, uiText).label : ''

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <div className="border-b border-border px-3 sm:px-4 py-2">
        <h2 className="text-[11px] font-semibold text-foreground uppercase tracking-wider">
          {t('deviceDisplay.title')}
        </h2>
      </div>
      <div className="divide-y divide-border">
        <InfoRow
          label={t('deviceDisplay.icon')}
          value={
            <DisplayIconPicker
              deviceName={deviceName}
              value={effectiveForm.icon}
              inheritedIcon={inherited.icon}
              inheritedLabel={inheritedLabel}
              disabled={setDisplay.isPending}
              onChange={(icon) => update({ icon })}
            />
          }
        />

        {labelIsDrawn && (
          <InfoRow
            label={t('deviceDisplay.label')}
            value={
              <input
                type="text"
                className={FIELD_CLASS}
                aria-label={t('deviceDisplay.label')}
                placeholder={role !== null ? roleLabel : deviceName}
                value={effectiveForm.label}
                onChange={(e) => update({ label: e.target.value })}
              />
            }
          />
        )}

        {/* Unit + precision — numeric sensor roles only. Display only (Q1). */}
        {isNumericRole && (
          <>
            <InfoRow
              label={t('deviceDisplay.unit')}
              value={
                <UnitPicker
                  dimension={dimension}
                  value={effectiveForm.unit}
                  onChange={(unit) => update({ unit })}
                  disabled={setDisplay.isPending}
                  aria-label={t('deviceDisplay.unit')}
                  inheritLabel={t('deviceDisplay.unitSource', {
                    unit: sourceUnit !== undefined ? ` (${sourceUnit})` : '',
                  })}
                  emptyReason={t('deviceDisplay.unitSource', { unit: '' })}
                />
              }
            />
            <InfoRow
              label={t('deviceDisplay.precision')}
              value={
                <PrecisionInput
                  aria-label={t('deviceDisplay.precision')}
                  placeholder={t('deviceDisplay.precisionInherit')}
                  value={effectiveForm.precision}
                  onChange={(precision) => update({ precision })}
                  disabled={setDisplay.isPending}
                />
              }
            />
          </>
        )}

        <InfoRow
          label={t('deviceDisplay.hidden')}
          value={
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={effectiveForm.hidden}
                onChange={(e) => update({ hidden: e.target.checked })}
              />
              <span className="text-[11px] text-foreground">
                {t('deviceDisplay.hideFromLists')}
              </span>
            </label>
          }
        />
      </div>

      {/* The modal collects this section into its one Save. On the device
          page the section keeps its own buttons. */}
      {(external === null || role !== null) && (
        <div className="border-t border-border px-3 sm:px-4 py-2 flex flex-wrap items-center gap-2">
          {external === null && (
            <button
              type="button"
              className="rounded bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
              onClick={onSave}
              disabled={setDisplay.isPending}
            >
              {t('common.save')}
            </button>
          )}
          {external === null && (
            <button
              type="button"
              className="rounded border border-border px-3 py-1 text-[11px] text-foreground-subtle"
              onClick={onReset}
              disabled={setDisplay.isPending}
            >
              {t('common.reset')}
            </button>
          )}
          {role !== null && (
            <button
              type="button"
              className="rounded border border-border px-3 py-1 text-[11px] text-foreground-subtle"
              onClick={onSetRoleDefault}
              disabled={setRoleDefaults.isPending}
              title={t('deviceDisplay.setRoleDefaultTitle', { role: roleLabel })}
            >
              {t('deviceDisplay.setRoleDefault', { role: roleLabel })}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
