import { useCallback } from 'react'
import { useAlert, useConfirm } from '@camstack/ui-library'
import type { z } from 'zod'
import { callCcuAction, type CcuTrpc } from './ccu-client.js'
import { useT } from '../i18n/index.js'

export interface CcuWriteRequest<S extends z.ZodType> {
  readonly action: string
  /** The action input WITHOUT the confirmation flag; the hook adds it after the operator agreed. */
  readonly input: Record<string, unknown>
  readonly schema: S
  readonly title: string
  readonly message: string
  readonly confirmLabel: string
  readonly variant?: 'danger' | 'warning' | 'default'
}

/**
 * Every CCU write goes through here: the operator confirms in a dialog first,
 * only then the action runs with `confirmed: true`, and a failure is shown, not
 * swallowed. Resolves with the answer, or `null` when declined or failed.
 */
export function useCcuWrite(trpc: CcuTrpc) {
  const confirm = useConfirm()
  const alert = useAlert()
  const { t } = useT()
  return useCallback(
    async <S extends z.ZodType>(request: CcuWriteRequest<S>): Promise<z.infer<S> | null> => {
      const agreed = await confirm({
        title: request.title,
        message: request.message,
        confirmLabel: request.confirmLabel,
        variant: request.variant ?? 'default',
      })
      if (!agreed) return null
      try {
        return await callCcuAction(
          trpc,
          request.action,
          { ...request.input, confirmed: true },
          request.schema,
        )
      } catch (err) {
        await alert({
          title: t('write.failedTitle'),
          message: err instanceof Error ? err.message : String(err),
          variant: 'danger',
        })
        return null
      }
    },
    [trpc, confirm, alert, t],
  )
}
