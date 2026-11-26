/**
 * The device's ONE customization block (D663), read and written through the
 * plan in `customization-save.ts`. Every refusal — the plan's or the server's,
 * which names each problem by path (D391) — comes back as a reason to show.
 */
import { useCreateComposition } from '../../../lib/create-composition'
import type { Composition, CompositionSourceRef } from '@camstack/types'
import {
  useCoreBlocksDelete,
  useCoreBlocksGetCustomization,
  useCoreBlocksUpdateComposition,
} from '@camstack/ui-library'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type CustomizationState, resolveCustomization } from './customization-read'
import { planCustomizationSave } from './customization-save'

export interface CustomizationSaved {
  readonly kind: 'saved'
}
export interface CustomizationSaveRefused {
  readonly kind: 'refused'
  readonly reason: string
}
export type CustomizationSaveOutcome = CustomizationSaved | CustomizationSaveRefused

export interface CustomizationHandle {
  readonly target: CompositionSourceRef
  readonly state: CustomizationState
  readonly saving: boolean
  readonly save: (next: Composition | null) => Promise<CustomizationSaveOutcome>
}

/**
 * The state a plan should be made against: `incoming` unless it is an OLDER
 * block than the one held. A render closes over the query data of its own time,
 * so one that lands after a save's refetch assignment must not drag the ref back
 * to a block whose `updatedAt` the server would refuse.
 */
export function newerCustomization<T extends StampedState>(held: T, incoming: T): T {
  const heldAt = held.view?.block.updatedAt
  const incomingAt = incoming.view?.block.updatedAt
  return heldAt !== undefined && incomingAt !== undefined && incomingAt < heldAt ? held : incoming
}

/** The one field of a state the order of two reads depends on. */
export interface StampedState {
  readonly kind: string
  readonly view?: { readonly block: { readonly updatedAt: number } }
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function useCustomization(target: CompositionSourceRef): CustomizationHandle {
  const query = useCoreBlocksGetCustomization({
    addonId: target.addonId,
    stableId: target.stableId,
  })
  const create = useCreateComposition()
  const update = useCoreBlocksUpdateComposition()
  const remove = useCoreBlocksDelete()
  const state = resolveCustomization({
    status: query.status,
    data: query.data,
    error:
      query.error === null || query.error === undefined ? null : { message: query.error.message },
  })

  const { t } = useTranslation()
  // A save is in flight until its REFETCH lands, not only its mutation: in
  // between, `state` is still the old one, and a second plan against it can
  // read a real change as a no-op and drop it silently (D391, task 5 review M2).
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  // The block a plan is made against is the NEWEST one read, not the one the
  // render that built this `save` closed over: a second save fired before React
  // re-rendered would otherwise send the first save's `updatedAt` and the server
  // would refuse it as "changed since you read it". Every render and every
  // landed refetch advance it, never back to an older block.
  const latest = useRef(state)
  latest.current = newerCustomization(latest.current, state)

  const run = async (next: Composition | null): Promise<CustomizationSaveOutcome> => {
    const plan = planCustomizationSave(latest.current, next)
    try {
      switch (plan.kind) {
        case 'refused':
          return { kind: 'refused', reason: plan.reason }
        case 'noop':
          return { kind: 'saved' }
        case 'create':
          await create.mutateAsync({ block: plan.input })
          break
        case 'update':
          await update.mutateAsync({
            blockId: plan.blockId,
            expectedUpdatedAt: plan.expectedUpdatedAt,
            block: { composition: plan.composition },
          })
          break
        case 'delete':
          await remove.mutateAsync({ blockId: plan.blockId })
          break
      }
      const fresh = await query.refetch()
      if (fresh !== undefined) {
        latest.current = newerCustomization(
          latest.current,
          resolveCustomization({
            status: fresh.status,
            data: fresh.data,
            error:
              fresh.error === null || fresh.error === undefined
                ? null
                : { message: fresh.error.message },
          }),
        )
      }
      return { kind: 'saved' }
    } catch (err: unknown) {
      return { kind: 'refused', reason: reasonOf(err) }
    }
  }

  const save = async (next: Composition | null): Promise<CustomizationSaveOutcome> => {
    if (inFlight.current) return { kind: 'refused', reason: t('customize.saveInFlight') }
    inFlight.current = true
    setBusy(true)
    try {
      return await run(next)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return {
    target,
    state,
    saving: busy || create.isPending || update.isPending || remove.isPending,
    save,
  }
}

export interface DraftCustomizationHandle extends CustomizationHandle {
  /** 1 when the draft differs from the server's block, else 0. */
  readonly pendingCount: number
  /** Writes the draft through the one write path; the refusal reason, or null once written. */
  readonly commit: () => Promise<string | null>
  readonly discard: () => void
}

interface PendingComposition {
  readonly composition: Composition | null
}

/** The state the rows see: the server's, with the drafted composition laid over it. */
function overlay(base: CustomizationState, draft: PendingComposition | null): CustomizationState {
  if (draft === null) return base
  if (base.kind === 'present') {
    return draft.composition === null
      ? { kind: 'none' }
      : { kind: 'present', view: base.view, composition: draft.composition }
  }
  if (base.kind === 'none' && draft.composition !== null) {
    return { kind: 'none', draft: draft.composition }
  }
  return base
}

/**
 * `useCustomization` with the edits held as a draft (planning#675): `save(next)`
 * only moves `next` into the draft (a plan the server could never take, such as
 * a block not read yet, is refused at once); `commit` writes the draft once,
 * with the stamp the block was read at, and a refusal such as `[stale-stamp]`
 * keeps the draft. Rows read the draft through `state`, so two edits on one
 * record become one write.
 */
export function useDraftCustomization(target: CompositionSourceRef): DraftCustomizationHandle {
  const inner = useCustomization(target)
  const [draft, setDraft] = useState<PendingComposition | null>(null)
  const dirty =
    draft !== null && planCustomizationSave(inner.state, draft.composition).kind !== 'noop'
  const save = async (next: Composition | null): Promise<CustomizationSaveOutcome> => {
    const plan = planCustomizationSave(inner.state, next)
    if (plan.kind === 'refused') return { kind: 'refused', reason: plan.reason }
    setDraft({ composition: next })
    return { kind: 'saved' }
  }
  const commit = async (): Promise<string | null> => {
    if (draft === null) return null
    const outcome = await inner.save(draft.composition)
    if (outcome.kind === 'refused') return outcome.reason
    setDraft(null)
    return null
  }
  return {
    target,
    state: overlay(inner.state, draft),
    saving: inner.saving,
    save,
    pendingCount: dirty ? 1 : 0,
    commit,
    discard: () => setDraft(null),
  }
}
