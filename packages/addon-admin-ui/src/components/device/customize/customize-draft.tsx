/**
 * The ONE draft of a device's Customize tab (D1098, rule planning#675): every
 * section (the composition table, linked devices, linked actions, triggered by)
 * keeps its edits as local dirty state and registers them here; this provider
 * draws the single `FormSaveBar`. Save runs each dirty section's own write path
 * in turn (each sends the stamp it read and chains the one the write returned),
 * Discard resets every section to the server state. A refused write keeps the
 * draft and shows the reason.
 */
import { FormSaveBar } from '@camstack/ui-library'
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react'

/** What a section hands the bar. `save` resolves to the refusal reason, or null when it wrote. */
export interface DraftSection {
  readonly pendingCount: number
  readonly save: () => Promise<string | null>
  readonly discard: () => void
}

interface DraftRegistry {
  readonly set: (id: string, section: DraftSection | null) => void
}

const DraftContext = createContext<DraftRegistry | null>(null)

/** Registers a section's dirty state with the tab's bar. Outside a provider it is inert. */
export function useDraftSection(id: string, section: DraftSection): void {
  const registry = useContext(DraftContext)
  useEffect(() => {
    registry?.set(id, section)
  })
  useEffect(() => () => registry?.set(id, null), [registry, id])
}

export interface CustomizeDraftProviderProps {
  readonly children: ReactNode
  /** The section ids in the order Save writes them. */
  readonly order: readonly string[]
}

export function CustomizeDraftProvider({
  children,
  order,
}: CustomizeDraftProviderProps): ReactNode {
  const sections = useRef(new Map<string, DraftSection>())
  const [pending, setPending] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const registry = useRef<DraftRegistry>({
    set: (id, section) => {
      if (section === null) sections.current.delete(id)
      else sections.current.set(id, section)
      let total = 0
      for (const entry of sections.current.values()) total += entry.pendingCount
      setPending(total)
    },
  })

  const save = async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setSaving(true)
    setError(null)
    try {
      const rest = [...sections.current.keys()].filter((id) => !order.includes(id))
      for (const id of [...order, ...rest]) {
        const section = sections.current.get(id)
        if (section === undefined || section.pendingCount === 0) continue
        const reason = await section.save()
        if (reason !== null) {
          setError(reason)
          return
        }
      }
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }
  const discard = (): void => {
    setError(null)
    for (const section of sections.current.values()) section.discard()
  }

  return (
    <DraftContext.Provider value={registry.current}>
      {children}
      {error !== null && (
        <p role="alert" className="text-xs text-danger break-words">
          {error}
        </p>
      )}
      <FormSaveBar
        pendingCount={pending}
        saving={saving}
        onSave={() => void save()}
        onDiscard={discard}
      />
    </DraftContext.Provider>
  )
}
