/**
 * Real pickers for the notification-rule conditions that have an authoritative
 * catalogue but were still free-text (spec D5, Phase 3):
 *
 *   zones / zonesExclude → the `zones` cap, names shown, IDS stored
 *   identities           → the face gallery, display names (the engine matches
 *                          the collapsed label, i.e. the identity name)
 *   eventTypeTokens      → `pipelineAnalytics.listEventKinds` per device
 *   plates               → known plate texts as one-click suggestions
 *
 * Every picker keeps the free-text escape hatch: a value the catalogue does
 * not know renders as a removable chip and can still be typed — opening an
 * existing rule can never silently drop a value.
 *
 * Zones and event kinds are PER DEVICE, so both pickers read the rule's
 * selected cameras and fan one query out per device (`useQueries` + the
 * vanilla trpc client — the NodeAddonsSettingsPanel pattern). With no camera
 * selected there is nothing authoritative to list; the field says so and
 * falls back to free text.
 */
import {
  useFaceGalleryListIdentities,
  usePlateGalleryListPlates,
  usePlateGalleryListVehicles,
  useSystem,
} from '@camstack/ui-library'
import { useQueries } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import type { RuleCameraOption } from './notification-condition-fields'
import { useTranslation } from 'react-i18next'

export interface PickOption {
  readonly value: string
  readonly label: string
  /** Secondary text (e.g. the camera the zone belongs to). */
  readonly hint?: string
}

/** Zones of the rule's selected cameras — `{id, name}` per device. */
export function useZoneOptions(
  deviceIds: readonly number[],
  cameras: readonly RuleCameraOption[],
): ZoneOptions {
  const trpcClient = useSystem().trpcClient
  const results = useQueries({
    queries: deviceIds.map((deviceId) => ({
      queryKey: [['nc-pickers', 'zones'], { deviceId }],
      staleTime: 30_000,
      queryFn: async (): Promise<{ deviceId: number; zones: { id: string; name: string }[] }> => {
        const zones = await trpcClient.zones.listZones.query({ deviceId })
        return { deviceId, zones: zones.map((z) => ({ id: z.id, name: z.name })) }
      },
    })),
  })
  return useMemo(() => {
    const options: PickOption[] = []
    const seen = new Set<string>()
    for (const r of results) {
      if (!r.data) continue
      const cameraName = cameras.find((c) => c.id === r.data.deviceId)?.name
      for (const zone of r.data.zones) {
        if (seen.has(zone.id)) continue
        seen.add(zone.id)
        options.push({
          value: zone.id,
          label: zone.name,
          ...(cameraName === undefined ? {} : { hint: cameraName }),
        })
      }
    }
    return {
      options,
      loading: results.some((r) => r.isLoading),
      failed: results.some((r) => r.isError),
    }
  }, [results, cameras])
}

/** The zones of the rule's cameras — and whether any camera's read FAILED (D315). */
export interface ZoneOptions {
  readonly options: readonly PickOption[]
  readonly loading: boolean
  /** At least one camera did not answer: its zones are unknown, never "deleted". */
  readonly failed: boolean
}

/** Union of event kinds across the rule's selected cameras. */
export function useEventKindOptions(deviceIds: readonly number[]): {
  options: readonly PickOption[]
  loading: boolean
} {
  const trpcClient = useSystem().trpcClient
  const results = useQueries({
    queries: deviceIds.map((deviceId) => ({
      queryKey: [['nc-pickers', 'event-kinds'], { deviceId }],
      staleTime: 60_000,
      queryFn: async (): Promise<{ kind: string; label: string }[]> => {
        const kinds = await trpcClient.pipelineAnalytics.listEventKinds.query({ deviceId })
        return kinds.map((k) => ({ kind: k.kind, label: k.label }))
      },
    })),
  })
  return useMemo(() => {
    const byKind = new Map<string, string>()
    for (const r of results) {
      for (const k of r.data ?? []) if (!byKind.has(k.kind)) byKind.set(k.kind, k.label)
    }
    const options = [...byKind.entries()].map(([value, label]) => ({ value, label }))
    options.sort((a, b) => a.label.localeCompare(b.label))
    return { options, loading: results.some((r) => r.isLoading) }
  }, [results])
}

/**
 * Face-gallery identities — the VALUE is the gallery id, the LABEL is the name.
 *
 * That split is the whole point of the picker. The engine matches ids, because
 * a rule authored on a display name went silently dark when the operator fixed
 * the spelling; the operator has never seen an id and never should. A stored
 * value the gallery cannot name still renders (as a chip) rather than
 * disappearing — an unfireable rule must not look correct.
 */
export function useIdentityOptions(): IdentityOptions {
  const query = useFaceGalleryListIdentities()
  return useMemo(
    () => ({
      options: (query.data ?? []).map((i) => ({ value: i.id, label: i.name })),
      loading: query.isLoading,
      failed: query.isError === true,
    }),
    [query.data, query.isLoading, query.isError],
  )
}

/** The face gallery as a picker reads it — and whether it ANSWERED (D315). */
export interface IdentityOptions {
  readonly options: readonly PickOption[]
  readonly loading: boolean
  /** The gallery read failed: a stored id is then unknown, never "removed". */
  readonly failed: boolean
}

/**
 * Known plates, for one-click add on the plate matcher — the NAMED vehicles
 * first, then every plate the pipeline has read.
 *
 * A vehicle's name is what the pipeline stamps once the gallery claims a read
 * (`PlateRecognizer.resolveLabel`), so it is what a rule has to be authored
 * against; the raw reads are the escape hatch for a plate nobody has named yet.
 * Both are offered because both are things the label can actually be.
 */
export function usePlateSuggestions(): readonly string[] {
  const plates = usePlateGalleryListPlates({ limit: 200 })
  const vehicles = usePlateGalleryListVehicles()
  return useMemo(() => {
    const named = new Set<string>()
    for (const v of vehicles.data ?? []) if (v.name.trim().length > 0) named.add(v.name)
    const texts = new Set<string>()
    for (const p of plates.data ?? []) if (p.text.trim().length > 0) texts.add(p.text)
    return [...[...named].sort(), ...[...texts].sort()]
  }, [plates.data, vehicles.data])
}

// ── The generic option-list widget ──────────────────────────────────

interface OptionListFieldProps {
  readonly options: readonly PickOption[]
  readonly value: readonly string[]
  readonly onChange: (next: string[]) => void
  readonly loading?: boolean
  /** Shown when there are no options to offer (e.g. no camera selected). */
  readonly emptyHint: string
  /** Placeholder for the free-text escape hatch. */
  readonly placeholder: string
  /**
   * Drop the free-text escape hatch entirely.
   *
   * For catalogues that are AUTHORITATIVE — a zone id is minted by the zone
   * editor and exists or does not, so a typed one matches nothing and the rule
   * silently never fires. Free text is right where the catalogue is only a
   * convenience (an identity the gallery has not seen yet); it is wrong where
   * the catalogue IS the set of legal values.
   *
   * Values already stored that the catalogue does not know still render as
   * removable chips — hiding them would make an unfireable rule look correct.
   */
  readonly noFreeText?: boolean
}

/**
 * Checkbox list over a real catalogue + the free-text escape hatch. Selected
 * values the catalogue does not know render as removable chips — never
 * silently dropped.
 */
export function OptionListField({
  options,
  value,
  onChange,
  loading,
  emptyHint,
  placeholder,
  noFreeText = false,
}: OptionListFieldProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const known = useMemo(() => new Set(options.map((o) => o.value)), [options])
  const selected = useMemo(() => new Set(value), [value])
  const custom = value.filter((v) => !known.has(v))

  const toggle = (v: string): void => {
    onChange(selected.has(v) ? value.filter((x) => x !== v) : [...value, v])
  }
  const addDraft = (): void => {
    const v = draft.trim()
    if (v.length === 0 || value.includes(v)) return
    onChange([...value, v])
    setDraft('')
  }

  return (
    <div className="mt-1 space-y-1.5">
      {custom.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {custom.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onChange(value.filter((x) => x !== v))}
              className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground hover:bg-surface-hover"
              title={t(
                'system.notificationRulePickers.customValueClickToRemove',
                'Custom value — click to remove',
              )}
            >
              {v} ×
            </button>
          ))}
        </div>
      )}
      {options.length > 0 ? (
        <div className="max-h-40 overflow-y-auto rounded-md border border-border divide-y divide-border">
          {options.map((o) => (
            <label
              key={o.value}
              className="flex items-center gap-2.5 px-3 py-1.5 text-xs text-foreground cursor-pointer hover:bg-surface-hover"
            >
              <input
                type="checkbox"
                checked={selected.has(o.value)}
                onChange={() => toggle(o.value)}
                className="accent-primary"
              />
              <span className="flex-1 truncate">{o.label}</span>
              {o.hint !== undefined && (
                <span className="text-[10px] text-foreground-subtle">{o.hint}</span>
              )}
            </label>
          ))}
        </div>
      ) : (
        <p className="text-[10px] text-foreground-subtle">
          {loading === true ? t('common.loading', 'Loading…') : emptyHint}
        </p>
      )}
      {!noFreeText && (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addDraft()
            }
          }}
          placeholder={placeholder}
          className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-foreground-subtle"
        />
      )}
    </div>
  )
}
