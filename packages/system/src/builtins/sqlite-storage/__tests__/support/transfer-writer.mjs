/**
 * A writer PROCESS for `sqlite-snapshot-under-concurrent-writes.spec.ts`
 * (D693): another connection, in another process, committing transfers as fast
 * as it can while the snapshot is taken.
 *
 * Every transaction keeps the two invariants the spec checks on the snapshot —
 * the sum of `account.balance` never changes, and `ledger` and `audit` always
 * hold the same number of rows — and it deletes old rows too, so pages are
 * freed and reused under the copy, not only appended.
 *
 * Plain `.mjs`: it loads with nothing but `better-sqlite3`.
 *
 * Protocol: stdout `READY` once open → stdin `STOP` → stdout `COMMITS <n>` → exit 0.
 */
import { createInterface } from 'node:readline'
import Database from 'better-sqlite3'

const [dbPath] = process.argv.slice(2)
if (!dbPath) throw new Error('usage: transfer-writer.mjs <db>')

const db = new Database(dbPath)
db.pragma('busy_timeout = 5000')
db.pragma('wal_autocheckpoint = 10000')

const accounts = db.prepare('SELECT count(*) AS n FROM account').get().n
const move = db.prepare('UPDATE account SET balance = balance + ? WHERE id = ?')
const addLedger = db.prepare(
  'INSERT INTO ledger (from_id, to_id, amount, memo) VALUES (?, ?, ?, ?)',
)
const addAudit = db.prepare('INSERT INTO audit (ledger_id) VALUES (?)')
const oldest = db.prepare('SELECT min(id) AS id FROM ledger')
const dropLedger = db.prepare('DELETE FROM ledger WHERE id = ?')
const dropAudit = db.prepare('DELETE FROM audit WHERE ledger_id = ?')

let seq = 0
const transfer = db.transaction(() => {
  seq++
  const from = 1 + (seq % accounts)
  const to = 1 + ((seq * 7) % accounts)
  const amount = 1 + (seq % 13)
  move.run(-amount, from)
  move.run(amount, to)
  const { lastInsertRowid } = addLedger.run(from, to, amount, `w${seq}`.padEnd(160, '.'))
  addAudit.run(lastInsertRowid)
  if (seq % 3 === 0) {
    const old = oldest.get().id
    if (old !== null) {
      dropAudit.run(old)
      dropLedger.run(old)
    }
  }
})

let stopping = false
let commits = 0
function loop() {
  if (stopping) {
    process.stdout.write(`COMMITS ${commits}\n`)
    db.close()
    process.exit(0)
  }
  for (let i = 0; i < 20; i++) {
    transfer()
    commits++
  }
  setImmediate(loop)
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === 'STOP') stopping = true
})
process.stdout.write('READY\n')
setImmediate(loop)
