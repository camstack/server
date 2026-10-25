/**
 * Coral availability for tflite imports — shared by the plus catalog catalog and
 * the public plus catalog default card.
 */
import { useEffect, useState } from 'react'
import type { AddonPageProps } from '@camstack/ui-library'
import { tfliteSupportNodes } from '../ui/api.js'
import { useT } from '../i18n/index.js'

type Trpc = AddonPageProps['trpc']

/**
 * Coral gate for tflite artifacts: the pool's ONLY tflite runtime binds the
 * EdgeTPU delegate (inference_pool.py), so without a Coral node a tflite
 * model can never load — the UI says so up front instead of offering an
 * import that fails later. `null` = still resolving.
 */
export function useTfliteNodes(trpc: Trpc, needed: boolean): readonly string[] | null {
  const [nodes, setNodes] = useState<readonly string[] | null>(null)
  useEffect(() => {
    if (!needed) return
    let cancelled = false
    tfliteSupportNodes(trpc)
      .then((list) => {
        if (!cancelled) setNodes(list)
      })
      .catch(() => {
        if (!cancelled) setNodes([])
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trpc, needed])
  return needed ? nodes : []
}

export function TfliteGateNote({ nodes }: { readonly nodes: readonly string[] | null }) {
  const { t } = useT()
  if (nodes === null) {
    return <div className="text-[10px] text-foreground-subtle">{t('tfliteGate.checking')}</div>
  }
  if (nodes.length === 0) {
    return <div className="text-[11px] text-warning">{t('tfliteGate.unsupported')}</div>
  }
  return (
    <div className="text-[10px] text-foreground-subtle">
      {t('tfliteGate.available', { nodes: nodes.join(', ') })}
    </div>
  )
}
