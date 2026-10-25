export type KnowledgeKind =
  | 'adr'
  | 'architecture'
  | 'agents'
  | 'guard'
  | 'subsystem'
  | 'memory'
  | 'skill'
  | 'reference'
  | 'planning'

/** Set on documents read from the sibling planning clone. */
export type KnowledgeSource = 'planning'

export interface KnowledgeDoc {
  readonly id: string
  readonly kind: KnowledgeKind
  readonly path: string
  readonly relativePath: string
  readonly title: string
  readonly body: string
  readonly private?: boolean
  readonly source?: KnowledgeSource
  readonly mtimeMs: number
  readonly meta?: Readonly<Record<string, unknown>>
}

export interface KnowledgeHit {
  readonly id: string
  readonly kind: KnowledgeKind
  readonly path: string
  readonly relativePath: string
  readonly title: string
  readonly score: number
  readonly snippet: string
  readonly private?: boolean
  readonly source?: KnowledgeSource
}
