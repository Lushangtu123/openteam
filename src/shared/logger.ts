export type LogDetails = Record<string, unknown>

export interface OpenTeamLogger {
  debug(event: string, details?: LogDetails): void
  info(event: string, details?: LogDetails): void
  warn(event: string, details?: LogDetails): void
  error(event: string, details?: LogDetails): void
  child(context: LogDetails): OpenTeamLogger
}

export interface LoggerOptions {
  debugEnabled?: boolean
}

type ConsoleLevel = 'debug' | 'info' | 'warn' | 'error'

// The newest log entries, kept in every build (the console gets them only with debug logging on),
// for 导出诊断信息. Each one is cleaned when it is kept: no field that may hold what was written,
// links without their query, short text, and no secrets.
export interface RecentLogEntry {
  at: number
  level: Exclude<ConsoleLevel, 'debug'>
  scope: string
  event: string
  details: LogDetails
}

export const LOG_BUFFER_SIZE = 400
const LOG_TEXT_MAX_CHARS = 200
const LOG_LIST_MAX_ITEMS = 10
// Fields that may hold the text of a message, a prompt or a persona, a name the user gave (a
// group, a member, a topic, a goal), or a key.
const REMOVED_FIELDS = /^(content|contents|prompt|text|raw|body|snapshot|contentSnapshot|systemPrompt|persona|apiKey|key|token|authorization|password|cookie|cookies|name|roleName|chatName|groupName|title|topic|goal|task|question|description|note|summary|fileName)$/i

let recent: RecentLogEntry[] = []
const recordListeners = new Set<() => void>()

export function recentLogs(): RecentLogEntry[] {
  return [...recent]
}

export function clearRecentLogs(): void {
  recent = []
}

// Entries kept before the background was restarted go in front of the ones since.
export function restoreRecentLogs(entries: RecentLogEntry[]): void {
  recent = [...entries, ...recent].slice(-LOG_BUFFER_SIZE)
}

// Told after each kept entry (the background saves them, so a restart does not lose them).
export function onLogRecorded(listener: () => void): () => void {
  recordListeners.add(listener)
  return () => recordListeners.delete(listener)
}

export function redactSecrets(text: string): string {
  return text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [secret]')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{10,}/g, '[secret]')
    .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, '[secret]')
    .replace(/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}/g, '[secret]')
}

export function sanitizeLogDetails(details: LogDetails): LogDetails {
  return Object.fromEntries(Object.entries(details).slice(0, 30).map(([name, value]) => [name, REMOVED_FIELDS.test(name) ? '[removed]' : sanitizeValue(value, 1)]))
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return sanitizeText(value)
  if (value instanceof Error) return sanitizeText(value.message)
  // A list takes no level of its own: a list of members keeps their ids and statuses.
  if (Array.isArray(value)) return value.slice(0, LOG_LIST_MAX_ITEMS).map(item => sanitizeValue(item, depth))
  if (typeof value === 'object') {
    if (depth <= 0) return '[object]'
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 30).map(([name, item]) => [name, REMOVED_FIELDS.test(name) ? '[removed]' : sanitizeValue(item, depth - 1)]))
  }
  return String(value).slice(0, LOG_TEXT_MAX_CHARS)
}

function sanitizeText(text: string): string {
  let cleaned = text
  // A link is kept as the site it goes to: its path may name a conversation, its query anything.
  if (/^https?:\/\//.test(text)) {
    try {
      cleaned = new URL(text).origin
    } catch {
      // Not a link after all.
    }
  }
  cleaned = redactSecrets(cleaned)
  return cleaned.length > LOG_TEXT_MAX_CHARS ? `${cleaned.slice(0, LOG_TEXT_MAX_CHARS)}…` : cleaned
}

function keepRecent(level: ConsoleLevel, scope: string, event: string, details: LogDetails): void {
  if (level === 'debug') return
  try {
    recent.push({ at: Date.now(), level, scope, event, details: sanitizeLogDetails(details) })
    if (recent.length > LOG_BUFFER_SIZE) recent = recent.slice(-LOG_BUFFER_SIZE)
    for (const listener of recordListeners) listener()
  } catch {
    // Keeping a log entry must never affect what is being logged.
  }
}

declare const __OPENTEAM_DEV__: boolean | undefined

export function createLogger(scope: string, baseContext: LogDetails = {}, options: LoggerOptions = {}): OpenTeamLogger {
  const shouldEmitVerbose = () => options.debugEnabled ?? isDebugLoggingEnabled()

  const emit = (level: ConsoleLevel, event: string, details: LogDetails = {}): void => {
    const payload = { ...baseContext, ...details }
    keepRecent(level, scope, event, payload)
    if (!shouldEmitVerbose()) return
    console[level](`[OpenTeam][${scope}] ${event}`, payload)
  }

  return {
    debug: (event, details) => emit('debug', event, details),
    info: (event, details) => emit('info', event, details),
    warn: (event, details) => emit('warn', event, details),
    error: (event, details) => emit('error', event, details),
    child: context => createLogger(scope, { ...baseContext, ...context }, options),
  }
}

function isDebugLoggingEnabled(): boolean {
  if (typeof __OPENTEAM_DEV__ !== 'undefined' && __OPENTEAM_DEV__) return true

  try {
    const globalRecord = globalThis as unknown as { OPENTEAM_DEBUG?: boolean; localStorage?: Storage; location?: Location }
    if (globalRecord.OPENTEAM_DEBUG === true) return true
    if (globalRecord.localStorage?.getItem('openteam:debug') === 'true') return true
    if (globalRecord.location?.search.includes('openteam_debug=1')) return true
  } catch {
    // Debug logging should never affect app behavior.
  }

  return false
}
