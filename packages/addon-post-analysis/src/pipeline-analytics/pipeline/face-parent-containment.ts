/**
 * WHOSE face is this? The one whose body actually contains it.
 *
 * ## The defect (operator, 2026-09-16, device 107)
 *
 * "una traccia di una persona affiancata ad un'altra acquisisce il viso
 * dell'altra" [a track of a person next to another one acquires the other's face] — and the arithmetic named the cause exactly:
 *
 *     parent body top = 474 − 0.15 × 1009 = 322.65
 *     face box top                        = 322.62
 *
 * The face detector runs on the parent's crop PADDED by
 * `detailCropPaddingRatio` (0.15 on this hub), and the adult's padding reached
 * up into the child standing beside him. The adult was looking down, so his own
 * face was not detectable; the only face inside his padded crop was the child's,
 * and it was bound to him — thumbnail of one person, identity of another.
 *
 * The padding is NOT the thing to change: it is the vector index's convention
 * (D52), and moving it invalidates the index. What was missing is the question
 * nobody asked afterwards — is this face even in this body?
 *
 * ## The rule, and why the CENTRE
 *
 * The face's centre must lie inside the parent's OWN box — the un-padded one.
 *
 * Not an area-overlap fraction: a person box that clips the top of the head is
 * ordinary, and a threshold high enough to reject a neighbour would also reject
 * that. The centre survives a clipped box and still refuses decisively the case
 * that bit us, where the face sat entirely above the parent's top edge.
 *
 * It is a containment test and nothing more. It cannot settle a face that is
 * inside TWO parents at once — a child standing within an adult's outstretched
 * arms — which is the second half of this defect and wants exclusivity between
 * siblings, not geometry.
 */

/** A rectangle in frame space. */
export interface ContainmentBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * `true` when the face belongs to this parent by geometry.
 *
 * A degenerate box (zero or negative extent) is NOT contained: an empty
 * rectangle has no centre worth believing, and treating it as a match would
 * bind a face to whichever parent happened to be asked first.
 */
export function faceIsInsideParent(face: ContainmentBox, parent: ContainmentBox): boolean {
  if (face.w <= 0 || face.h <= 0 || parent.w <= 0 || parent.h <= 0) return false
  const cx = face.x + face.w / 2
  const cy = face.y + face.h / 2
  return cx >= parent.x && cx <= parent.x + parent.w && cy >= parent.y && cy <= parent.y + parent.h
}
