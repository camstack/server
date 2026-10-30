/** Echo speech limits and the worker restart bound (same window as CrashSupervisor). */

export const ALEXA_SPEAK_ADDON_ID = 'import-alexa'
export const ALEXA_SPEAK_KIND = 'alexa-echo'
/** The kind of the Amazon-account broker the Echoes are read from. */
export const ALEXA_BROKER_KIND = 'alexa'

/** What an Echo will read in one turn. Longer text is cut, and the cut is reported. */
export const SPEECH_MAX_CHARS = 450

/** A second phrase to the same Echo waits at least this long, so a burst cannot queue minutes of speech. */
export const SPEAK_MIN_GAP_MS = 20_000

/** The same text to the same Echo inside this window is one utterance, not a queue. */
export const SPEAK_COLLAPSE_MS = 60_000

export const DEVICE_REFRESH_MS = 5 * 60_000

/** Matches `CRASH_WINDOW_MS` / `MAX_CRASHES_IN_WINDOW` in the runner supervisor. */
export const WORKER_CRASH_WINDOW_MS = 60_000
export const WORKER_MAX_CRASHES = 5

/** Where the addon serves the Alexa mark; `listTargetKinds` stamps it as `iconUrl`. */
export const ALEXA_SPEAK_ICON_URL = `/addon/${ALEXA_SPEAK_ADDON_ID}/icons/${ALEXA_SPEAK_KIND}`

export const ALEXA_REGIONS = ['NA', 'EU', 'FE'] as const
export type AlexaRegion = (typeof ALEXA_REGIONS)[number]

export const SPEAK_MODES = ['speak', 'announce'] as const
export type SpeakMode = (typeof SPEAK_MODES)[number]
