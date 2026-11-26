/**
 * The closed list of Customize kinds and the shape every kind must fill (D1098).
 *
 * A kind exists only as an entry of the registry (`customize-registry.ts`), and
 * its spec REQUIRES every piece: storage with an explicit discriminant, the
 * owner side (row, dialog, remove, enabled switch), the linked side and the
 * concurrency stamp. A piece a kind does not have yet is declared as a typed
 * gap naming the piece and the phase that removes it; there is no other way to
 * leave one out. The phase 4 guard refuses any gap.
 */

/** Every kind of the Customize tab. Identity and the display name are not link kinds and stay outside. */
export const CUSTOMIZE_KINDS = [
  'field-override',
  'power-source',
  'lock-door-sensor',
  'follow-switch',
  'keyed-items',
  'event',
  'config-extension',
  'cap-link',
  'linked-devices',
  'linked-actions',
  'triggered-by',
] as const
export type CustomizeKind = (typeof CUSTOMIZE_KINDS)[number]

/** The pieces a kind may be missing. */
export const CUSTOMIZE_PIECES = [
  'discriminant',
  'ownerRow',
  'dialog',
  'remove',
  'enabled',
  'linkedSide',
  'stamp',
] as const
export type CustomizePiece = (typeof CUSTOMIZE_PIECES)[number]

/** Phase 2 migrates a kind's UI and storage; phase 3 adds the linked side. */
export type CustomizeGapPhase = 2 | 3

/** A piece the kind lacks today: the only accepted way to omit one. */
export interface PieceGap<P extends CustomizePiece> {
  readonly gap: { readonly piece: P; readonly phase: CustomizeGapPhase }
}

export interface PiecePresent<T> {
  readonly present: T
}

/** The piece `P` is either wired to an implementation or a gap that names `P`. */
export type Piece<P extends CustomizePiece, T> = PiecePresent<T> | PieceGap<P>

/** A component, hook or function of the existing implementation. */
export type CustomizeImpl = (...args: never[]) => unknown

export interface ImplComponent {
  readonly component: CustomizeImpl
}
export interface ImplConfirm {
  readonly confirm: CustomizeImpl
}
export interface ImplControl {
  readonly control: CustomizeImpl
}

/** Where a kind lives. The discriminant is explicit, never inferred from the shape of another kind. */
export type CustomizeStorageShape =
  | 'composition-feature'
  | 'extension-slot'
  | 'automation'
  | 'action-links'

/**
 * A piece the kind does not need, with the reason: not a gap, because nothing
 * is missing. A kind whose record has no other record to be told apart from
 * (its own store), or whose control has nothing to pick, says so here instead
 * of faking the piece.
 */
export interface NotNeeded {
  readonly notNeeded: string
}

export interface CustomizeDiscriminant {
  /** The stored field that tells this kind apart, e.g. `kind`. */
  readonly key: string
  /** Its value for this kind. */
  readonly value: string
}

export interface CustomizeStorageSpec {
  readonly shape: CustomizeStorageShape
  readonly discriminant: Piece<'discriminant', CustomizeDiscriminant> | NotNeeded
}

export interface NotTogglable {
  /** Why the stored record has no `enabled`. */
  readonly notTogglable: string
}

export interface CustomizeOwnerSpec {
  /** The row (or cell set) in the single `CustomizeTable`. */
  readonly row: Piece<'ownerRow', ImplComponent>
  /** Add/Edit dialog built on the common `SourceSelector`. */
  readonly dialog: Piece<'dialog', ImplComponent> | NotNeeded
  /** Remove through `useConfirmRemove`. */
  readonly remove: Piece<'remove', ImplConfirm> | NotNeeded
  /** The library `Switch` bound to the stored `enabled`, or the reason the kind cannot be toggled. */
  readonly enabled: Piece<'enabled', ImplControl> | NotTogglable
}

/** "Used by", computed on read from the owner's record; its removal edits the owner's record. */
export interface CustomizeLinkedSideSpec {
  readonly view: CustomizeImpl
}

/** The stamp every save carries and the next save takes from the write's answer. */
export interface CustomizeStampSpec {
  readonly field: string
  readonly plan: CustomizeImpl
}

export interface CustomizeKindSpec {
  readonly kind: CustomizeKind
  readonly storage: CustomizeStorageSpec
  readonly owner: CustomizeOwnerSpec
  readonly linkedSide: Piece<'linkedSide', CustomizeLinkedSideSpec>
  readonly stamp: Piece<'stamp', CustomizeStampSpec>
}

export type CustomizeRegistry = Readonly<Record<CustomizeKind, CustomizeKindSpec>>

/** One gap of one kind, as the phase 4 guard and the inventory list them. */
export interface DeclaredGap {
  readonly kind: CustomizeKind
  readonly piece: CustomizePiece
  readonly phase: CustomizeGapPhase
}

function gapOf<P extends CustomizePiece, T>(
  piece: Piece<P, T> | NotNeeded,
): PieceGap<P>['gap'] | null {
  return 'gap' in piece ? piece.gap : null
}

/** Every gap a spec declares, in piece order. */
export function gapsOf(spec: CustomizeKindSpec): readonly DeclaredGap[] {
  const found = [
    gapOf(spec.storage.discriminant),
    gapOf(spec.owner.row),
    gapOf(spec.owner.dialog),
    gapOf(spec.owner.remove),
    'notTogglable' in spec.owner.enabled ? null : gapOf(spec.owner.enabled),
    gapOf(spec.linkedSide),
    gapOf(spec.stamp),
  ]
  return found.flatMap((g) =>
    g === null ? [] : [{ kind: spec.kind, piece: g.piece, phase: g.phase }],
  )
}

/** The implementation functions a spec has wired, for the spec that proves they resolve. */
export function implsOf(spec: CustomizeKindSpec): readonly CustomizeImpl[] {
  const impls: CustomizeImpl[] = []
  if ('present' in spec.owner.row) impls.push(spec.owner.row.present.component)
  if ('present' in spec.owner.dialog) impls.push(spec.owner.dialog.present.component)
  if ('present' in spec.owner.remove) impls.push(spec.owner.remove.present.confirm)
  if ('present' in spec.owner.enabled) impls.push(spec.owner.enabled.present.control)
  if ('present' in spec.linkedSide) impls.push(spec.linkedSide.present.view)
  if ('present' in spec.stamp) impls.push(spec.stamp.present.plan)
  return impls
}
