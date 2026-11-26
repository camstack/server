import { describe, expect, it } from 'vitest'
import { KeyedSerialiser } from '../serialise-per-key.js'

function gate(): { readonly open: () => void; readonly opened: Promise<void> } {
  let open: () => void = () => undefined
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

describe('KeyedSerialiser', () => {
  it('runs tasks of one key one after another, in call order', async () => {
    const serial = new KeyedSerialiser()
    const first = gate()
    const order: string[] = []
    const a = serial.run('k', async () => {
      order.push('a:start')
      await first.opened
      order.push('a:end')
    })
    const b = serial.run('k', async () => {
      order.push('b:start')
    })
    await Promise.resolve()
    expect(order).toEqual(['a:start'])
    first.open()
    await Promise.all([a, b])
    expect(order).toEqual(['a:start', 'a:end', 'b:start'])
  })

  it('does not make one key wait for another', async () => {
    const serial = new KeyedSerialiser()
    const never = gate()
    const slow = serial.run('slow', () => never.opened)
    await expect(serial.run('fast', async () => 'done')).resolves.toBe('done')
    never.open()
    await slow
  })

  it('a failing task rejects its own caller and not the next one', async () => {
    const serial = new KeyedSerialiser()
    const failing = serial.run('k', async () => {
      throw new Error('boom')
    })
    const next = serial.run('k', async () => 'ok')
    await expect(failing).rejects.toThrow('boom')
    await expect(next).resolves.toBe('ok')
  })
})
