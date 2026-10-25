/**
 * <ScopePicker> — operator-facing editor for a `TokenScope[]` value.
 *
 * Two consumers: the user-scope editor on `/system/users` (admin grants
 * a baseline scope set to a non-admin user) and the scoped-token create
 * modal on `/system/api-keys` (a caller carves out a subset of THEIR
 * scopes for a token).
 *
 * Row shapes per scope `type`:
 *   - category   → target: 'device' | 'system'
 *   - capability → target: cap name from `KNOWN_CAP_NAMES`
 *   - addon      → target: addon id from `useAddonsList`
 *   - device     → a v3 `DeviceSelector` (all / ids / types / locations)
 *                  plus `includeLinked`, edited by `<DeviceSelectorPicker>`
 *
 * `access` is always 3 independent checkboxes (view / create / delete).
 *
 * `clampToParent` narrows the target dropdown + access checkboxes to
 * what the CALLER possesses. Admins pass `null` to allow everything.
 *
 * This is the RAW editor, for TOKENS. People are not edited here: a person
 * is an Admin or a Viewer (D921), set from `/system/identity?tab=users`.
 */
import { useMemo, type ReactNode } from 'react'
import { Plus, X, Eye, Pencil, Trash2 } from 'lucide-react'
import {
  KNOWN_CAP_NAMES,
  resolveViewableDeviceIds,
  type DeviceMetaLike,
  type DeviceSelector,
  type TokenScope,
} from '@camstack/types'

import { DeviceSelectorPicker, describeDeviceSelector } from './device-selector-picker'
import { defaultUiText, useUiText, type UiTextFn } from '../contexts/ui-text'

/** `<select>` value → the tri-state `includeLinked` it means. */
const INCLUDE_LINKED_VALUES: Readonly<Record<string, boolean | undefined>> = {
  '': undefined,
  yes: true,
  no: false,
}
import { useAddonsList, useDeviceManagerListAll } from '../generated/system-hooks'

export type ScopeAccess = 'view' | 'create' | 'delete'

const ACCESS_OPTIONS: readonly {
  value: ScopeAccess
  labelKey: string
  labelFallback: string
  icon: typeof Eye
  hintKey: string
  hintFallback: string
}[] = [
  {
    value: 'view',
    labelKey: 'uiLibrary.scopePicker.accessView',
    labelFallback: 'View',
    icon: Eye,
    hintKey: 'uiLibrary.scopePicker.accessViewHint',
    hintFallback: 'Read-only — queries + subscriptions',
  },
  {
    value: 'create',
    labelKey: 'uiLibrary.scopePicker.accessCreate',
    labelFallback: 'Create',
    icon: Pencil,
    hintKey: 'uiLibrary.scopePicker.accessCreateHint',
    hintFallback: 'Mutations that create or update',
  },
  {
    value: 'delete',
    labelKey: 'uiLibrary.scopePicker.accessDelete',
    labelFallback: 'Delete',
    icon: Trash2,
    hintKey: 'uiLibrary.scopePicker.accessDeleteHint',
    hintFallback: 'Destructive ops (delete/revoke/reset/…)',
  },
]

interface ScopePickerProps {
  readonly value: readonly TokenScope[]
  readonly onChange: (next: TokenScope[]) => void
  /**
   * When set, the caller's own scope set. Each row's target dropdown
   * is narrowed to entries the caller already grants, and access
   * checkboxes are disabled for flavours the caller lacks. Admins
   * (unscoped) should pass `null` to allow everything.
   */
  readonly clampToParent?: readonly TokenScope[] | null
  /** Optional empty-state CTA when `value.length === 0`. */
  readonly emptyHint?: ReactNode
}

/** Static targets for the `category` scope type (auto-grow categories). */
const CATEGORY_CHOICES: readonly string[] = ['device', 'system']

interface TargetChoice {
  readonly value: string
  readonly label: string
}

function defaultRow(): TokenScope {
  return { type: 'capability', target: '', access: ['view'] }
}

/**
 * The deviceIds a parent's grants actually resolve to, against the live
 * fleet. Used to clamp the device picker so a child grant can't refer to a
 * device the caller themselves doesn't have.
 *
 * v3 selectors are not a literal id list, so this RESOLVES them through the
 * shared resolver rather than reading ids off the grant — a `types:['camera']`
 * parent must clamp to its cameras, and re-deriving that here is exactly the
 * drift D103 warns about. A parent holding `category:device` (unrestricted)
 * yields the whole fleet.
 */
function parentDeviceIds(
  parent: readonly TokenScope[] | null | undefined,
  fleet: readonly DeviceMetaLike[],
): readonly number[] {
  if (parent == null) return []
  const out = new Set<number>()
  for (const access of ['view', 'create', 'delete'] as const) {
    for (const id of resolveViewableDeviceIds(parent, fleet, access)) out.add(id)
  }
  return [...out]
}

function clampedSingleTargets(
  type: Exclude<TokenScope['type'], 'device'>,
  parent: readonly TokenScope[] | null | undefined,
  addonChoices: readonly TargetChoice[],
  capChoices: readonly TargetChoice[],
): readonly TargetChoice[] {
  let universe: readonly TargetChoice[]
  switch (type) {
    case 'addon':
      universe = addonChoices
      break
    case 'capability':
      universe = capChoices
      break
    case 'category':
      universe = CATEGORY_CHOICES.map((c) => ({ value: c, label: c }))
      break
  }
  if (parent == null) return universe
  // Narrow off the device variant before reading `.target` — that
  // variant carries `targets[]` instead of a singular `target`.
  const allowed = new Set(
    parent
      .filter(
        (s): s is Exclude<TokenScope, { type: 'device' }> => s.type !== 'device' && s.type === type,
      )
      .map((s) => s.target),
  )
  return universe.filter((t) => allowed.has(t.value))
}

function clampedAccessForRow(
  row: TokenScope,
  parent: readonly TokenScope[] | null | undefined,
): readonly ScopeAccess[] {
  if (parent == null) return ['view', 'create', 'delete']
  // For single-target rows: union access of parent grants that match
  // (same type + same target). For device rows: union access of every
  // parent device grant — the id-level intersection is enforced by the
  // picker's own clamp, and the server re-checks the subset regardless.
  const matches = parent.filter((s) => {
    if (s.type !== row.type) return false
    if (s.type === 'device' && row.type === 'device') return true
    if (s.type !== 'device' && row.type !== 'device') {
      return s.target === row.target
    }
    return false
  })
  if (matches.length === 0) return []
  const out = new Set<ScopeAccess>()
  for (const m of matches) for (const a of m.access) out.add(a)
  return [...out]
}

export function ScopePicker({
  value,
  onChange,
  clampToParent,
  emptyHint,
}: ScopePickerProps): React.ReactElement {
  const t = useUiText()
  const { data: addons } = useAddonsList()
  const { data: devices } = useDeviceManagerListAll({})

  const addonChoices = useMemo<TargetChoice[]>(
    () =>
      (addons ?? [])
        .map((a) => ({ value: a.manifest.id, label: a.manifest.id }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [addons],
  )
  const capChoices = useMemo<TargetChoice[]>(
    () => [...KNOWN_CAP_NAMES].toSorted().map((c) => ({ value: c, label: c })),
    [],
  )
  const fleet = useMemo<readonly DeviceMetaLike[]>(
    () =>
      (devices ?? []).map((d) => ({
        id: d.id,
        type: d.type,
        location: d.location,
        parentDeviceId: d.parentDeviceId,
      })),
    [devices],
  )
  const parentDeviceClamp = useMemo<readonly number[] | null>(
    () => (clampToParent == null ? null : parentDeviceIds(clampToParent, fleet)),
    [clampToParent, fleet],
  )

  /**
   * Build a fresh scope row when `type` changes. The discriminated union
   * forces us to re-construct the object per variant so the resulting
   * shape matches one of the four union members exactly.
   */
  const rebuildForType = (next: TokenScope['type'], access: readonly ScopeAccess[]): TokenScope => {
    const accessArr: ScopeAccess[] = [...access]
    switch (next) {
      case 'category':
        return { type: 'category', target: 'device', access: accessArr }
      case 'capability':
        return { type: 'capability', target: '', access: accessArr }
      case 'addon':
        return { type: 'addon', target: '', access: accessArr }
      case 'device':
        // A fresh device row starts at `ids: []` rather than `all`: an
        // operator who adds a row and forgets to fill it must grant NOTHING,
        // never everything. `validateScopes` refuses the empty list.
        return { type: 'device', selector: { kind: 'ids', ids: [] }, access: accessArr }
    }
  }

  type RowPatch = {
    readonly type?: TokenScope['type']
    readonly target?: string
    readonly selector?: DeviceSelector
    readonly includeLinked?: boolean
    readonly access?: readonly ScopeAccess[]
  }

  const update = (idx: number, patch: RowPatch): void => {
    onChange(
      value.map((s, i): TokenScope => {
        if (i !== idx) return s
        if (patch.type !== undefined && patch.type !== s.type) {
          return rebuildForType(patch.type, patch.access ?? s.access)
        }
        const access = [...(patch.access ?? s.access)]
        if (s.type === 'device') {
          const base = { type: 'device' as const, selector: patch.selector ?? s.selector, access }
          // ABSENCE is a third state — it means "let the matcher derive it"
          // (view inherits, create/delete don't). Defaulting it to `false`
          // while the operator edits an unrelated checkbox would silently
          // revoke a viewer's accessory access, so it is preserved verbatim
          // unless the patch names the field.
          const linked = 'includeLinked' in patch ? patch.includeLinked : s.includeLinked
          return linked === undefined ? base : { ...base, includeLinked: linked }
        }
        if (s.type === 'category') {
          const target = (patch.target ?? s.target) as 'device' | 'system'
          return { type: 'category', target, access }
        }
        if (s.type === 'capability') {
          return { type: 'capability', target: patch.target ?? s.target, access }
        }
        return { type: 'addon', target: patch.target ?? s.target, access }
      }),
    )
  }

  const removeAt = (idx: number): void => {
    onChange(value.filter((_, i) => i !== idx))
  }

  const append = (): void => {
    onChange([...value, defaultRow()])
  }

  return (
    <div className="space-y-2">
      {value.length === 0 && emptyHint && (
        <div className="text-[10px] text-foreground-subtle italic px-2 py-2">{emptyHint}</div>
      )}
      {value.map((row, idx) => {
        const allowedAccess = clampedAccessForRow(row, clampToParent)
        return (
          <div
            key={idx}
            className="flex flex-wrap items-start gap-1.5 rounded border border-border bg-surface px-2 py-1.5"
          >
            <select
              value={row.type}
              onChange={(e) => update(idx, { type: e.target.value as TokenScope['type'] })}
              className="rounded border border-border bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {/* i18n-ignore-start: scope-type tokens are API enum names, shown verbatim */}
              <option value="category">category</option>
              <option value="capability">capability</option>
              <option value="addon">addon</option>
              <option value="device">device</option>
              {/* i18n-ignore-end */}
            </select>

            {row.type === 'device' ? (
              <div className="min-w-[200px] flex-1 space-y-1.5">
                <DeviceSelectorPicker
                  dense
                  value={row.selector}
                  onChange={(selector) => update(idx, { selector })}
                  clampToDeviceIds={parentDeviceClamp}
                />
                <label className="flex flex-wrap items-center gap-1.5 text-[10px] text-foreground-subtle">
                  {t('uiLibrary.scopePicker.linkedDevices', 'Linked devices')}
                  <select
                    value={row.includeLinked === undefined ? '' : row.includeLinked ? 'yes' : 'no'}
                    onChange={(e) =>
                      update(idx, { includeLinked: INCLUDE_LINKED_VALUES[e.target.value] })
                    }
                    className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    {/* Absence is a real, distinct state — never collapse it
                        into "no", which would revoke accessory access. */}
                    <option value="">
                      {t('uiLibrary.scopePicker.automatic', 'Automatic (view inherits)')}
                    </option>
                    <option value="yes">
                      {t('uiLibrary.scopePicker.alwaysIncluded', 'Always included')}
                    </option>
                    <option value="no">
                      {t('uiLibrary.scopePicker.neverIncluded', 'Never included')}
                    </option>
                  </select>
                </label>
              </div>
            ) : (
              <select
                value={row.target}
                onChange={(e) => update(idx, { target: e.target.value })}
                className="flex-1 min-w-[160px] rounded border border-border bg-background px-2 py-1 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="">
                  {t('uiLibrary.scopePicker.pickType', '— pick {{type}} —', { type: row.type })}
                </option>
                {clampedSingleTargets(row.type, clampToParent, addonChoices, capChoices).map(
                  (t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ),
                )}
              </select>
            )}

            <div className="flex items-center gap-1">
              {ACCESS_OPTIONS.map(
                ({ value: access, labelKey, labelFallback, icon: Icon, hintKey, hintFallback }) => {
                  const label = t(labelKey, labelFallback)
                  const hint = t(hintKey, hintFallback)
                  const checked = row.access.includes(access)
                  const disabled =
                    clampToParent != null && !allowedAccess.includes(access) && !checked
                  return (
                    <label
                      key={access}
                      title={
                        disabled
                          ? t(
                              'uiLibrary.scopePicker.notGranted',
                              '{{hint}} — not granted by your scope',
                              {
                                hint,
                              },
                            )
                          : hint
                      }
                      className={`inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] cursor-pointer transition-colors ${
                        checked
                          ? 'bg-primary/15 text-primary font-medium'
                          : 'text-foreground-subtle hover:bg-foreground-subtle/10'
                      } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={(e) => {
                          const nextSet = new Set<ScopeAccess>(row.access)
                          if (e.target.checked) nextSet.add(access)
                          else nextSet.delete(access)
                          update(idx, { access: [...nextSet] })
                        }}
                        className="sr-only"
                      />
                      <Icon className="h-3 w-3" />
                      {label}
                    </label>
                  )
                },
              )}
            </div>

            <button
              type="button"
              onClick={() => removeAt(idx)}
              className="rounded p-1 text-foreground-subtle hover:bg-danger/10 hover:text-danger transition-colors"
              title={t('uiLibrary.scopePicker.removeScope', 'Remove scope')}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}

      <button
        type="button"
        onClick={append}
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] text-foreground-subtle hover:text-foreground hover:bg-foreground-subtle/10 transition-colors"
      >
        <Plus className="h-3 w-3" />
        {t('uiLibrary.scopePicker.addScope', 'Add scope')}
      </button>
    </div>
  )
}

/**
 * Validation helper. The wire schema (`TokenScopeSchema`) requires every
 * scope to carry a usable target and `access.length >= 1`; a v3 device
 * selector additionally requires a non-empty list for every kind except
 * `all`. Use this before passing the picker output to a mutate call so the
 * user sees a clean inline error instead of a tRPC ZodError.
 *
 * An EMPTY selector list is rejected rather than silently treated as "all":
 * the schema's `.min(1)` would reject it server-side anyway, and the failure
 * mode of guessing wrong here is granting the whole fleet.
 */
export function validateScopes(
  scopes: readonly TokenScope[],
  t: UiTextFn = defaultUiText,
): string | null {
  for (const s of scopes) {
    if (s.type === 'device') {
      const problem = validateSelector(s.selector, t)
      if (problem !== null) return problem
    } else {
      if (s.target.trim().length === 0) {
        return t('uiLibrary.scopePicker.pickTarget', 'Scope {{type}}: pick a target', {
          type: s.type,
        })
      }
    }
    if (s.access.length === 0) {
      const targetDesc = s.type === 'device' ? describeDeviceSelector(s.selector) : s.target
      return t(
        'uiLibrary.scopePicker.pickAccess',
        'Scope {{type}}:{{target}}: pick at least one access',
        { type: s.type, target: targetDesc },
      )
    }
  }
  return null
}

/** Non-empty check per selector kind. `all` selects the fleet and is always
 *  complete. */
function validateSelector(selector: DeviceSelector, t: UiTextFn): string | null {
  switch (selector.kind) {
    case 'all':
      return null
    case 'ids':
      return selector.ids.length === 0
        ? t('uiLibrary.scopePicker.pickDevice', 'Scope device: pick at least one device')
        : null
    case 'types':
      return selector.types.length === 0
        ? t('uiLibrary.scopePicker.pickDeviceType', 'Scope device: pick at least one device type')
        : null
    case 'locations':
      return selector.locations.length === 0
        ? t('uiLibrary.scopePicker.pickRoom', 'Scope device: pick at least one room')
        : null
  }
}
