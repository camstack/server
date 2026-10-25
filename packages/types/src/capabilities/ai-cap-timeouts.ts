/**
 * Transport bounds for AI capability methods.
 *
 * Its own module because `llm.cap.ts` and `llm-runtime.cap.ts` already import
 * each other: declaring the constant in either one hands the other `undefined`
 * at module-init time, and an undefined `timeoutMs` silently falls back to the
 * kernel's 60 s default — the exact failure this constant exists to prevent,
 * reintroduced invisibly. Found by the guard, not by review.
 */

/**
 * Ceiling for a cap method that runs inference or loads a model.
 *
 * Deliberately far above anything the AI layer itself may wait for (a summary
 * asks 180 s by default, a rule may ask 600 s), because the TRANSPORT must
 * never be the layer that gives up first: when it does, the failure is
 * reported as a transport error for a model that was still thinking, naming
 * the wrong layer and hiding the real one.
 *
 * Measured 2026-09-03: a 6-image vision request needs 44.8 s warm and ~20 s
 * more on a cold model load. With no declaration every digest failed at
 * exactly 60 s and shipped without its text.
 *
 * A ceiling, not a budget. The AI layer's own timeouts (the rule's `timeoutMs`,
 * the profile's `timeoutMs` / `firstTokenTimeoutMs`) remain the things that
 * decide when to stop, because only they can say WHY.
 */
export const AI_CAP_TRANSPORT_TIMEOUT_MS = 600_000

/** A multi-gigabyte download. An hour is not generous, it is honest. */
export const AI_MODEL_INSTALL_TIMEOUT_MS = 60 * 60_000
