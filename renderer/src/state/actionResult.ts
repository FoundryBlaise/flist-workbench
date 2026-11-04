// What an action a person started resolves to, in one shape for every
// such action: what it answered, or why it did not work. Why keeps the
// sidecar's refusal code beside the words to show, so a view can tell
// one refusal from another without matching on prose.

import { errorDetail, refusalCode, type RefusalCode } from '../lib/api'

/** Why an action did not work: the words to show (`errorDetail`), and
 *  the sidecar's code when it refused (null for any other failure). */
export type ActionError = { message: string; code: RefusalCode | null }

/** What an action resolves to: `value`, what it answered, when it
 *  worked; `error` when it did not. */
export type ActionResult<T = null> = { ok: true; value: T } | { ok: false; error: ActionError }

/** Run `call`; resolve to its answer, or to why it failed. */
export async function attempt<T>(call: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, value: await call() }
  } catch (err) {
    return { ok: false, error: { message: errorDetail(err), code: refusalCode(err) } }
  }
}

/** Run `call` for what it does, not what it answers. */
export function attemptDone(call: () => Promise<unknown>): Promise<ActionResult> {
  return attempt(async () => {
    await call()
    return null
  })
}

/** The words to show for `result`; null when it worked. */
export function errorText(result: ActionResult<unknown>): string | null {
  return result.ok ? null : result.error.message
}
