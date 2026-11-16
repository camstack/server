import { useCallback, useMemo, useState } from 'react'
import {
  availableLogColumns,
  type LogColumnConfig,
  type LogColumnId,
  type LogColumnScope,
  parseStoredLogColumns,
  type StoredLogColumns,
  visibleLogColumns,
} from '../composites/log-stream-columns'

const STORAGE_KEY = 'camstack.logStream.columns'

function readStored(): StoredLogColumns {
  try {
    return parseStoredLogColumns(localStorage.getItem(STORAGE_KEY))
  } catch {
    return {}
  }
}

function writeStored(value: StoredLogColumns): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Private window or blocked storage: the choice lasts until the page closes.
  }
}

export interface LogStreamColumns {
  readonly available: readonly LogColumnId[]
  readonly visible: readonly LogColumnId[]
  readonly setVisible: (id: LogColumnId, shown: boolean) => void
}

/** The table's optional columns: what the code offers, what the viewer switched on or off. */
export function useLogStreamColumns(
  scope: LogColumnScope,
  config: LogColumnConfig | undefined,
): LogStreamColumns {
  const [stored, setStored] = useState<StoredLogColumns>(readStored)
  const available = useMemo(
    () => availableLogColumns(scope, config),
    [scope.addonId, scope.deviceId, config],
  )
  const visible = useMemo(
    () => visibleLogColumns({ available, config, stored }),
    [available, config, stored],
  )
  const setVisible = useCallback((id: LogColumnId, shown: boolean) => {
    setStored((prev) => {
      const next = { ...prev, [id]: shown }
      writeStored(next)
      return next
    })
  }, [])
  return { available, visible, setVisible }
}
