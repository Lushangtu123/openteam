// The mic button in the input bar: speech to text with the browser's own speech recognition
// (Chrome sends the audio to its speech service). What is heard appears in the input box as it is
// spoken; a second click, or a pause, ends it. Hidden where the browser has no speech recognition.

export interface SpeechRecognitionResultLike {
  readonly isFinal: boolean
  readonly 0: { readonly transcript: string }
}

export interface SpeechRecognitionEventLike {
  readonly resultIndex: number
  readonly results: ArrayLike<SpeechRecognitionResultLike>
}

export interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

export interface VoiceInputDependencies {
  button: HTMLButtonElement
  input: HTMLTextAreaElement
  language(): 'zh-CN' | 'en'
  showError(message: string): void
  Recognition?: SpeechRecognitionConstructor
}

export interface VoiceInput {
  readonly supported: boolean
  isListening(): boolean
  toggle(): void
  stop(): void
}

export function speechRecognitionFromWindow(target: Window = window): SpeechRecognitionConstructor | undefined {
  const source = target as unknown as Record<string, SpeechRecognitionConstructor | undefined>
  return source.SpeechRecognition ?? source.webkitSpeechRecognition
}

export function createVoiceInput(deps: VoiceInputDependencies): VoiceInput {
  const Recognition = deps.Recognition
  let recognition: SpeechRecognitionLike | undefined
  // The text around the spoken part: what was in the box before and after the cursor when it started.
  let before = ''
  let after = ''
  let finalText = ''

  deps.button.hidden = !Recognition
  render(false)
  deps.button.addEventListener('click', () => toggle())

  function render(listening: boolean): void {
    const en = deps.language() === 'en'
    deps.button.setAttribute('aria-pressed', String(listening))
    deps.button.classList.toggle('listening', listening)
    const label = listening ? (en ? 'Stop voice input' : '停止语音输入') : (en ? 'Voice input' : '语音输入')
    deps.button.setAttribute('aria-label', label)
    deps.button.dataset.tooltip = label
  }

  function write(interim: string): void {
    const spoken = `${finalText}${interim}`
    const joiner = before && spoken && !/\s$/.test(before) && /^[A-Za-z0-9]/.test(spoken) ? ' ' : ''
    deps.input.value = `${before}${joiner}${spoken}${after}`
    const cursor = before.length + joiner.length + spoken.length
    deps.input.setSelectionRange(cursor, cursor)
    deps.input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  function start(): void {
    if (!Recognition) return
    const value = deps.input.value
    const cursor = deps.input.selectionStart ?? value.length
    before = value.slice(0, cursor)
    after = value.slice(cursor)
    finalText = ''
    const session = new Recognition()
    session.lang = deps.language() === 'en' ? 'en-US' : 'zh-CN'
    session.continuous = true
    session.interimResults = true
    session.onresult = event => {
      if (recognition !== session) return
      let interim = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        if (result.isFinal) finalText += result[0].transcript
        else interim += result[0].transcript
      }
      write(interim)
    }
    session.onerror = event => {
      if (recognition !== session) return
      const message = voiceErrorMessage(event.error, deps.language())
      if (message) deps.showError(message)
    }
    session.onend = () => {
      if (recognition !== session) return
      recognition = undefined
      write('')
      render(false)
      deps.input.focus()
    }
    recognition = session
    render(true)
    try {
      session.start()
    } catch (error) {
      recognition = undefined
      render(false)
      deps.showError(error instanceof Error ? error.message : String(error))
    }
  }

  function stop(): void {
    recognition?.stop()
  }

  function toggle(): void {
    if (recognition) stop()
    else start()
  }

  return {
    supported: Boolean(Recognition),
    isListening: () => Boolean(recognition),
    toggle,
    stop,
  }
}

export function voiceErrorMessage(error: string, language: 'zh-CN' | 'en'): string | undefined {
  const en = language === 'en'
  if (error === 'aborted' || error === 'no-speech') return undefined
  if (error === 'not-allowed' || error === 'service-not-allowed') return en ? 'Voice input needs the microphone: allow OpenTeam to use it in Chrome, then try again.' : '语音输入需要麦克风：请在 Chrome 里允许 OpenTeam 使用麦克风后再试。'
  if (error === 'audio-capture') return en ? 'No microphone was found.' : '没有找到麦克风。'
  if (error === 'network') return en ? 'Voice input needs a network connection (Chrome recognizes speech online).' : '语音输入需要联网（Chrome 在线识别语音）。'
  if (error === 'language-not-supported') return en ? 'This language is not supported for voice input.' : '语音输入不支持当前语言。'
  return en ? `Voice input stopped: ${error}` : `语音输入中断：${error}`
}
