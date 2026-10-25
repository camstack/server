// @vitest-environment jsdom
//
// The three intents of the ONE dialog provider, and the properties the native
// browser dialogs could not give us.
//
// The operator's report was a password reset through `window.prompt`: an
// unmaskable box. So the first assertion here is the masking itself — remove
// `inputType: 'password'` from the provider and this test goes red. The rest
// pin the behaviours a native dialog got for free and a hand-rolled one loses:
// Escape cancels, the input takes focus on open, focus is restored on close,
// and a `danger` confirm does NOT default to the destructive button.
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { useEffect, useState, type JSX } from 'react'
import {
  ConfirmDialogProvider,
  openTopLayer,
  useAlert,
  useConfirm,
  usePrompt,
} from '../confirm-dialog'

interface HarnessProps {
  readonly open: () => Promise<unknown>
  /**
   * `false` waits for a click on the opener button. The focus-restore test
   * needs that: the dialog must capture a REAL previously-focused element, and
   * a dialog opened during mount only ever sees `document.body`.
   */
  readonly onMount?: boolean
}

/** Opens one dialog and records what it resolved to. */
function Harness({ open, onMount = true }: HarnessProps): JSX.Element {
  const [result, setResult] = useState<string>('pending')
  const run = () => {
    void open().then((value) => setResult(JSON.stringify(value ?? null)))
  }
  useEffect(() => {
    if (onMount) run()
    // Fire exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <>
      <button type="button" data-testid="opener" onClick={onMount ? undefined : run}>
        opener
      </button>
      <span data-testid="result">{result}</span>
    </>
  )
}

function PromptHarness({
  options,
  onMount,
}: {
  options: Parameters<ReturnType<typeof usePrompt>>[0]
  onMount?: boolean
}) {
  const prompt = usePrompt()
  return <Harness open={() => prompt(options)} onMount={onMount} />
}

function ConfirmHarness({ options }: { options: Parameters<ReturnType<typeof useConfirm>>[0] }) {
  const confirm = useConfirm()
  return <Harness open={() => confirm(options)} />
}

function AlertHarness({ options }: { options: Parameters<ReturnType<typeof useAlert>>[0] }) {
  const alert = useAlert()
  return <Harness open={() => alert(options)} />
}

function mount(node: JSX.Element) {
  return render(<ConfirmDialogProvider>{node}</ConfirmDialogProvider>)
}

const dialogInput = (): HTMLInputElement => {
  const el = document.querySelector('dialog input')
  if (!(el instanceof HTMLInputElement)) throw new Error('no dialog input')
  return el
}

describe('prompt', () => {
  it('masks a password field and hands back the typed value', async () => {
    mount(
      <PromptHarness
        options={{ title: 'Reset password', label: 'New password', inputType: 'password' }}
      />,
    )
    const input = await waitFor(dialogInput)

    // THE operator report: a native prompt cannot do this.
    expect(input.type).toBe('password')
    // ...and the browser must not offer to remember it.
    expect(input.getAttribute('autocomplete')).toBe('new-password')

    fireEvent.change(input, { target: { value: 'hunter2hunter2' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => {
      expect(screen.getByTestId('result').textContent).toBe('"hunter2hunter2"')
    })
  })

  it('focuses the input on open and restores focus on close', async () => {
    mount(
      <PromptHarness
        options={{ title: 'Reset password', inputType: 'password' }}
        onMount={false}
      />,
    )
    const opener = screen.getByTestId('opener')
    act(() => opener.focus())
    fireEvent.click(opener)

    const input = await waitFor(dialogInput)
    await waitFor(() => {
      expect(document.activeElement).toBe(input)
    })

    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => {
      expect(document.querySelector('dialog')).toBeNull()
    })
    expect(document.activeElement).toBe(opener)
  })

  it('refuses a value its validator rejects, and stays open', async () => {
    mount(
      <PromptHarness
        options={{
          title: 'Reset password',
          inputType: 'password',
          validate: (v) => (v.length < 8 ? 'Password must be at least 8 characters.' : null),
        }}
      />,
    )
    const input = await waitFor(dialogInput)
    fireEvent.change(input, { target: { value: 'short' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))

    expect(await screen.findByText('Password must be at least 8 characters.')).toBeTruthy()
    expect(document.querySelector('dialog')).not.toBeNull()
    expect(screen.getByTestId('result').textContent).toBe('pending')
  })

  it('a danger prompt (typed confirmation) paints OK as destructive, keeps focus on the field and refuses a wrong count', async () => {
    mount(
      <PromptHarness
        options={{
          title: 'Revoke 3 share links?',
          message: 'line one\nline two',
          label: 'Type 3 to confirm',
          confirmLabel: 'Revoke 3',
          variant: 'danger',
          validate: (v) => (v.trim() === '3' ? null : 'Type 3'),
        }}
      />,
    )
    const input = await waitFor(dialogInput)
    await waitFor(() => expect(document.activeElement).toBe(input))
    const ok = screen.getByRole('button', { name: 'Revoke 3' })
    expect(ok.className).toContain('bg-danger')
    fireEvent.change(input, { target: { value: '2' } })
    fireEvent.click(ok)
    expect(await screen.findByText('Type 3')).toBeTruthy()
    expect(screen.getByTestId('result').textContent).toBe('pending')
    fireEvent.change(input, { target: { value: '3' } })
    fireEvent.click(ok)
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('"3"'))
  })

  it('Escape resolves to null — nothing is submitted', async () => {
    mount(<PromptHarness options={{ title: 'Reset password', inputType: 'password' }} />)
    const input = await waitFor(dialogInput)
    fireEvent.change(input, { target: { value: 'typed-then-abandoned' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.getByTestId('result').textContent).toBe('null')
    })
  })

  it('the copy-URL shape is a readable field, not a password box', async () => {
    mount(
      <PromptHarness
        options={{
          title: 'Copy the media URL',
          defaultValue: 'https://hub.local/event-media/1',
          readOnly: true,
          cancelLabel: 'Close',
          // Even if a caller asked for masking, a read-to-copy field must not
          // hide the thing the operator opened it to read.
          inputType: 'password',
        }}
      />,
    )
    const input = await waitFor(dialogInput)
    expect(input.type).toBe('text')
    expect(input.readOnly).toBe(true)
    expect(input.value).toBe('https://hub.local/event-media/1')
    // Nothing is being entered, so there is no affirmative action to offer.
    expect(screen.queryByRole('button', { name: 'OK' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })
})

describe('confirm', () => {
  it('makes the destructive button the NON-default, and Enter does not fire it', async () => {
    mount(
      <ConfirmHarness
        options={{
          title: 'Delete track',
          message: 'Delete this track and every image and clip captured for it?',
          confirmLabel: 'Delete',
          variant: 'danger',
        }}
      />,
    )
    const cancel = await screen.findByRole('button', { name: 'Cancel' })
    await waitFor(() => {
      expect(document.activeElement).toBe(cancel)
    })

    const dialog = document.querySelector('dialog')
    if (!dialog) throw new Error('no dialog')
    fireEvent.keyDown(dialog, { key: 'Enter' })
    expect(screen.getByTestId('result').textContent).toBe('pending')
    expect(screen.getByText(/every image and clip/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => {
      expect(screen.getByTestId('result').textContent).toBe('true')
    })
  })

  it('Enter takes the affirmative on a non-destructive confirm', async () => {
    mount(<ConfirmHarness options={{ title: 'Apply', message: 'Apply this change?' }} />)
    const dialog = await waitFor(() => {
      const el = document.querySelector('dialog')
      if (!el) throw new Error('not yet')
      return el
    })
    fireEvent.keyDown(dialog, { key: 'Enter' })
    await waitFor(() => {
      expect(screen.getByTestId('result').textContent).toBe('true')
    })
  })

  it('Escape resolves false', async () => {
    mount(
      <ConfirmHarness options={{ title: 'Delete', message: 'Gone forever', variant: 'danger' }} />,
    )
    const dialog = await waitFor(() => {
      const el = document.querySelector('dialog')
      if (!el) throw new Error('not yet')
      return el
    })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.getByTestId('result').textContent).toBe('false')
    })
  })
})

describe('the top layer', () => {
  // These dialogs open over event-detail and similar-groups panels, which are
  // `showModal()` dialogs. Anything NOT in the top layer is inert behind them —
  // the confirm would render and refuse every click.
  it('promotes the surface with showModal when the platform has it', () => {
    const el = document.createElement('dialog')
    document.body.appendChild(el)
    let called = 0
    Object.defineProperty(el, 'showModal', {
      configurable: true,
      value: () => {
        called += 1
        el.setAttribute('open', '')
      },
    })
    openTopLayer(el)
    expect(called).toBe(1)
    el.remove()
  })

  it('falls back to the open attribute where showModal is absent (jsdom)', () => {
    const el = document.createElement('dialog')
    expect(typeof el.showModal).not.toBe('function')
    openTopLayer(el)
    expect(el.hasAttribute('open')).toBe(true)
  })

  it('renders the surface as a <dialog>, not a floating div', async () => {
    mount(<AlertHarness options={{ title: 'Notice', message: 'Something happened.' }} />)
    const el = await waitFor(() => {
      const found = document.querySelector('dialog')
      if (!found) throw new Error('not yet')
      return found
    })
    expect(el.hasAttribute('open')).toBe(true)
  })
})

describe('alert', () => {
  it('shows the notice and resolves on acknowledge', async () => {
    mount(
      <AlertHarness
        options={{ title: 'Delete failed', message: 'Check the server logs.', variant: 'danger' }}
      />,
    )
    expect(await screen.findByText('Check the server logs.')).toBeTruthy()
    // A notice has an acknowledge and nothing else to get wrong.
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => {
      expect(screen.getByTestId('result').textContent).toBe('null')
    })
    expect(document.querySelector('dialog')).toBeNull()
  })
})
