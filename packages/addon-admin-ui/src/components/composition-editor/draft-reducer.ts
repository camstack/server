/**
 * The composition editor's draft (spec §3, D676). Immutable: every action
 * returns a new draft. `draftToComposition` runs the SAME `CompositionSchema`
 * the server parses with; everything past the schema (kinds, sources, cycles,
 * ownership) is the server's `validateComposition`, shown in Verify.
 */
import {
  type Composition,
  type CompositionFieldSource,
  type CompositionFieldsFeature,
  CompositionSchema,
  type CompositionSourceRef,
  type CompositionTarget,
  type DeviceRole,
  type DeviceType,
} from '@camstack/types'

export interface EditorDraft {
  readonly target: CompositionTarget
  readonly name: string
  readonly features: readonly CompositionFieldsFeature[]
}

export type EditorAction =
  | { readonly type: 'set-new-type'; readonly deviceType: DeviceType }
  | { readonly type: 'set-new-role'; readonly role: DeviceRole | null }
  | { readonly type: 'set-name'; readonly name: string }
  | { readonly type: 'add-feature'; readonly cap: string }
  | { readonly type: 'remove-feature'; readonly cap: string }
  | {
      readonly type: 'set-field'
      readonly cap: string
      readonly path: string
      readonly source: CompositionFieldSource
    }
  | { readonly type: 'clear-field'; readonly cap: string; readonly path: string }
  | {
      readonly type: 'remove-binding'
      readonly cap: string
      readonly path: string
      readonly bindingName: string
    }
  | {
      readonly type: 'copy-feature'
      readonly cap: string
      readonly from: CompositionSourceRef
      readonly sourceCap: string
      readonly paths: readonly string[]
    }

export type DraftParse =
  | { readonly ok: true; readonly composition: Composition }
  | { readonly ok: false; readonly problems: readonly string[] }

export function newDraft(deviceType: DeviceType): EditorDraft {
  return { target: { kind: 'new', type: deviceType }, name: '', features: [] }
}

export function existingDraft(device: CompositionSourceRef): EditorDraft {
  return { target: { kind: 'existing', device }, name: '', features: [] }
}

export function draftFromComposition(composition: Composition, name: string): EditorDraft {
  return {
    target: composition.target,
    name,
    // A passthrough feature is refused by the validator until slice 3, so none is ever stored.
    features: composition.features.flatMap((f) => (f.kind === 'fields' ? [f] : [])),
  }
}

function mapFeature(
  draft: EditorDraft,
  cap: string,
  update: (feature: CompositionFieldsFeature) => CompositionFieldsFeature,
): EditorDraft {
  return { ...draft, features: draft.features.map((f) => (f.cap === cap ? update(f) : f)) }
}

function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key))
}

export function editorReducer(draft: EditorDraft, action: EditorAction): EditorDraft {
  switch (action.type) {
    case 'set-new-type':
      return draft.target.kind === 'new'
        ? { ...draft, target: { ...draft.target, type: action.deviceType } }
        : draft
    case 'set-new-role': {
      if (draft.target.kind !== 'new') return draft
      const { role: _role, ...rest } = draft.target
      return { ...draft, target: action.role === null ? rest : { ...rest, role: action.role } }
    }
    case 'set-name':
      return { ...draft, name: action.name }
    case 'add-feature':
      return draft.features.some((f) => f.cap === action.cap)
        ? draft
        : {
            ...draft,
            features: [...draft.features, { kind: 'fields', cap: action.cap, fields: {} }],
          }
    case 'remove-feature':
      return { ...draft, features: draft.features.filter((f) => f.cap !== action.cap) }
    case 'set-field':
      return mapFeature(draft, action.cap, (f) => ({
        ...f,
        fields: { ...f.fields, [action.path]: action.source },
      }))
    case 'clear-field':
      return mapFeature(draft, action.cap, (f) => ({
        ...f,
        fields: withoutKey(f.fields, action.path),
      }))
    case 'remove-binding':
      return mapFeature(draft, action.cap, (f) => {
        const field = f.fields[action.path]
        if (field?.kind !== 'expression') return f
        return {
          ...f,
          fields: {
            ...f.fields,
            [action.path]: {
              ...field,
              bindings: withoutKey(field.bindings, action.bindingName),
            },
          },
        }
      })
    case 'copy-feature':
      return mapFeature(draft, action.cap, (f) => ({
        ...f,
        fields: {
          ...f.fields,
          ...Object.fromEntries(
            action.paths.map((path) => [
              path,
              {
                kind: 'from',
                source: action.from,
                cap: action.sourceCap,
                fieldPath: path,
              } satisfies CompositionFieldSource,
            ]),
          ),
        },
      }))
  }
}

export function draftToComposition(draft: EditorDraft): DraftParse {
  const parsed = CompositionSchema.safeParse({ target: draft.target, features: draft.features })
  return parsed.success
    ? { ok: true, composition: parsed.data }
    : {
        ok: false,
        problems: parsed.error.issues.map(
          (issue) => `${issue.path.join('.') || 'composition'}: ${issue.message}`,
        ),
      }
}

export function isDraftDirty(seed: EditorDraft, draft: EditorDraft): boolean {
  return JSON.stringify(seed) !== JSON.stringify(draft)
}

export function nextBindingName(existing: readonly string[]): string {
  for (let i = 1; ; i++) {
    const name = `s${i}`
    if (!existing.includes(name)) return name
  }
}
