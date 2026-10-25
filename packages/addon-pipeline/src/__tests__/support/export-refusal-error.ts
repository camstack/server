/** A refused `createExport` throws; narrow without widening the success path. */
export async function expectExportRefusal(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run()
  } catch (e) {
    if (e instanceof Error) return e
    throw e
  }
  throw new Error('expected createExport to throw')
}
