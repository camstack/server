import { act } from 'react'

/**
 * Test helper: pick `value` on a `Select` the way an operator does — open the
 * trigger, click the row. Replaces `fireEvent.change(select, ...)` /
 * `userEvent.selectOptions`, which drove the native `<select>` and cannot
 * reach our list. Fails loudly when the row does not exist or is disabled, so
 * a spec never "selects" something the UI would not offer.
 */
export function selectOption(trigger: HTMLElement, value: string): void {
  if (trigger.getAttribute('aria-expanded') !== 'true') {
    act(() => {
      trigger.click()
    })
  }
  const listId = trigger.getAttribute('aria-controls')
  const list = listId === null ? null : document.getElementById(listId)
  if (list === null) throw new Error('selectOption: the list did not open (disabled select?)')
  const row = Array.from(list.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (el) => el.dataset.value === value,
  )
  if (row === undefined) {
    const have = Array.from(list.querySelectorAll<HTMLElement>('[role="option"]'))
      .map((el) => el.dataset.value)
      .join(', ')
    throw new Error(`selectOption: no row with value "${value}" (rows: ${have})`)
  }
  if (row.getAttribute('aria-disabled') === 'true') {
    throw new Error(`selectOption: row "${value}" is disabled`)
  }
  act(() => {
    row.click()
  })
}

export interface SelectRowSnapshot {
  readonly value: string
  readonly label: string
  readonly disabled: boolean
}

/**
 * Test helper: the rows the list offers, in order — the replacement for reading
 * `select.options`. Opens the list to read it and closes it again.
 */
export function selectRows(trigger: HTMLElement): SelectRowSnapshot[] {
  const wasOpen = trigger.getAttribute('aria-expanded') === 'true'
  if (!wasOpen) {
    act(() => {
      trigger.click()
    })
  }
  const listId = trigger.getAttribute('aria-controls')
  const list = listId === null ? null : document.getElementById(listId)
  const rows = Array.from(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? []).map(
    (el) => ({
      value: el.dataset.value ?? '',
      label: el.textContent ?? '',
      disabled: el.getAttribute('aria-disabled') === 'true',
    }),
  )
  if (!wasOpen) {
    act(() => {
      trigger.click()
    })
  }
  return rows
}

/** Test helper: the row labels, in order. */
export function selectOptionLabels(trigger: HTMLElement): string[] {
  return selectRows(trigger).map((r) => r.label)
}

/** Test helper: the row values, in order. */
export function selectOptionValues(trigger: HTMLElement): string[] {
  return selectRows(trigger).map((r) => r.value)
}

/**
 * Test helper: the `Select` trigger currently SHOWING `text` (the replacement
 * for `getByDisplayValue('text')`, which a native `<select>` answered with its
 * selected option's text). Scope with `within(...)` by passing `container`.
 */
export function selectShowing(
  text: string | RegExp,
  container: ParentNode = document,
): HTMLElement {
  const matches = Array.from(
    container.querySelectorAll<HTMLElement>('[role="combobox"][aria-haspopup="listbox"]'),
  ).filter((el) =>
    typeof text === 'string' ? el.textContent === text : text.test(el.textContent ?? ''),
  )
  const [only] = matches
  if (only === undefined || matches.length > 1) {
    throw new Error(
      `selectShowing: expected exactly one select showing ${String(text)}, found ${matches.length}`,
    )
  }
  return only
}

/**
 * Test helper: wait until the rows the list offers satisfy `check`. Use it
 * instead of `waitFor(() => expect(selectOptionLabels(...)))`: reading the rows
 * opens and closes the list, and that DOM change re-triggers a `waitFor`
 * observer forever, so its timeout never fires and the spec hangs.
 */
export async function waitForSelectRows(
  trigger: HTMLElement,
  check: (rows: SelectRowSnapshot[]) => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (check(selectRows(trigger))) return
    if (Date.now() > deadline) throw new Error('waitForSelectRows: the rows never matched')
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    })
  }
}
