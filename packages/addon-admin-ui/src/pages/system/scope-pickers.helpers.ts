/**
 * What the system family's node and package pickers draw, and what they judge
 * a stored id against (D637).
 *
 *  - D315: pending and failed never claim absence. A node directory whose
 *    history was never read is `complete: false`: it may lack offline nodes the
 *    hub does know, so a stored id missing from it is judged against nothing
 *    (plain "<id>"), never called missing.
 *  - D49: every stored id stays a removable chip whatever the verdict — the
 *    picker guarantees that; nothing here drops an id.
 *
 * TWO BYTE-IDENTICAL COPIES: `packages/addon-admin-ui/src/pages/system/
 * scope-pickers.helpers.ts` (admin) and `camstack/src/components/
 * notifications/scope-pickers.helpers.ts` (viewer), so the two UIs judge the
 * same stored node the same way. The projection itself (`nodePickerItems`,
 * `packagePickerItems`) is shared from `@camstack/types`; what each side keeps
 * apart is `device-fleet-view.ts`. `scripts/check-device-selection-in-sync.ts`
 * fails the commit when the copies differ; edit both.
 */
import { nodePickerItems, packagePickerItems } from '@camstack/types/client'
import type { NcInstalledPackageLike, NodeDirectory } from '@camstack/types'
import type { PickerFleetView } from './device-fleet-view.js'
import type { PickerId, PickerItem } from './device-picker-model.js'
import type { DeviceListState } from './device-selection.js'

export interface ScopePickerState<Id extends PickerId> {
  /** What the picker DRAWS — `[]` until the query answers. */
  readonly items: readonly PickerItem<Id>[]
  /** Whether the query answered (D315). */
  readonly listState: DeviceListState
  /** What an off-list stored id is judged against. */
  readonly fleet: PickerFleetView<Id>
}

/** The slice of a query this reads. */
export interface ScopeQueryLike<T> {
  readonly data: T | undefined
  readonly isError: boolean
}

function stateOf<T>(query: ScopeQueryLike<T>): DeviceListState {
  if (query.data !== undefined) return 'answered'
  return query.isError ? 'failed' : 'pending'
}

/**
 * The verdict a stored node id is judged under. An answered but INCOMPLETE
 * directory is judged as if it had not answered: the list still draws, but it
 * cannot vouch that an id is missing.
 */
function nodeJudgeState(
  directory: NodeDirectory | undefined,
  listState: DeviceListState,
): DeviceListState {
  if (listState !== 'answered') return listState
  return directory?.complete === true ? 'answered' : 'failed'
}

export function nodeScopeState(query: ScopeQueryLike<NodeDirectory>): ScopePickerState<string> {
  const listState = stateOf(query)
  const items = query.data !== undefined ? nodePickerItems(query.data.nodes) : []
  const judge = nodeJudgeState(query.data, listState)
  return {
    items,
    listState,
    fleet: { state: judge, devices: judge === 'answered' ? items : undefined },
  }
}

export function packageScopeState(
  query: ScopeQueryLike<readonly NcInstalledPackageLike[]>,
): ScopePickerState<string> {
  const listState = stateOf(query)
  const items = query.data !== undefined ? packagePickerItems(query.data) : []
  return {
    items,
    listState,
    fleet: { state: listState, devices: listState === 'answered' ? items : undefined },
  }
}
