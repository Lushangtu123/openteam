import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearRecentLogs, createLogger, LOG_BUFFER_SIZE, recentLogs, redactSecrets, restoreRecentLogs, sanitizeLogDetails } from './logger'

afterEach(() => {
  clearRecentLogs()
  vi.restoreAllMocks()
})

describe('recent logs', () => {
  it('are kept even when nothing is printed, without debug entries', () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const log = createLogger('background', {}, { debugEnabled: false })
    log.debug('noise', { a: 1 })
    log.info('message-send:start', { chatId: 'chat-1', rawLength: 12 })
    log.warn('external-model:retry-scheduled', { retryCount: 1 })

    expect(consoleInfo).not.toHaveBeenCalled()
    expect(recentLogs().map(entry => [entry.level, entry.scope, entry.event])).toEqual([
      ['info', 'background', 'message-send:start'],
      ['warn', 'background', 'external-model:retry-scheduled'],
    ])
    expect(recentLogs()[0].details).toEqual({ chatId: 'chat-1', rawLength: 12 })
    expect(typeof recentLogs()[0].at).toBe('number')
  })

  it('keep only the newest entries', () => {
    const log = createLogger('background', {}, { debugEnabled: false })
    for (let index = 0; index < LOG_BUFFER_SIZE + 5; index += 1) log.info(`event-${index}`)
    expect(recentLogs()).toHaveLength(LOG_BUFFER_SIZE)
    expect(recentLogs()[0].event).toBe('event-5')
  })

  it('carry a child logger’s context', () => {
    createLogger('content', {}, { debugEnabled: false }).child({ roleId: 'role-1' }).error('send:failed', { reason: 'no editor' })
    expect(recentLogs()[0].details).toEqual({ roleId: 'role-1', reason: 'no editor' })
  })

  it('can be put back after the background restarts, older entries first', () => {
    const log = createLogger('background', {}, { debugEnabled: false })
    log.info('after-restart')
    restoreRecentLogs([{ at: 1, level: 'warn', scope: 'background', event: 'before-restart', details: {} }])
    expect(recentLogs().map(entry => entry.event)).toEqual(['before-restart', 'after-restart'])
  })
})

describe('what a log entry may hold', () => {
  it('drops fields that may hold what was written, and keys', () => {
    expect(sanitizeLogDetails({ content: 'secret plan', prompt: 'p', raw: 'r', apiKey: 'sk-abc', systemPrompt: 's', contentLength: 11, chatId: 'c' }))
      .toEqual({ content: '[removed]', prompt: '[removed]', raw: '[removed]', apiKey: '[removed]', systemPrompt: '[removed]', contentLength: 11, chatId: 'c' })
  })

  it('keeps only which site a link goes to: its path may name a conversation', () => {
    expect(sanitizeLogDetails({ senderUrl: 'https://chatgpt.com/c/abc-123?model=x&token=1', iframeSrc: 'https://gemini.google.com/app/9f8e7d' }))
      .toEqual({ senderUrl: 'https://chatgpt.com', iframeSrc: 'https://gemini.google.com' })
  })

  it('drops names, also inside lists of members', () => {
    expect(sanitizeLogDetails({ roleName: '王小明', chatName: '我的项目', title: 't', topic: 'x', goal: 'y', targets: [{ id: 'r1', name: '王小明', status: 'ready' }] }))
      .toEqual({ roleName: '[removed]', chatName: '[removed]', title: '[removed]', topic: '[removed]', goal: '[removed]', targets: [{ id: 'r1', name: '[removed]', status: 'ready' }] })
  })

  it('shortens long text and nested values', () => {
    const details = sanitizeLogDetails({ reason: 'x'.repeat(500), nested: { deep: { deeper: 1 } }, list: Array.from({ length: 30 }, (_, index) => index) })
    expect((details.reason as string).length).toBeLessThanOrEqual(201)
    expect(details.nested).toEqual({ deep: '[object]' })
    expect(details.list).toHaveLength(10)
  })

  it('turns errors into their message', () => {
    expect(sanitizeLogDetails({ error: new Error('HTTP 503: busy') })).toEqual({ error: 'HTTP 503: busy' })
  })
})

describe('secrets in text', () => {
  it('are blanked out wherever they appear', () => {
    expect(redactSecrets('key sk-proj-AbCdEf1234567890xyz failed')).toBe('key [secret] failed')
    expect(redactSecrets('Authorization: Bearer abc.def.ghi')).toBe('Authorization: Bearer [secret]')
    expect(redactSecrets('AIzaSyD-1234567890abcdefghijklmnop')).toBe('[secret]')
    expect(redactSecrets('token ' + 'a1B2'.repeat(12))).toBe('token [secret]')
    expect(redactSecrets('HTTP 503：This model is busy')).toBe('HTTP 503：This model is busy')
  })
})

describe('createLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('suppresses all console logs when debug logging is disabled', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const logger = createLogger('test', {}, { debugEnabled: false })

    logger.debug('hidden-debug', { chatId: 'chat-1' })
    logger.info('hidden-info', { roleId: 'role-1' })
    logger.warn('hidden-warn', { messageId: 'msg-1' })

    expect(debug).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('merges child context into emitted details', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const logger = createLogger('test', { chatId: 'chat-1' }, { debugEnabled: true }).child({ roleId: 'role-1' })

    logger.debug('event', { messageId: 'msg-1' })

    expect(debug).toHaveBeenCalledWith('[OpenTeam][test] event', {
      chatId: 'chat-1',
      roleId: 'role-1',
      messageId: 'msg-1',
    })
  })

  it('keeps production error logs off the console', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const logger = createLogger('test', {}, { debugEnabled: false })

    logger.error('hidden-runtime-error', { message: 'failed' })

    expect(error).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('emits warnings and errors when debug logging is enabled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const logger = createLogger('test', {}, { debugEnabled: true })

    logger.warn('visible-warn', { warning: true })
    logger.error('visible-error', { error: true })

    expect(warn).toHaveBeenCalledWith('[OpenTeam][test] visible-warn', { warning: true })
    expect(error).toHaveBeenCalledWith('[OpenTeam][test] visible-error', { error: true })
  })
})
