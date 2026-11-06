// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { createVoiceInput, voiceErrorMessage, type SpeechRecognitionLike } from './voiceInput'

class FakeRecognition implements SpeechRecognitionLike {
  static last: FakeRecognition | undefined
  lang = ''
  continuous = false
  interimResults = false
  onresult: SpeechRecognitionLike['onresult'] = null
  onerror: SpeechRecognitionLike['onerror'] = null
  onend: SpeechRecognitionLike['onend'] = null
  started = false
  constructor() { FakeRecognition.last = this }
  start() { this.started = true }
  stop() { this.onend?.() }
  hear(parts: Array<[string, boolean]>, resultIndex = 0) {
    const results = parts.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } }))
    this.onresult?.({ resultIndex, results })
  }
}

function harness(language: 'zh-CN' | 'en' = 'zh-CN', supported = true) {
  const button = document.createElement('button')
  const input = document.createElement('textarea')
  const showError = vi.fn()
  const inputEvents = vi.fn()
  input.addEventListener('input', inputEvents)
  const voice = createVoiceInput({ button, input, language: () => language, showError, Recognition: supported ? FakeRecognition : undefined })
  return { button, input, showError, inputEvents, voice }
}

describe('voice input', () => {
  it('is hidden where the browser has no speech recognition', () => {
    const { button, voice } = harness('zh-CN', false)
    expect(button.hidden).toBe(true)
    expect(voice.supported).toBe(false)
  })

  it('writes what is heard at the cursor as it is spoken, and stops on a second click', () => {
    const { button, input, inputEvents } = harness()
    input.value = '@工程师 后面'
    input.setSelectionRange(5, 5)

    button.click()
    const session = FakeRecognition.last!
    expect(session.started).toBe(true)
    expect(session.lang).toBe('zh-CN')
    expect(button.getAttribute('aria-pressed')).toBe('true')

    session.hear([['帮我看', false]])
    expect(input.value).toBe('@工程师 帮我看后面')
    session.hear([['帮我看看方案', true]])
    expect(input.value).toBe('@工程师 帮我看看方案后面')
    expect(inputEvents).toHaveBeenCalled()

    button.click()
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(input.value).toBe('@工程师 帮我看看方案后面')
  })

  it('listens in English when OpenTeam is in English, spacing words from the text before', () => {
    const { button, input } = harness('en')
    input.value = 'Please'
    input.setSelectionRange(6, 6)
    button.click()
    expect(FakeRecognition.last!.lang).toBe('en-US')
    FakeRecognition.last!.hear([['review this', true]])
    expect(input.value).toBe('Please review this')
  })

  it('explains a refused microphone, and stays quiet when nothing was said', () => {
    const { button, showError } = harness()
    button.click()
    FakeRecognition.last!.onerror?.({ error: 'no-speech' })
    expect(showError).not.toHaveBeenCalled()
    FakeRecognition.last!.onerror?.({ error: 'not-allowed' })
    expect(showError).toHaveBeenCalledWith('语音输入需要麦克风：请在 Chrome 里允许 OpenTeam 使用麦克风后再试。')
    expect(voiceErrorMessage('network', 'en')).toContain('network')
  })
})
