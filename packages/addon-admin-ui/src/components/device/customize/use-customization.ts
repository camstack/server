/**
 * The device's ONE customization block (D663), read and written through the
 * plan in `customization-save.ts`. Every refusal — the plan's or the server's,
 * which names each problem by path (D391) — comes back as a reason to show.
 */
import type { Composition, CompositionSourceRef } from '@camstack/types'
import {
  useCoreBlocksCreateComposition,
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

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function useCustomization(target: CompositionSourceRef): CustomizationHandle {
  const query = useCoreBlocksGetCustomization({
    addonId: target.addonId,
    stableId: target.stableId,
  })
  const create = useCoreBlocksCreateComposition()
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

  const run = async (next: Composition | null): Promise<CustomizationSaveOutcome> => {
    const plan = planCustomizationSave(state, next)
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
      await query.refetch()
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
