/**
 * The system family's node and package pickers (D637): the device picker's UX
 * (search, groups, compact chips) over a different source. No free text: a
 * node id is minted by the cluster and a package name by the registry, and a
 * typed value that does not exist is a rule that can never fire.
 *
 * What a stored id missing from the list reads as is `scope-pickers.helpers.ts`
 * (D315) and `orphanDeviceLabel` (the words); every one stays a removable chip
 * (D49). A node directory that is not `complete` says so under the picker,
 * because it may lack offline nodes the hub does know.
 */
import { useSystem } from '@camstack/ui-library'
import { useQuery } from '@tanstack/react-query'
import { DevicePicker } from './DevicePicker'
import type { PickerGroup } from './device-picker-model'
import { nodeScopeState, packageScopeState } from './scope-pickers.helpers'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

/**
 * Not `['nc-pickers', 'nodes' | 'addon-packages']`: those keys cached the
 * option lists these pickers replaced (a `nodes.topology` read), and a stale
 * build may still hold them — one key must never hold two shapes.
 */
const NODE_DIRECTORY_QUERY_KEY = ['nc-pickers', 'node-directory'] as const
const PACKAGE_LIST_QUERY_KEY = ['nc-pickers', 'package-list'] as const
const SCOPE_PICKER_STALE_MS = 60_000

const NODE_ROLE_TITLE: Readonly<Record<string, string>> = {
  get hub() {
    return i18n.t('system.scopePickers.roleHub')
  },
  get agent() {
    return i18n.t('system.scopePickers.roleAgents')
  },
}
const PACKAGE_KIND_TITLE: Readonly<Record<string, string>> = {
  get server() {
    return i18n.t('system.scopePickers.pkgServer')
  },
  get framework() {
    return i18n.t('system.scopePickers.pkgFramework')
  },
  get wrapper() {
    return i18n.t('system.scopePickers.pkgWrapper')
  },
  get addon() {
    return i18n.t('system.scopePickers.pkgAddons')
  },
}

function nodeGroupTitle(group: PickerGroup<string>): string {
  const role = NODE_ROLE_TITLE[group.type ?? ''] ?? i18n.t('system.scopePickers.roleNodes')
  return group.location === 'offline' ? i18n.t('system.scopePickers.offlineSuffix', { role }) : role
}

function packageGroupTitle(group: PickerGroup<string>): string {
  return PACKAGE_KIND_TITLE[group.type ?? ''] ?? i18n.t('system.scopePickers.pkgPackages')
}

export interface ScopePickerProps {
  readonly value: readonly string[]
  readonly onChange: (next: string[]) => void
  readonly testId?: string
}

/**
 * Multi-select node filter for notification system-event scope (chips +
 * searchable list). Not the library's `NodePicker` pill bar — that one is
 * single-select for "which node am I looking at". Named apart so the two
 * never share a look under one export.
 */
export function NodeScopePicker({ value, onChange, testId }: ScopePickerProps) {
  const { t } = useTranslation()
  const trpcClient = useSystem().trpcClient
  const query = useQuery({
    queryKey: NODE_DIRECTORY_QUERY_KEY,
    staleTime: SCOPE_PICKER_STALE_MS,
    queryFn: () => trpcClient.nodes.directory.query(),
  })
  const state = nodeScopeState(query)
  return (
    <div>
      <DevicePicker<string>
        devices={state.items}
        listState={state.listState}
        fleet={state.fleet}
        value={value}
        onChange={onChange}
        emptyMeansAll
        noun="node"
        groupTitle={nodeGroupTitle}
        {...(testId !== undefined ? { testId } : {})}
      />
      {query.data?.complete === false && (
        <p
          className="mt-1 text-[10px] text-foreground-subtle"
          data-testid="node-directory-incomplete"
        >
          {t(
            'system.scopePickers.theNodeHistoryCouldNot',
            'The node history could not be read — offline nodes may be missing from this list.',
          )}
        </p>
      )}
    </div>
  )
}

export function PackagePicker({ value, onChange, testId }: ScopePickerProps) {
  const trpcClient = useSystem().trpcClient
  const query = useQuery({
    queryKey: PACKAGE_LIST_QUERY_KEY,
    staleTime: SCOPE_PICKER_STALE_MS,
    queryFn: () => trpcClient.addons.listPackages.query(),
  })
  const state = packageScopeState(query)
  return (
    <DevicePicker<string>
      devices={state.items}
      listState={state.listState}
      fleet={state.fleet}
      value={value}
      onChange={onChange}
      emptyMeansAll
      noun="package"
      groupTitle={packageGroupTitle}
      {...(testId !== undefined ? { testId } : {})}
    />
  )
}
