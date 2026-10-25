/**
 * Fixed-capacity ring buffer. When full, push() overwrites the oldest entry.
 * drain() returns up to maxCount items in FIFO order and removes them.
 */
export class RingBuffer<T> {
  private readonly items: Array<T | undefined>
  private head = 0
  private tail = 0
  private count = 0

  constructor(private readonly capacity: number) {
    this.items = Array.from<T | undefined>({ length: capacity })
  }

  get size(): number {
    return this.count
  }

  push(item: T): void {
    this.items[this.tail] = item
    this.tail = (this.tail + 1) % this.capacity
    if (this.count < this.capacity) {
      this.count++
    } else {
      this.head = (this.head + 1) % this.capacity
    }
  }

  drain(maxCount: number): T[] {
    const result: T[] = []
    const n = Math.min(maxCount, this.count)
    for (let i = 0; i < n; i++) {
      result.push(this.items[this.head]!)
      this.items[this.head] = undefined
      this.head = (this.head + 1) % this.capacity
    }
    this.count -= n
    return result
  }
}
