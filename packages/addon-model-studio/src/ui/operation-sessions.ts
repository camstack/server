/**
 * In-page ring of Model Studio operation sessions (download / import / convert).
 * Survives tab switches within the MF lifetime; LogsTab reads this + live modal.
 */
export type OperationKind = 'download' | 'import' | 'convert'
export type OperationStatus = 'running' | 'success' | 'error'

export interface OperationSession {
  readonly id: string
  readonly kind: OperationKind
  readonly title: string
  readonly modelId?: string
  readonly format?: string
  readonly nodeId?: string
  readonly status: OperationStatus
  readonly errorMessage?: string
  readonly logs: readonly string[]
  readonly startedAt: number
  readonly finishedAt?: number
}

const MAX_SESSIONS = 80

type Listener = () => void

let sessions: OperationSession[] = []
const listeners = new Set<Listener>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function listOperationSessions(): readonly OperationSession[] {
  return sessions
}

export function getOperationSession(id: string): OperationSession | undefined {
  return sessions.find((s) => s.id === id)
}

export function subscribeOperationSessions(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function startOperationSession(input: {
  readonly kind: OperationKind
  readonly title: string
  readonly modelId?: string
  readonly format?: string
  readonly nodeId?: string
  readonly logs?: readonly string[]
}): string {
  const id = `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const session: OperationSession = {
    id,
    kind: input.kind,
    title: input.title,
    ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
    ...(input.format !== undefined ? { format: input.format } : {}),
    ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    status: 'running',
    logs: input.logs ?? [],
    startedAt: Date.now(),
  }
  sessions = [session, ...sessions].slice(0, MAX_SESSIONS)
  notify()
  return id
}

export function appendOperationLog(id: string, line: string): void {
  sessions = sessions.map((s) => {
    if (s.id !== id) return s
    return { ...s, logs: [...s.logs, line] }
  })
  notify()
}

export function finishOperationSession(
  id: string,
  outcome: { readonly status: 'success' | 'error'; readonly errorMessage?: string },
): void {
  sessions = sessions.map((s) => {
    if (s.id !== id) return s
    return {
      ...s,
      status: outcome.status,
      ...(outcome.errorMessage !== undefined ? { errorMessage: outcome.errorMessage } : {}),
      finishedAt: Date.now(),
    }
  })
  notify()
}

export function replaceOperationLogs(id: string, logs: readonly string[]): void {
  sessions = sessions.map((s) => (s.id === id ? { ...s, logs } : s))
  notify()
}

/** Test-only — wipe the in-page ring between cases. */
export function clearOperationSessionsForTests(): void {
  sessions = []
  notify()
}
