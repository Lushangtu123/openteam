// How long a local agent's run may take (each agent's 运行时限, 30 minutes unless set), and when its
// reply says it has gone quiet: after STALL_NOTICE_MS without any sign of work, then every
// STALL_REPEAT_MS. Time spent waiting for the user to allow something does not count.
export const DEFAULT_RUN_LIMIT_MINUTES = 30
export const MIN_RUN_LIMIT_MINUTES = 1
export const MAX_RUN_LIMIT_MINUTES = 240
export const STALL_NOTICE_MS = 3 * 60_000
export const STALL_REPEAT_MS = 5 * 60_000

// A stored or typed limit: a whole number of minutes in range, or undefined (the default).
export function normalizeRunLimitMinutes(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.trim() ? Number(value.trim()) : value
  return typeof number === 'number' && Number.isInteger(number) && number >= MIN_RUN_LIMIT_MINUTES && number <= MAX_RUN_LIMIT_MINUTES ? number : undefined
}

// The form's value: empty is the default; anything else must be in range.
export function readRunLimitMinutes(value: unknown): number | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return undefined
  const minutes = normalizeRunLimitMinutes(value)
  if (minutes === undefined) throw new Error(`运行时限要写 ${MIN_RUN_LIMIT_MINUTES} 到 ${MAX_RUN_LIMIT_MINUTES} 之间的整数（分钟）`)
  return minutes
}
