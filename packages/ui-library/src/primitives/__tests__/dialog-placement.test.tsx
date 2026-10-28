// @vitest-environment jsdom
//
// DialogContent `placement` prop — coherent center vs. mobile-bottom-sheet
// variant. Before this prop existed, every mobile bottom-sheet consumer had
// to re-null the primitive's hard-coded centering classes with a second,
// conflicting class set (see FaceDetailPanel's override churn). `placement`
// makes DialogContent emit ONE coherent class set per placement instead.
//
// `placement` defaults to 'center'. See `CENTER_CLASSES` below for what the
// byte-for-byte assertions guard now that the migration they were written for has
// landed — and for why the literal has to move with any deliberate class change.
import { describe, it, expect, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../dialog'
import { hasUnconditionalClass, hasVariantClass } from '../../lib/tailwind-variants'

// jsdom does not implement <dialog>.showModal()/close(); stub them so the
// Dialog primitive's open/close effect runs without throwing.
beforeEach(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true
    }
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.open = false
    }
  }
})

function getDialog(): HTMLDialogElement {
  const el = document.querySelector('dialog')
  if (!el) throw new Error('dialog element not found')
  return el
}

/**
 * The exact center/default output of `contentVariants({ width: 'md' })`.
 *
 * This started as a migration guard: introducing `placement` must not change the
 * pre-`placement` center output. That migration has landed, so what it guards now
 * is *accidental* churn in the center class set — a class dropped or reordered by
 * an unrelated edit.
 *
 * A frozen byte string cannot tell an accidental change from a deliberate one, so
 * it needs updating in the same commit as any deliberate change. It went stale
 * exactly that way once: `[&:not([open])]:hidden` was added to the primitive and
 * this literal was not, leaving two permanently red tests that read as unrelated
 * breakage.
 *
 * `[&:not([open])]:hidden` is correct and stays: a `<dialog>` gets `display: none`
 * from the UA stylesheet only until something else sets `display`, and a closed
 * dialog rendering visible is a much worse bug than a redundant class.
 */
/**
 * `text-foreground` pairs with `bg-background-elevated` and is deliberate: a
 * `<dialog>` renders in the top layer, so without it the subtree inherits a
 * colour from outside the dialog and any child that declares none renders
 * invisible on one of the two themes.
 */
/**
 * The height cap subtracts twice the LARGER safe-area inset, not `2rem`
 * alone. The dialog is centred on the VIEWPORT, which under
 * `viewport-fit=cover` extends behind the iOS notch and home indicator; a
 * dialog tall enough to reach its cap otherwise put its header under the
 * status bar. Doubling the larger inset is what makes a viewport-centred box
 * clear both edges when the insets are asymmetric.
 */
/**
 * `overflow-y-auto` moved out of the base into the `scroll` variant (default
 * `content`), so the default output is byte-identical apart from where that
 * one class now sits in the string. The alternative — `scroll="body"` — makes
 * the dialog a non-scrolling flex column and hands the scrolling to
 * `<DialogBody>`, so a long form's title, tab strip and Save row stay put.
 * This literal moved in the same commit as that change, per the note above.
 */
const CENTER_CLASSES =
  'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 m-0 w-[calc(100vw-2rem)] bg-background-elevated text-foreground border border-border rounded-lg p-4 backdrop:bg-black/50 backdrop:backdrop-blur-sm max-h-[calc(100dvh-2rem-2*max(env(safe-area-inset-top),env(safe-area-inset-bottom)))] [&:not([open])]:hidden max-w-md overflow-y-auto overscroll-contain'

describe('DialogContent placement', () => {
  it('defaults to center and emits the exact center class set', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    expect(getDialog().className).toBe(CENTER_CLASSES)
  })

  it('placement="center" emits the exact center class set', () => {
    render(
      <Dialog open>
        <DialogContent placement="center">
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    expect(getDialog().className).toBe(CENTER_CLASSES)
  })

  it('placement="center" centers via fixed/translate classes and has no sheet bottom-anchoring', () => {
    render(
      <Dialog open>
        <DialogContent placement="center">
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    const classes = getDialog().className.split(/\s+/)
    for (const expected of ['left-1/2', 'top-1/2', '-translate-x-1/2', '-translate-y-1/2']) {
      expect(classes).toContain(expected)
    }
    expect(classes).not.toContain('bottom-0')
  })

  it('placement="sheet-on-mobile" emits a full-width bottom sheet on mobile', () => {
    render(
      <Dialog open>
        <DialogContent placement="sheet-on-mobile">
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    const classes = getDialog().className.split(/\s+/)
    for (const expected of [
      'bottom-0',
      'left-0',
      'right-0',
      'top-auto',
      'w-full',
      'max-w-full',
      'translate-x-0',
      'translate-y-0',
      'rounded-b-none',
      'max-h-[92dvh]',
      // The sheet is flush with the bottom viewport edge, which under
      // `viewport-fit=cover` sits behind the iOS home indicator. The flush
      // edge has to stay flush, so the inset is absorbed as PADDING rather
      // than an offset — otherwise the sheet's last row is untappable.
      'pb-[calc(1rem+env(safe-area-inset-bottom))]',
    ]) {
      expect(classes).toContain(expected)
    }
  })

  it('placement="sheet-on-mobile" re-centers via the md: breakpoint set', () => {
    render(
      <Dialog open>
        <DialogContent placement="sheet-on-mobile">
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    const classes = getDialog().className.split(/\s+/)
    for (const expected of [
      'md:left-1/2',
      'md:top-1/2',
      'md:-translate-x-1/2',
      'md:-translate-y-1/2',
      'md:rounded-lg',
      'md:bottom-auto',
    ]) {
      expect(classes).toContain(expected)
    }
  })

  // Critical (Task D3 review): unprefixed `w-full max-w-full` from
  // sheet-on-mobile beats the `width` variant's `max-w-*` under twMerge, so
  // desktop was left with an UNBOUNDED-width dialog unless the width cap is
  // reactivated at `md:`. One case per `width` value.
  it.each([
    ['sm', 'md:max-w-sm'],
    ['md', 'md:max-w-md'],
    ['lg', 'md:max-w-lg'],
  ] as const)('placement="sheet-on-mobile" width="%s" reactivates the width cap at md:', (width, expectedMaxWidth) => {
    render(
      <Dialog open>
        <DialogContent placement="sheet-on-mobile" width={width}>
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    const classes = getDialog().className.split(/\s+/)
    expect(classes).toContain('md:w-[calc(100vw-2rem)]')
    expect(classes).toContain(expectedMaxWidth)
  })
})

/**
 * The DECISION guarded here is "which box scrolls", not a class literal: a
 * `scroll="body"` dialog must NOT be a scroll container itself, or the chrome
 * it exists to keep on screen scrolls away with the fields — the report that
 * produced this variant ("the headers inside rule creation are not
 * scrollable"). See `docs/ui/conventions.md`, "Frozen-string tests have an
 * expiry date", for why this is not another byte-for-byte assertion.
 */
describe('DialogContent scroll', () => {
  it('scrolls the whole dialog by default', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    const classes = getDialog().className.split(/\s+/)
    expect(classes).toContain('overflow-y-auto')
    expect(classes).not.toContain('overflow-hidden')
  })

  it('scroll="body" hands the scrolling to DialogBody and stops scrolling itself', () => {
    render(
      <Dialog open>
        <DialogContent scroll="body">
          <DialogTitle>Title</DialogTitle>
          <DialogBody>
            <p>Fields</p>
          </DialogBody>
        </DialogContent>
      </Dialog>,
    )

    const classes = getDialog().className.split(/\s+/)
    expect(classes).not.toContain('overflow-y-auto')
    for (const expected of ['flex', 'flex-col', 'overflow-hidden']) {
      expect(classes).toContain(expected)
    }
  })

  /*
   * THE REGRESSION THIS PINS, and what it can and cannot prove.
   *
   * Shipped 2026-08-14, reported from an iPhone at 390px within the hour: the
   * rule editor opened as a sheet with an EMPTY body and a Save/Cancel row
   * painted on top of the tab strip. Desktop was perfect.
   *
   * Cause: the dialog had a `max-height` and no height. A flex column with an
   * auto height sizes to its items' contributions, and a `flex-1 min-h-0`
   * item contributes its flex basis — `0%` — on iOS Safari. So the body
   * resolved to zero, the `<Tabs>` wrapper above it collapsed the same way,
   * and its children overflowed a box occupying no space with the footer laid
   * out straight over them.
   *
   * jsdom has NO layout engine: `offsetHeight` is 0 for everything, so a test
   * here cannot measure the body or intersect two rectangles. What it CAN pin
   * is the decision that makes the geometry possible — a body-scroll dialog is
   * never left height-auto below `md`. Neutralisation was run: deleting either
   * `scroll: 'body'` compound variant turns the matching case below red.
   */
  it.each([
    ['sheet-on-mobile', 'h-[92dvh]'],
    ['center', 'h-[calc(100dvh-2rem-2*max(env(safe-area-inset-top),env(safe-area-inset-bottom)))]'],
  ] as const)('scroll="body" placement="%s" resolves a DEFINITE height below md, and grows to content above it', (placement, expectedHeight) => {
    render(
      <Dialog open>
        <DialogContent scroll="body" placement={placement}>
          <DialogBody>
            <p>Fields</p>
          </DialogBody>
        </DialogContent>
      </Dialog>,
    )

    const className = getDialog().className
    // Unconditional, i.e. it applies at the width where the bug appeared.
    expect(hasUnconditionalClass(className, expectedHeight)).toBe(true)
    // …and only there: a centred desktop card grows to its content.
    expect(hasVariantClass(className, 'md', 'h-auto')).toBe(true)
  })

  /*
   * The second half of the same report: the footer painted ON TOP of the tab
   * strip. jsdom cannot intersect two rectangles, but it can prove the footer
   * has no way to leave the flow — the only two mechanisms that put one box
   * over another here are out-of-flow positioning and a collapsed sibling, and
   * the height fix above removes the second. So: everything is in normal flow,
   * in source order, and the BODY is the only item allowed to give ground.
   */
  it('keeps the chrome in normal flow, in order, with only the body shrinkable', () => {
    render(
      <Dialog open>
        <DialogContent scroll="body" placement="sheet-on-mobile">
          <DialogHeader data-testid="header">
            <DialogTitle>Title</DialogTitle>
          </DialogHeader>
          <DialogBody data-testid="body">
            <p>Fields</p>
          </DialogBody>
          <DialogFooter data-testid="footer">
            <button type="button">Save</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    )

    const ids = Array.from(getDialog().children)
      .map((el) => el.getAttribute('data-testid'))
      .filter((id): id is string => id !== null)
    expect(ids).toEqual(['header', 'body', 'footer'])

    for (const id of ids) {
      const el = document.querySelector(`[data-testid="${id}"]`)
      const classes = (el?.className ?? '').split(/\s+/)
      // Nothing here may be lifted out of the flow — a positioned footer can
      // paint over the strip no matter how the height resolves.
      for (const positioned of ['absolute', 'fixed', 'sticky']) {
        expect(classes).not.toContain(positioned)
      }
    }

    // The header and footer hold their height; the body is what shrinks. The
    // other way round and a long form squeezes its own title to nothing.
    const shrinkable = (id: string): boolean =>
      !(document.querySelector(`[data-testid="${id}"]`)?.className ?? '')
        .split(/\s+/)
        .includes('shrink-0')
    expect(shrinkable('header')).toBe(false)
    expect(shrinkable('footer')).toBe(false)
    expect(shrinkable('body')).toBe(true)
  })

  it('leaves a scroll="content" dialog height-auto — only the body-scroll chain needs a resolved height', () => {
    render(
      <Dialog open>
        <DialogContent placement="sheet-on-mobile">
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    const classes = getDialog().className.split(/\s+/)
    expect(classes.some((c) => c.startsWith('h-['))).toBe(false)
  })

  it('DialogBody can shrink below its content, or it pushes the footer out instead of scrolling', () => {
    render(
      <Dialog open>
        <DialogContent scroll="body">
          <DialogBody data-testid="body">
            <p>Fields</p>
          </DialogBody>
        </DialogContent>
      </Dialog>,
    )

    const body = document.querySelector('[data-testid="body"]')
    const classes = (body?.className ?? '').split(/\s+/)
    for (const expected of ['flex-1', 'min-h-0', 'overflow-y-auto']) {
      expect(classes).toContain(expected)
    }
  })
})
