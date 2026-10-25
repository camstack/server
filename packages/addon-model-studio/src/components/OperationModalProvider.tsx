/**
 * Page-level host for ImportProgressModal + operation session recording.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import {
  ImportProgressModal,
  appendProgressLog,
  type ImportProgressStep,
} from './ImportProgressModal.js'
import type { ConvertProgressEvent } from '../ui/api.js'
import {
  appendOperationLog,
  finishOperationSession,
  replaceOperationLogs,
  startOperationSession,
  type OperationKind,
} from '../ui/operation-sessions.js'
import { useT } from '../i18n/index.js'

export interface LiveOperation {
  readonly sessionId: string
  readonly title: string
  readonly steps: readonly ImportProgressStep[]
  readonly progress: ConvertProgressEvent | null
  readonly logs: readonly string[]
  readonly status: 'running' | 'success' | 'error'
  readonly errorMessage?: string
}

export interface BeginOperationInput {
  readonly kind: OperationKind
  readonly title: string
  readonly modelId?: string
  readonly format?: string
  readonly nodeId?: string
  readonly steps: readonly ImportProgressStep[]
  readonly initialLog?: string
}

export interface OperationModalApi {
  readonly begin: (input: BeginOperationInput) => string
  readonly patchSteps: (
    sessionId: string,
    updater: (prev: ImportProgressStep[]) => ImportProgressStep[],
  ) => void
  readonly appendLog: (sessionId: string, line: string) => void
  readonly setProgress: (sessionId: string, progress: ConvertProgressEvent) => void
  readonly succeed: (sessionId: string) => void
  readonly fail: (sessionId: string, errorMessage: string) => void
  readonly run: <T>(
    input: BeginOperationInput,
    work: (ctx: {
      readonly sessionId: string
      readonly appendLog: (line: string) => void
      readonly patchSteps: (updater: (prev: ImportProgressStep[]) => ImportProgressStep[]) => void
      readonly setProgress: (progress: ConvertProgressEvent) => void
    }) => Promise<T>,
  ) => Promise<T>
}

const OperationModalContext = createContext<OperationModalApi | null>(null)

export function useOperationModal(): OperationModalApi {
  const ctx = useContext(OperationModalContext)
  if (ctx === null) {
    throw new Error('useOperationModal: missing OperationModalProvider')
  }
  return ctx
}

export function OperationModalProvider({ children }: { readonly children: ReactNode }) {
  const { t } = useT()
  const [live, setLive] = useState<LiveOperation | null>(null)

  const begin = useCallback((input: BeginOperationInput): string => {
    const logs = input.initialLog !== undefined ? [input.initialLog] : []
    const sessionId = startOperationSession({
      kind: input.kind,
      title: input.title,
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      ...(input.format !== undefined ? { format: input.format } : {}),
      ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
      logs,
    })
    setLive({
      sessionId,
      title: input.title,
      steps: input.steps,
      progress: null,
      logs,
      status: 'running',
    })
    return sessionId
  }, [])

  const patchSteps = useCallback(
    (sessionId: string, updater: (prev: ImportProgressStep[]) => ImportProgressStep[]) => {
      setLive((m) => {
        if (m === null || m.sessionId !== sessionId) return m
        return { ...m, steps: updater([...m.steps]) }
      })
    },
    [],
  )

  const appendLog = useCallback((sessionId: string, line: string) => {
    appendOperationLog(sessionId, line)
    setLive((m) => {
      if (m === null || m.sessionId !== sessionId) return m
      return { ...m, logs: [...m.logs, line] }
    })
  }, [])

  const setProgress = useCallback((sessionId: string, progress: ConvertProgressEvent) => {
    setLive((m) => {
      if (m === null || m.sessionId !== sessionId) return m
      const logs = appendProgressLog(m.logs, progress)
      replaceOperationLogs(sessionId, logs)
      return {
        ...m,
        progress: progress.phase === 'log' ? m.progress : progress,
        logs,
      }
    })
  }, [])

  const succeed = useCallback((sessionId: string) => {
    finishOperationSession(sessionId, { status: 'success' })
    setLive((m) => (m !== null && m.sessionId === sessionId ? { ...m, status: 'success' } : m))
  }, [])

  const fail = useCallback((sessionId: string, errorMessage: string) => {
    finishOperationSession(sessionId, { status: 'error', errorMessage })
    setLive((m) =>
      m !== null && m.sessionId === sessionId ? { ...m, status: 'error', errorMessage } : m,
    )
  }, [])

  const run = useCallback(
    async <T,>(
      input: BeginOperationInput,
      work: (ctx: {
        readonly sessionId: string
        readonly appendLog: (line: string) => void
        readonly patchSteps: (updater: (prev: ImportProgressStep[]) => ImportProgressStep[]) => void
        readonly setProgress: (progress: ConvertProgressEvent) => void
      }) => Promise<T>,
    ): Promise<T> => {
      const sessionId = begin(input)
      try {
        const result = await work({
          sessionId,
          appendLog: (line) => appendLog(sessionId, line),
          patchSteps: (updater) => patchSteps(sessionId, updater),
          setProgress: (progress) => setProgress(sessionId, progress),
        })
        succeed(sessionId)
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : t('operation.failed')
        fail(sessionId, message)
        throw err
      }
    },
    [begin, appendLog, patchSteps, setProgress, succeed, fail, t],
  )

  const api = useMemo(
    (): OperationModalApi => ({ begin, patchSteps, appendLog, setProgress, succeed, fail, run }),
    [begin, patchSteps, appendLog, setProgress, succeed, fail, run],
  )

  return (
    <OperationModalContext.Provider value={api}>
      {children}
      {live !== null && (
        <ImportProgressModal
          title={live.title}
          steps={live.steps}
          progress={live.progress}
          logs={live.logs}
          status={live.status}
          {...(live.errorMessage !== undefined ? { errorMessage: live.errorMessage } : {})}
          onClose={() => setLive(null)}
        />
      )}
    </OperationModalContext.Provider>
  )
}
