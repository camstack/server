// Browser stand-in for node:crypto (a @camstack/types module hashes at load time).
let n = 0
export function createHash() {
  let acc = ''
  return {
    update(v: string) {
      acc += String(v)
      return this
    },
    digest() {
      n += 1
      let h = 0
      for (const c of acc) h = (h * 31 + c.charCodeAt(0)) >>> 0
      return (h.toString(16) + n.toString(16)).padEnd(64, '0')
    },
  }
}
export const randomUUID = () => crypto.randomUUID()
export const randomBytes = (k: number) => crypto.getRandomValues(new Uint8Array(k))
export default { createHash, randomUUID, randomBytes }
