/**
 * NodeDetailPanel → Capabilities sub-tab (settings-redesign Phase 10).
 *
 * Shows the capability bindings that apply when the addon stack on
 * this node runs. Data comes from:
 *  - `nodes.topology` (already in the parent NodeDetailPanel) for the
 *    list of addons + declared capabilities per addon
 *  - `pipelineOrchestrator.getCapabilityBindings({ nodeId })` for the
 *    currently active binding per cap
 *
 * Binding edits are ONE local draft: Save writes every changed binding, Discard
 * drops them (planning#675). A binding is written via
 * `pipelineOrchestrator.setCapabilityBinding({ nodeId, capName, addonId })`
 * which the orchestrator propagates via the `capability.binding-changed`
 * event — the target node's kernel picks it up and swaps its local
 * preferred-provider registry without restarting.
 */
import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import {
  DataTable,
  FormSaveBar,
  TABLE_SCROLL_MAX_H,
  usePipelineOrchestratorGetCapabilityBindings,
  usePipelineOrchestratorSetCapabilityBinding,
  type DataColumn,
  Select,
} from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

/** One row: a capability declared on this node, and every addon that provides it. */
interface CapBindingRow {
  readonly capName: string
  readonly providers: readonly string[]
}
interface NodeAddon {
  readonly id: string
  readonly capabilities: readonly string[]
  readonly status: string
}

interface NodeDetailCapabilitiesTabProps {
  readonly nodeId: string
  readonly addons: readonly NodeAddon[]
}

export function NodeDetailCapabilitiesTab({ nodeId, addons }: NodeDetailCapabilitiesTabProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const { data: bindings, isLoading: isBindingsLoading } =
    usePipelineOrchestratorGetCapabilityBindings({ nodeId })

  // Build the set of capabilities that have at least one provider
  // on this node. Capabilities with no provider installed are skipped
  // — nothing to bind to.
  const capRows = useMemo(() => {
    const capToProviders = new Map<string, string[]>()
    for (const addon of addons) {
      for (const cap of addon.capabilities) {
        const list = capToProviders.get(cap) ?? []
        list.push(addon.id)
        capToProviders.set(cap, list)
      }
    }
    return [...capToProviders.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([capName, providers]) => ({ capName, providers }))
  }, [addons])

  const setBindingMutation = usePipelineOrchestratorSetCapabilityBinding({
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [['pipelineOrchestrator', 'getCapabilityBindings']],
      })
    },
  })

  // capName -> addonId picked but not yet saved.
  const [draft, setDraft] = useState<Readonly<Record<string, string>>>({})
  const [saveError, setSaveError] = useState<string | null>(null)
  const changes = capRows.filter((r) => {
    const picked = draft[r.capName]
    // Against the STORED binding, not the displayed default: choosing the default while nothing
    // is bound writes the explicit binding, as it did before the draft.
    return picked !== undefined && picked !== bindings?.[r.capName]
  })
  const saveDraft = (): void => {
    setSaveError(null)
    void Promise.all(
      changes.map((r) =>
        setBindingMutation.mutateAsync({
          nodeId,
          capName: r.capName,
          addonId: draft[r.capName] ?? '',
        }),
      ),
    )
      .then(() => setDraft({}))
      .catch((err: unknown) => setSaveError(err instanceof Error ? err.message : String(err)))
  }

  if (capRows.length === 0) {
    return (
      <div className="py-4 text-xs text-muted-foreground text-center">
        {t(
          'cluster.nodeDetailCapabilitiesTab.noCapabilitiesOnThisNode',
          'No capabilities on this node',
        )}
      </div>
    )
  }

  const columns: readonly DataColumn<CapBindingRow>[] = [
    {
      mobile: 'primary',
      key: 'capName',
      header: t('cluster.nodeDetailCapabilitiesTab.capability', 'Capability'),
      width: 'w-1/2',
      sortValue: (r) => r.capName,
      render: (r) => <span className="font-medium">{r.capName}</span>,
    },
    {
      mobile: 'detail',
      key: 'provider',
      header: t('cluster.nodeDetailCapabilitiesTab.boundProvider', 'Bound provider'),
      // Deliberately NOT sortable (no `sortValue`). The cell is a live
      // `<select>`: the value it shows is a choice the operator is in the
      // middle of making, so ordering rows by it makes a row jump out from
      // under the cursor the moment the binding is changed. A sort must not
      // fight the edit it sits next to. This note is for whoever next thinks of
      // adding the sort — it is not shown on screen, because a header that does
      // not click already tells the operator everything they need.
      render: (r) => {
        const currentExplicit = bindings?.[r.capName]
        const resolved = draft[r.capName] ?? currentExplicit ?? r.providers[0] ?? ''
        // `[CLUSTER-CAPS-EDITABLE]` — render a dropdown even for
        // single-provider caps, pre-selected and disabled. Operators
        // previously saw only static text and thought the UI wasn't
        // editable at all. Showing the dropdown signals "there is a
        // choice to make once more providers install", and the single
        // row becomes a live select the moment a sibling addon
        // registers the same cap.
        const isSingleProvider = r.providers.length === 1
        return (
          <Select
            value={resolved}
            onChange={(e) => {
              const addonId = e.target.value
              setDraft((prev) => ({ ...prev, [r.capName]: addonId }))
            }}
            disabled={isSingleProvider || setBindingMutation.isPending || isBindingsLoading}
            className="w-full"
            title={
              isSingleProvider
                ? t(
                    'cluster.nodeDetailCapabilitiesTab.onlyOneProviderInstalledChoice',
                    'Only one provider installed — choice becomes available once a second addon registers this capability',
                  )
                : undefined
            }
          >
            {r.providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        )
      },
    },
  ]

  return (
    // The standard sortable `DataTable`: same bordered, internally scrolling
    // shell with a pinned header — a node can bind dozens of caps and the
    // provider column is meaningless once the header scrolls off.
    <div className="space-y-2">
      <DataTable<CapBindingRow>
        columns={columns}
        rows={capRows}
        rowKey={(r) => r.capName}
        minWidthPx={520}
        maxBodyHeight={TABLE_SCROLL_MAX_H}
      />
      {saveError !== null && (
        <p role="alert" className="text-xs text-danger">
          {saveError}
        </p>
      )}
      <FormSaveBar
        pendingCount={changes.length}
        saving={setBindingMutation.isPending}
        onSave={saveDraft}
        onDiscard={() => {
          setDraft({})
          setSaveError(null)
        }}
      />
    </div>
  )
}
