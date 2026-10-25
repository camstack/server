/**
 * Most parents one `getChildrenBatch` may name.
 *
 * Every parent in the set becomes one bound `?` in the `parentDeviceId IN (…)`
 * the store compiles (`DeviceRowStore.listByParentMany` → `filter-compiler.ts`),
 * so the set size IS the SQL variable count. Two bounds meet here and 256
 * clears both:
 *
 *  - `SQLITE_MAX_VARIABLE_NUMBER` is 32 766 on SQLite ≥ 3.32 but **999** on
 *    anything older, and better-sqlite3 links whatever amalgamation it was
 *    built against on the host. A fleet-sized set (1 017 parents today) sits
 *    ON that older limit; 256 stays a factor of four below it, so the batch
 *    can never turn a boot into `too many SQL variables` on a host nobody
 *    checked the build of.
 *  - One call's answer is the children of those parents, and the answer
 *    crosses a process boundary. Capping the ask caps the message.
 *
 * A caller with more parents sends ⌈n/256⌉ calls — four for today's fleet,
 * against 1 024 today. The cap is on the SCHEMA, not only on the caller: an
 * over-eager caller is refused, not silently truncated to a wrong answer.
 *
 * ## Why this number lives in its own module and not in the cap
 *
 * Both ends of the batch need it: `device-manager.cap.ts` bounds the input
 * schema with it, and `children-batch-loader.ts` — which runs INSIDE every
 * forked addon-runner — chunks its asks by it. The runner may not reach the
 * `@camstack/types` schema barrel (+~146MB RSS per fork, D28), and re-exporting
 * the constant from `addon.ts` VIA the cap file would drag `device-manager.cap.ts`
 * — zod, `device-provider.cap.js` and the streaming schemas behind it — onto the
 * lightweight entry, which is the same regression wearing a different import
 * specifier. A file with no imports at all cannot do that.
 *
 * Keep this module schema-free: no zod, no cap imports, nothing but the number.
 */
export const DEVICE_CHILDREN_BATCH_MAX = 256
