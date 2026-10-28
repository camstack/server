/**
 * One ASSOCIATION slot (D648): the devices a host lists, edited as a device
 * multiselect.
 *
 * - The saved value is the owner's store, read by `listSlots`. The draft is
 *   local until Save, and Save is `setSlot` — the owner validates and writes
 *   through its existing path, so a refusal comes back BY NAME and is shown.
 * - Candidates (`listCandidates`) are fetched only while editing. Suggestions
 *   are chips the operator must click to add; nothing is picked on its own
 *   (D356).
 * - Every saved source shows its health; a missing or unavailable one is
 *   shown with its reason and never silently dropped from the draft.
 * - A gate owned by ANOTHER authority (e.g. a wrapper's binding; no slot
 *   reports one today) is shown read-only, naming that authority (D62).
 * - A slot whose value carries a tracked-event opt-in (`linked-devices`,
 *   D655) gets one toggle per LINKED device — the picks, what the owner links
 *   by structure (`impliedSources`: tree children, never a container, D356)
 *   and any stored opt-in no longer linked, so each can be removed — saved
 *   with the picks, whole.
 */
import { useState, type JSX, useRef } from 'react'
import { useSearchFieldHotkey } from '../../hotkeys/use-search-field-hotkey'
import { Plus, X } from 'lucide-react'
import { EXTENSION_SLOTS, type ExtensionSlotSource, type ExtensionSlotState } from '@camstack/types'
import {
  useDeviceExtensionListCandidates,
  useDeviceExtensionSetSlot,
} from '../../generated/system-hooks.js'
import { useUiText, type UiTextFn } from '../../contexts/ui-text.js'
import { Badge } from '../../primitives/badge.js'
import { Button } from '../../primitives/button.js'
import {
  isDirty,
  isTrackedDirty,
  pendingSuggestions,
  searchCandidates,
  slotWriteValue,
  togglePick,
  type TrackedOption,
  type TrackedOptionOrigin,
  toggleTracked,
  trackedOptInOf,
  trackedOptions,
  untrackUnpicked,
} from './extensions-view-state.js'

function healthLabel(health: ExtensionSlotSource['health'], t: UiTextFn): string {
  switch (health) {
    case 'ok':
      return t('uiLibrary.associationSlotCard.healthOk', 'OK')
    case 'missing':
      return t('uiLibrary.associationSlotCard.healthMissing', 'Missing')
    case 'foreign':
      return t('uiLibrary.associationSlotCard.healthForeign', 'Other owner')
    case 'unavailable':
      return t('uiLibrary.associationSlotCard.healthUnavailable', 'Not a valid source')
  }
}

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info'

const HEALTH_VARIANT: Readonly<Record<ExtensionSlotSource['health'], BadgeVariant>> = {
  ok: 'success',
  missing: 'danger',
  foreign: 'warning',
  unavailable: 'warning',
}

export interface SlotSourceListProps {
  readonly sources: readonly ExtensionSlotSource[]
  /** The tracked-event opt-in, when the slot carries one. */
  readonly tracked?: readonly number[] | undefined
}

/** The saved sources, each with its health — a bad one is shown, never hidden. */
export function SlotSourceList({ sources, tracked }: SlotSourceListProps): JSX.Element | null {
  const t = useUiText()
  if (sources.length === 0) {
    return (
      <p className="text-[11px] text-foreground-subtle italic">
        {t('uiLibrary.associationSlotCard.noDevicesPicked', 'No devices picked.')}
      </p>
    )
  }
  return (
    <ul className="flex flex-col gap-1">
      {sources.map((s) => (
        <li key={s.deviceId} className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-foreground">
            {s.name ??
              t('uiLibrary.associationSlotCard.deviceN', 'Device {{id}}', { id: s.deviceId })}
          </span>
          <Badge variant={HEALTH_VARIANT[s.health]}>{healthLabel(s.health, t)}</Badge>
          {tracked?.includes(s.deviceId) === true && (
            <Badge variant="info">
              {t('uiLibrary.associationSlotCard.trackedEvents', 'Tracked events')}
            </Badge>
          )}
          {s.detail !== undefined && (
            <span className="text-[10px] text-foreground-subtle">{s.detail}</span>
          )}
        </li>
      ))}
    </ul>
  )
}

export interface AssociationSlotCardProps {
  readonly deviceId: number
  readonly row: ExtensionSlotState
  readonly onSaved: () => void
  /**
   * No Edit affordance — for a caller whose viewer cannot write `setSlot`
   * (`auth: 'admin'`), never a client-side echo of a server refusal. The
   * saved picks are still shown in full (D356: a link is only what the
   * operator picked, and hiding it from a non-admin would read as gone).
   */
  readonly readOnly?: boolean
}

export interface ActivationLineProps {
  readonly row: ExtensionSlotState
}

function ActivationLine({ row }: ActivationLineProps) {
  const t = useUiText()
  const activation = row.activation
  if (activation === null) return null
  const variant: BadgeVariant =
    activation.state === 'active'
      ? 'success'
      : activation.state === 'inactive'
        ? 'warning'
        : 'default'
  const label =
    activation.state === 'active'
      ? t('uiLibrary.associationSlotCard.active', 'Active')
      : activation.state === 'inactive'
        ? t('uiLibrary.associationSlotCard.inactive', 'Inactive')
        : t('uiLibrary.associationSlotCard.unknown', 'Unknown')
  return (
    <div className="flex flex-wrap items-center gap-2 text-[10px] text-foreground-subtle">
      <Badge variant={variant}>{label}</Badge>
      <span>
        {t('uiLibrary.associationSlotCard.setBy', 'set by {{authority}}', {
          authority: activation.authority,
        })}
      </span>
      {activation.detail !== undefined && <span>{activation.detail}</span>}
    </div>
  )
}

export interface ImpliedSourceListProps {
  readonly sources: readonly ExtensionSlotSource[]
  readonly tracked?: readonly number[] | undefined
}

/**
 * What the owner links by structure — tree children, a picked container's
 * child (D356). Shown, never editable as a pick: removing one is not the
 * editor's to do.
 */
function ImpliedSourceList({ sources, tracked }: ImpliedSourceListProps) {
  const t = useUiText()
  if (sources.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] text-foreground-subtle">
        {t('uiLibrary.associationSlotCard.alwaysLinked', 'Always linked (device tree):')}
      </span>
      <ul
        aria-label={t('uiLibrary.associationSlotCard.alwaysLinkedAria', 'Always linked')}
        className="flex flex-col gap-1"
      >
        {sources.map((s) => (
          <li key={s.deviceId} className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="text-foreground">
              {s.name ??
                t('uiLibrary.associationSlotCard.deviceN', 'Device {{id}}', { id: s.deviceId })}
            </span>
            {tracked?.includes(s.deviceId) === true && (
              <Badge variant="info">
                {t('uiLibrary.associationSlotCard.trackedEvents', 'Tracked events')}
              </Badge>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function originNote(origin: TrackedOptionOrigin, t: UiTextFn): string | null {
  switch (origin) {
    case 'pick':
      return null
    case 'implied':
      return t('uiLibrary.associationSlotCard.originImplied', 'always linked')
    case 'not-linked':
      return t(
        'uiLibrary.associationSlotCard.originNotLinked',
        'not linked any more — untick to remove',
      )
  }
}

export interface TrackedTogglesProps {
  readonly options: readonly TrackedOption[]
  readonly tracked: readonly number[]
  readonly nameOf: (id: number) => string
  readonly onToggle: (id: number) => void
}

/** One opt-in toggle per linked device: does it produce tracked events here? */
function TrackedToggles({ options, tracked, nameOf, onToggle }: TrackedTogglesProps) {
  const t = useUiText()
  if (options.length === 0) return null
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-[10px] text-foreground-subtle">
        {t(
          'uiLibrary.associationSlotCard.produceTracked',
          'Produce tracked events on this camera (opt-in):',
        )}
      </legend>
      {options.map(({ deviceId: id, origin }) => (
        <label key={id} className="flex items-center gap-2 text-[11px] text-foreground">
          <input
            type="checkbox"
            aria-label={t(
              'uiLibrary.associationSlotCard.trackedFrom',
              'Tracked events from {{name}}',
              {
                name: nameOf(id),
              },
            )}
            checked={tracked.includes(id)}
            onChange={() => onToggle(id)}
          />
          {nameOf(id)}
          {originNote(origin, t) !== null && (
            <span className="text-[10px] text-foreground-subtle">· {originNote(origin, t)}</span>
          )}
        </label>
      ))}
    </fieldset>
  )
}

export function AssociationSlotCard({
  deviceId,
  row,
  onSaved,
  readOnly = false,
}: AssociationSlotCardProps): JSX.Element | null {
  const searchFieldRef = useRef<HTMLInputElement>(null)
  useSearchFieldHotkey(searchFieldRef)
  const t = useUiText()
  const descriptor = EXTENSION_SLOTS[row.slot].descriptor
  const saved = row.value.deviceIds
  const savedTracked = trackedOptInOf(row.value)
  const implied = row.impliedSources ?? []
  const impliedIds = implied.map((s) => s.deviceId)
  const invalidPicks = row.sources.filter((s) => s.health === 'unavailable').map((s) => s.deviceId)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<readonly number[]>(saved)
  const [draftTracked, setDraftTracked] = useState<readonly number[]>(savedTracked ?? [])
  const [search, setSearch] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)
  const candidatesQuery = useDeviceExtensionListCandidates(
    { deviceId, slotRef: row.slotRef },
    { enabled: editing },
  )
  const setSlot = useDeviceExtensionSetSlot()
  const candidates = candidatesQuery.data?.candidates ?? []
  const nameOf = (id: number): string =>
    candidates.find((c) => c.deviceId === id)?.name ??
    row.sources.find((s) => s.deviceId === id)?.name ??
    implied.find((s) => s.deviceId === id)?.name ??
    t('uiLibrary.associationSlotCard.deviceN', 'Device {{id}}', { id })
  const removePick = (id: number): void => {
    setDraft(togglePick(draft, id, descriptor.cardinality))
    setDraftTracked(untrackUnpicked(draftTracked, id, impliedIds))
  }

  const startEditing = (): void => {
    setDraft(saved)
    setDraftTracked(savedTracked ?? [])
    setRefusal(null)
    setEditing(true)
  }

  const save = async (): Promise<void> => {
    setRefusal(null)
    try {
      await setSlot.mutateAsync({
        deviceId,
        slotRef: row.slotRef,
        value: slotWriteValue(
          row.value,
          draft,
          savedTracked === undefined ? undefined : draftTracked,
        ),
      })
      setEditing(false)
      // The panel re-reads its own `listSlots`; since D655 no other surface
      // on the page shows these stores.
      onSaved()
    } catch (err: unknown) {
      setRefusal(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div
      role="group"
      aria-label={descriptor.label}
      className="flex flex-col gap-2 rounded-md border border-border/40 bg-surface-elevated/30 p-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-semibold text-foreground">{descriptor.label}</span>
          <span className="text-[10px] text-foreground-subtle">{descriptor.description}</span>
          <span className="text-[10px] text-foreground-subtle">
            {t('uiLibrary.associationSlotCard.storedIn', 'Stored in {{authority}}', {
              authority: row.authority,
            })}
          </span>
        </div>
        {!editing && !readOnly && (
          <Button variant="outline" size="sm" onClick={startEditing}>
            {t('uiLibrary.associationSlotCard.edit', 'Edit')}
          </Button>
        )}
      </div>
      <ActivationLine row={row} />

      {!editing && <SlotSourceList sources={row.sources} tracked={savedTracked} />}
      {!editing && <ImpliedSourceList sources={implied} tracked={savedTracked} />}

      {editing && (
        <div className="flex flex-col gap-2">
          <ul
            aria-label={t('uiLibrary.associationSlotCard.pickedDevices', 'Picked devices')}
            className="flex flex-wrap gap-1.5"
          >
            {draft.map((id) => (
              <li key={id}>
                <button
                  type="button"
                  aria-label={t('uiLibrary.associationSlotCard.removeN', 'Remove {{name}}', {
                    name: nameOf(id),
                  })}
                  onClick={() => removePick(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] text-foreground"
                >
                  {nameOf(id)}
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>

          {candidatesQuery.status === 'pending' && (
            <p role="status" className="text-[10px] text-foreground-subtle">
              {t('uiLibrary.associationSlotCard.loadingCandidates', 'Loading candidates…')}
            </p>
          )}
          {candidatesQuery.status === 'error' && (
            <p role="alert" className="text-[10px] text-danger">
              {t(
                'uiLibrary.associationSlotCard.candidatesError',
                'Candidates could not be read: {{message}}',
                { message: candidatesQuery.error.message },
              )}
            </p>
          )}

          {pendingSuggestions(candidates, draft).length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-[10px] text-foreground-subtle">
                {t(
                  'uiLibrary.associationSlotCard.suggested',
                  'Suggested — added only if you click them:',
                )}
              </span>
              <ul
                aria-label={t('uiLibrary.associationSlotCard.suggestions', 'Suggestions')}
                className="flex flex-wrap gap-1.5"
              >
                {pendingSuggestions(candidates, draft).map((c) => (
                  <li key={c.deviceId}>
                    <button
                      type="button"
                      aria-label={t('uiLibrary.associationSlotCard.addN', 'Add {{name}}', {
                        name: c.name,
                      })}
                      onClick={() =>
                        setDraft(togglePick(draft, c.deviceId, descriptor.cardinality))
                      }
                      className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-foreground-muted"
                    >
                      <Plus className="h-3 w-3" />
                      {c.name}
                      {c.reason !== null && (
                        <span className="text-foreground-subtle">· {c.reason}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <input
            ref={searchFieldRef}
            type="search"
            aria-label={t('uiLibrary.associationSlotCard.searchDevices', 'Search devices')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t(
              'uiLibrary.associationSlotCard.searchPlaceholder',
              'Search devices by name, location or type',
            )}
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-primary"
          />
          {searchCandidates(candidates, draft, search).length > 0 && (
            <ul
              aria-label={t('uiLibrary.associationSlotCard.searchResults', 'Search results')}
              className="flex max-h-40 flex-col gap-0.5 overflow-y-auto"
            >
              {searchCandidates(candidates, draft, search).map((c) => (
                <li key={c.deviceId}>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(togglePick(draft, c.deviceId, descriptor.cardinality))
                      setSearch('')
                    }}
                    className="w-full rounded px-2 py-1 text-left text-[11px] text-foreground hover:bg-surface-hover"
                  >
                    {c.name}
                    {c.parentName !== null && (
                      <span className="ml-1 text-foreground-subtle">
                        {t('uiLibrary.associationSlotCard.inParent', 'in {{name}}', {
                          name: c.parentName,
                        })}
                      </span>
                    )}
                    {c.location !== null && (
                      <span className="ml-1 text-foreground-subtle">· {c.location}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {savedTracked !== undefined && (
            <TrackedToggles
              options={trackedOptions({
                picks: draft,
                invalidPicks,
                implied: impliedIds,
                tracked: draftTracked,
              })}
              tracked={draftTracked}
              nameOf={nameOf}
              onToggle={(id) => setDraftTracked(toggleTracked(draftTracked, id))}
            />
          )}

          {refusal !== null && (
            <p role="alert" className="text-[11px] text-danger break-words">
              {t('uiLibrary.associationSlotCard.notSaved', 'Not saved: {{reason}}', {
                reason: refusal,
              })}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              {t('uiLibrary.associationSlotCard.cancel', 'Cancel')}
            </Button>
            <Button
              size="sm"
              disabled={
                !(
                  isDirty(saved, draft) ||
                  (savedTracked !== undefined && isTrackedDirty(savedTracked, draftTracked))
                ) || setSlot.isPending
              }
              onClick={() => void save()}
            >
              {t('uiLibrary.associationSlotCard.save', 'Save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
