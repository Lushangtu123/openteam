// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import { createExternalModelsView } from './externalModelsView'
import type { PriceEntry } from '../shared/modelPriceLookup'

describe('external models view', () => {
  it('adds a test action for saved external models', async () => {
    const store = createDefaultStore()
    store.settings.language = 'zh-CN'
    store.settings.externalModelOrder = ['external-model-1']
    store.settings.externalModelsById['external-model-1'] = {
      id: 'external-model-1',
      name: '本地模型',
      format: 'openai',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'sk-test',
      modelName: 'local-chat-model',
      createdAt: 1,
      updatedAt: 1,
    }
    const runCommand = vi.fn(async () => undefined)
    const testExternalModel = vi.fn(async () => undefined)
    const showError = vi.fn()
    document.body.innerHTML = `
      <button id="settings-button"></button>
      <div id="settings-menu"></div>
      <button id="open-external-models"></button>
      <button id="close-external-models"></button>
      <div id="external-models-modal"></div>
      <div id="external-models-list"></div>
      <form id="external-model-form"></form>
      <input id="external-model-id" />
      <input id="external-model-name" />
      <select id="external-model-format"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select>
      <input id="external-model-base-url" />
      <input id="external-model-api-key" />
      <input id="external-model-model-name" />
      <button id="reset-external-model-form"></button>
    `

    const view = createExternalModelsView({
      getStore: () => store,
      settingsButtonEl: document.querySelector<HTMLButtonElement>('#settings-button')!,
      settingsMenuEl: document.querySelector<HTMLElement>('#settings-menu')!,
      openExternalModelsEl: document.querySelector<HTMLButtonElement>('#open-external-models')!,
      closeExternalModelsEl: document.querySelector<HTMLButtonElement>('#close-external-models')!,
      externalModelsModalEl: document.querySelector<HTMLElement>('#external-models-modal')!,
      externalModelsListEl: document.querySelector<HTMLElement>('#external-models-list')!,
      externalModelFormEl: document.querySelector<HTMLFormElement>('#external-model-form')!,
      externalModelIdEl: document.querySelector<HTMLInputElement>('#external-model-id')!,
      externalModelNameEl: document.querySelector<HTMLInputElement>('#external-model-name')!,
      externalModelFormatEl: document.querySelector<HTMLSelectElement>('#external-model-format')!,
      externalModelBaseUrlEl: document.querySelector<HTMLInputElement>('#external-model-base-url')!,
      externalModelApiKeyEl: document.querySelector<HTMLInputElement>('#external-model-api-key')!,
      externalModelModelNameEl: document.querySelector<HTMLInputElement>('#external-model-model-name')!,
      resetExternalModelFormEl: document.querySelector<HTMLButtonElement>('#reset-external-model-form')!,
      runCommand,
      testExternalModel,
      showError,
    })

    view.renderExternalModels()
    const testButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '测试')!
    expect(testButton).toBeTruthy()

    testButton.click()
    expect(testButton.disabled).toBe(true)
    expect(testButton.textContent).toBe('测试中')
    await vi.waitFor(() => expect(testExternalModel).toHaveBeenCalledWith('external-model-1'))

    expect(runCommand).not.toHaveBeenCalled()
    expect(showError).not.toHaveBeenCalled()
  })

  it('lists the models and opens the form only to add or change one', () => {
    const store = createDefaultStore()
    store.settings.language = 'zh-CN'
    document.body.innerHTML = `
      <button id="settings-button"></button>
      <div id="settings-menu"></div>
      <button id="open-external-models"></button>
      <div id="external-models-modal" hidden>
        <button id="close-external-models"></button>
        <div id="external-models-list"></div>
        <button id="add-external-model" type="button">添加模型</button>
        <form id="external-model-form" hidden>
          <h3 id="external-model-form-title">添加模型</h3>
          <input id="external-model-id" />
          <input id="external-model-name" />
          <select id="external-model-format"><option value="openai">OpenAI</option></select>
          <input id="external-model-base-url" />
          <input id="external-model-api-key" />
          <input id="external-model-model-name" />
          <button id="reset-external-model-form" type="button">取消</button>
        </form>
      </div>
    `
    const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
    const view = createExternalModelsView({
      getStore: () => store,
      settingsButtonEl: $('#settings-button'),
      settingsMenuEl: $('#settings-menu'),
      openExternalModelsEl: $('#open-external-models'),
      closeExternalModelsEl: $('#close-external-models'),
      externalModelsModalEl: $('#external-models-modal'),
      externalModelsListEl: $('#external-models-list'),
      externalModelFormEl: $('#external-model-form'),
      externalModelIdEl: $('#external-model-id'),
      externalModelNameEl: $('#external-model-name'),
      externalModelFormatEl: $('#external-model-format'),
      externalModelBaseUrlEl: $('#external-model-base-url'),
      externalModelApiKeyEl: $('#external-model-api-key'),
      externalModelModelNameEl: $('#external-model-model-name'),
      resetExternalModelFormEl: $('#reset-external-model-form'),
      runCommand: vi.fn(async () => undefined),
      testExternalModel: vi.fn(async () => undefined),
      showError: vi.fn(),
    })
    view.registerExternalModelsEvents()

    // No models yet: the form is open right away.
    view.openExternalModels()
    expect([$('#external-model-form').hidden, $('#add-external-model').hidden]).toEqual([false, true])

    store.settings.externalModelOrder = ['m1']
    store.settings.externalModelsById.m1 = { id: 'm1', name: 'DeepSeek', format: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: 'sk-test', modelName: 'chat', createdAt: 1, updatedAt: 1 }
    view.openExternalModels()
    expect([$('#external-model-form').hidden, $('#add-external-model').hidden]).toEqual([true, false])

    $('#add-external-model').click()
    expect([$('#external-model-form').hidden, $('#external-model-form-title').textContent]).toEqual([false, '添加模型'])
    $('#reset-external-model-form').click()
    expect($('#external-model-form').hidden).toBe(true)

    const editButton = [...document.querySelectorAll<HTMLButtonElement>('#external-models-list button')].find(button => button.textContent === '编辑')!
    editButton.click()
    expect([$('#external-model-form').hidden, $('#external-model-form-title').textContent, $<HTMLInputElement>('#external-model-name').value]).toEqual([false, '修改「DeepSeek」', 'DeepSeek'])
  })

  function accessSetup(options: { allowed: boolean; grants: boolean }) {
    const store = createDefaultStore()
    store.settings.language = 'zh-CN'
    store.settings.externalModelOrder = ['external-model-1']
    store.settings.externalModelsById['external-model-1'] = { id: 'external-model-1', name: 'DeepSeek API', format: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test', modelName: 'deepseek-chat', createdAt: 1, updatedAt: 1 }
    document.body.innerHTML = `
      <button id="settings-button"></button>
      <div id="settings-menu"></div>
      <button id="open-external-models"></button>
      <button id="close-external-models"></button>
      <div id="external-models-modal"></div>
      <div id="external-models-list"></div>
      <form id="external-model-form"></form>
      <input id="external-model-id" />
      <input id="external-model-name" />
      <select id="external-model-format"><option value="openai">OpenAI</option></select>
      <input id="external-model-base-url" />
      <input id="external-model-api-key" />
      <input id="external-model-model-name" />
      <button id="reset-external-model-form"></button>
    `
    const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
    let allowed = options.allowed
    const requestHostAccess = vi.fn(async () => {
      if (options.grants) allowed = true
      return allowed
    })
    const runCommand = vi.fn(async () => undefined)
    const testExternalModel = vi.fn(async () => undefined)
    const showError = vi.fn()
    const view = createExternalModelsView({
      getStore: () => store,
      settingsButtonEl: $('#settings-button'),
      settingsMenuEl: $('#settings-menu'),
      openExternalModelsEl: $('#open-external-models'),
      closeExternalModelsEl: $('#close-external-models'),
      externalModelsModalEl: $('#external-models-modal'),
      externalModelsListEl: $('#external-models-list'),
      externalModelFormEl: $('#external-model-form'),
      externalModelIdEl: $('#external-model-id'),
      externalModelNameEl: $('#external-model-name'),
      externalModelFormatEl: $('#external-model-format'),
      externalModelBaseUrlEl: $('#external-model-base-url'),
      externalModelApiKeyEl: $('#external-model-api-key'),
      externalModelModelNameEl: $('#external-model-model-name'),
      resetExternalModelFormEl: $('#reset-external-model-form'),
      runCommand,
      testExternalModel,
      hasHostAccess: async () => allowed,
      requestHostAccess,
      showError,
    })
    view.registerExternalModelsEvents()
    const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('#external-models-list button')].find(candidate => candidate.textContent === text)
    return { view, $, button, requestHostAccess, runCommand, testExternalModel, showError }
  }

  it('asks to reach a new model\'s address when it is saved, and does not save it when that is refused', async () => {
    const { $, requestHostAccess, runCommand, showError } = accessSetup({ allowed: false, grants: false })
    $<HTMLInputElement>('#external-model-name').value = 'OpenRouter'
    $<HTMLInputElement>('#external-model-base-url').value = 'https://openrouter.ai/api/v1'
    $<HTMLInputElement>('#external-model-api-key').value = 'sk-test'
    $<HTMLInputElement>('#external-model-model-name').value = 'some-model'

    $<HTMLFormElement>('#external-model-form').dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(showError).toHaveBeenCalledWith('需要你允许 OpenTeam 访问 openrouter.ai，才能使用这个模型。'))

    expect(requestHostAccess).toHaveBeenCalledWith('https://openrouter.ai/api/v1')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('saves the model once its address is allowed', async () => {
    const { $, runCommand, showError } = accessSetup({ allowed: false, grants: true })
    $<HTMLInputElement>('#external-model-name').value = 'OpenRouter'
    $<HTMLInputElement>('#external-model-base-url').value = 'https://openrouter.ai/api/v1'

    $<HTMLFormElement>('#external-model-form').dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('EXTERNAL_MODEL_CREATE', expect.objectContaining({ baseUrl: 'https://openrouter.ai/api/v1' })))

    expect(showError).not.toHaveBeenCalled()
  })

  it('refuses an address that is not a web address before asking anything', async () => {
    const { $, requestHostAccess, runCommand, showError } = accessSetup({ allowed: false, grants: true })
    $<HTMLInputElement>('#external-model-base-url').value = 'api.deepseek.com/v1'

    $<HTMLFormElement>('#external-model-form').dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(showError).toHaveBeenCalledWith('模型地址需要以 https:// 或 http:// 开头'))

    expect(requestHostAccess).not.toHaveBeenCalled()
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('marks a saved model whose address is not allowed yet, with a button that allows it', async () => {
    const { view, button, requestHostAccess } = accessSetup({ allowed: false, grants: true })

    view.renderExternalModels()
    await vi.waitFor(() => expect(button('允许访问')).toBeTruthy())
    expect(document.querySelector('.model-access-needed')?.textContent).toBe('还没有允许 OpenTeam 访问 api.deepseek.com，这个模型暂时不能回答。')

    button('允许访问')!.click()
    await vi.waitFor(() => expect(document.querySelector('.model-access-needed')).toBeNull())
    expect(requestHostAccess).toHaveBeenCalledWith('https://api.deepseek.com/v1')
    expect(button('允许访问')).toBeUndefined()
  })

  it('shows no notice for a model whose address is allowed, and does not test one that is refused', async () => {
    const allowed = accessSetup({ allowed: true, grants: true })
    allowed.view.renderExternalModels()
    await Promise.resolve()
    await Promise.resolve()
    expect(document.querySelector('.model-access-needed')).toBeNull()

    const refused = accessSetup({ allowed: false, grants: false })
    refused.view.renderExternalModels()
    refused.button('测试')!.click()
    await vi.waitFor(() => expect(refused.showError).toHaveBeenCalledWith('需要你允许 OpenTeam 访问 api.deepseek.com，才能使用这个模型。'))
    expect(refused.testExternalModel).not.toHaveBeenCalled()
  })

  it('renders external model actions in English mode', () => {
    const store = createDefaultStore()
    store.settings.language = 'en'
    store.settings.externalModelOrder = ['external-model-1']
    store.settings.externalModelsById['external-model-1'] = {
      id: 'external-model-1',
      name: 'Local model',
      format: 'openai',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'sk-test',
      modelName: 'local-chat-model',
      createdAt: 1,
      updatedAt: 1,
    }
    document.body.innerHTML = `
      <button id="settings-button"></button>
      <div id="settings-menu"></div>
      <button id="open-external-models"></button>
      <button id="close-external-models"></button>
      <div id="external-models-modal"></div>
      <div id="external-models-list"></div>
      <form id="external-model-form"></form>
      <input id="external-model-id" />
      <input id="external-model-name" />
      <select id="external-model-format"><option value="openai">OpenAI</option></select>
      <input id="external-model-base-url" />
      <input id="external-model-api-key" />
      <input id="external-model-model-name" />
      <button id="reset-external-model-form"></button>
    `

    const view = createExternalModelsView({
      getStore: () => store,
      settingsButtonEl: document.querySelector<HTMLButtonElement>('#settings-button')!,
      settingsMenuEl: document.querySelector<HTMLElement>('#settings-menu')!,
      openExternalModelsEl: document.querySelector<HTMLButtonElement>('#open-external-models')!,
      closeExternalModelsEl: document.querySelector<HTMLButtonElement>('#close-external-models')!,
      externalModelsModalEl: document.querySelector<HTMLElement>('#external-models-modal')!,
      externalModelsListEl: document.querySelector<HTMLElement>('#external-models-list')!,
      externalModelFormEl: document.querySelector<HTMLFormElement>('#external-model-form')!,
      externalModelIdEl: document.querySelector<HTMLInputElement>('#external-model-id')!,
      externalModelNameEl: document.querySelector<HTMLInputElement>('#external-model-name')!,
      externalModelFormatEl: document.querySelector<HTMLSelectElement>('#external-model-format')!,
      externalModelBaseUrlEl: document.querySelector<HTMLInputElement>('#external-model-base-url')!,
      externalModelApiKeyEl: document.querySelector<HTMLInputElement>('#external-model-api-key')!,
      externalModelModelNameEl: document.querySelector<HTMLInputElement>('#external-model-model-name')!,
      resetExternalModelFormEl: document.querySelector<HTMLButtonElement>('#reset-external-model-form')!,
      runCommand: vi.fn(async () => undefined),
      testExternalModel: vi.fn(async () => undefined),
      showError: vi.fn(),
    })

    view.renderExternalModels()

    expect(document.querySelector('#external-models-list')?.textContent).toContain('Test')
    expect(document.querySelector('#external-models-list')?.textContent).toContain('Edit')
    expect(document.querySelector('#external-models-list')?.textContent).toContain('Delete')
    expect(document.querySelector('#external-models-list')?.textContent).not.toContain('测试')
  })
})

// A form with every field, for the preset, model list and backup tests.
function setupForm(options: { listModelNames?: (request: { format: string; baseUrl: string; apiKey: string }) => Promise<string[]>, requestHostAccess?: (baseUrl: string) => Promise<boolean>, fetchPriceList?: () => Promise<PriceEntry[]> } = {}) {
  const store = createDefaultStore()
  store.settings.language = 'zh-CN'
  document.body.innerHTML = `
    <button id="settings-button"></button>
    <div id="settings-menu"></div>
    <button id="open-external-models"></button>
    <button id="close-external-models"></button>
    <div id="external-models-modal"></div>
    <div id="external-models-list"></div>
    <form id="external-model-form">
      <input id="external-model-id" />
      <input id="external-model-name" />
      <select id="external-model-format"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="local-agent">本机</option></select>
      <select id="external-model-provider"><option value="">自定义（自己填地址）</option></select>
      <input id="external-model-base-url" />
      <input id="external-model-api-key" />
      <a id="external-model-key-link" hidden>去获取 Key</a>
      <input id="external-model-model-name" />
      <select id="external-model-name-choices" hidden></select>
      <button id="fetch-external-model-names" type="button">获取模型列表</button>
      <p id="external-model-names-status"></p>
      <input id="external-model-fallback-name" />
      <select id="external-model-fallback-choices" hidden></select>
      <input id="external-model-price-input" />
      <input id="external-model-price-output" />
      <select id="external-model-price-currency"><option value="CNY">元</option><option value="USD">美元</option></select>
      <button id="lookup-external-model-price" type="button">查价格</button>
      <select id="external-model-price-choices" hidden></select>
      <p id="external-model-price-status"></p>
      <input id="external-model-web-reading" type="checkbox" checked />
      <input id="external-model-daily-cap" />
      <span id="external-model-daily-cap-unit">元 / 天</span>
      <p id="external-model-daily-cap-today" hidden></p>
      <button id="reset-external-model-form" type="button"></button>
    </form>
  `
  const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!
  const listModelNames = vi.fn(options.listModelNames ?? (async () => ['gemini-flash-latest', 'gemini-flash-lite-latest']))
  const requestHostAccess = vi.fn(options.requestHostAccess ?? (async (_baseUrl: string) => true))
  const fetchPriceList = vi.fn(options.fetchPriceList ?? (async () => PRICES))
  const showError = vi.fn()
  const runCommand = vi.fn(async (_type: string, _payload?: Record<string, unknown>) => undefined)
  const view = createExternalModelsView({
    getStore: () => store,
    settingsButtonEl: $('#settings-button'),
    settingsMenuEl: $('#settings-menu'),
    openExternalModelsEl: $('#open-external-models'),
    closeExternalModelsEl: $('#close-external-models'),
    externalModelsModalEl: $('#external-models-modal'),
    externalModelsListEl: $('#external-models-list'),
    externalModelFormEl: $('#external-model-form'),
    externalModelIdEl: $('#external-model-id'),
    externalModelNameEl: $('#external-model-name'),
    externalModelFormatEl: $('#external-model-format'),
    externalModelBaseUrlEl: $('#external-model-base-url'),
    externalModelApiKeyEl: $('#external-model-api-key'),
    externalModelModelNameEl: $('#external-model-model-name'),
    resetExternalModelFormEl: $('#reset-external-model-form'),
    runCommand,
    testExternalModel: vi.fn(async () => undefined),
    hasHostAccess: async () => true,
    requestHostAccess,
    listModelNames,
    fetchPriceList,
    showError,
  })
  view.registerExternalModelsEvents()
  const choose = (selector: string, value: string) => {
    const element = $<HTMLSelectElement | HTMLInputElement>(selector)
    element.value = value
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  }
  return { store, view, $, choose, listModelNames, requestHostAccess, fetchPriceList, showError, runCommand }
}

const PRICES: PriceEntry[] = [
  { id: 'google/gemini-3.8-flash', name: 'Google: Gemini 3.8 Flash', created: 300, input: 0.825, output: 4.125 },
  { id: 'google/gemini-3.7-flash', name: 'Google: Gemini 3.7 Flash', created: 200, input: 0.75, output: 3.75 },
  { id: 'deepseek/deepseek-chat', name: 'DeepSeek: Chat', created: 100, input: 0.2574, output: 1.0287 },
]

describe('provider presets and the model list', () => {
  it('offers every preset, and fills the format, address, name and key page from one', () => {
    const { $, choose } = setupForm()
    const options = [...$<HTMLSelectElement>('#external-model-provider').options].map(option => option.value)
    expect(options).toContain('gemini')
    expect(options).toContain('deepseek')

    choose('#external-model-provider', 'gemini')

    expect($<HTMLInputElement>('#external-model-base-url').value).toBe('https://generativelanguage.googleapis.com/v1beta/openai')
    expect($<HTMLSelectElement>('#external-model-format').value).toBe('openai')
    expect($<HTMLInputElement>('#external-model-name').value).toBe('Google Gemini')
    expect($<HTMLInputElement>('#external-model-model-name').placeholder).toBe('gemini-flash-latest')
    const keyLink = $<HTMLAnchorElement>('#external-model-key-link')
    expect(keyLink.hidden).toBe(false)
    expect(keyLink.href).toBe('https://aistudio.google.com/apikey')

    // A name the preset filled in follows the preset; a name the user typed stays.
    choose('#external-model-provider', 'anthropic')
    expect($<HTMLSelectElement>('#external-model-format').value).toBe('anthropic')
    expect($<HTMLInputElement>('#external-model-name').value).toBe('Anthropic Claude')
    $<HTMLInputElement>('#external-model-name').value = '我的 Claude'
    choose('#external-model-provider', 'deepseek')
    expect($<HTMLInputElement>('#external-model-name').value).toBe('我的 Claude')
  })

  it('shows which preset an address belongs to while it is typed, and custom for any other', () => {
    const { $, choose } = setupForm()
    choose('#external-model-base-url', 'https://api.deepseek.com')
    expect($<HTMLSelectElement>('#external-model-provider').value).toBe('deepseek')
    choose('#external-model-base-url', 'https://proxy.example.test/v1')
    expect($<HTMLSelectElement>('#external-model-provider').value).toBe('')
    expect($<HTMLAnchorElement>('#external-model-key-link').hidden).toBe(true)
  })

  it('fetches the models for the address and key in the form, and lets either field be set from them', async () => {
    const { $, choose, listModelNames, requestHostAccess } = setupForm()
    choose('#external-model-provider', 'gemini')
    $<HTMLInputElement>('#external-model-api-key').value = 'sk-form'

    $<HTMLButtonElement>('#fetch-external-model-names').click()

    const nameChoices = $<HTMLSelectElement>('#external-model-name-choices')
    const fallbackChoices = $<HTMLSelectElement>('#external-model-fallback-choices')
    await vi.waitFor(() => expect(nameChoices.hidden).toBe(false))
    expect(requestHostAccess).toHaveBeenCalledWith('https://generativelanguage.googleapis.com/v1beta/openai')
    expect(listModelNames).toHaveBeenCalledWith({ format: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'sk-form' })
    // The first option only asks to choose, so that every model can be chosen.
    expect([...nameChoices.options].map(option => option.value)).toEqual(['', 'gemini-flash-latest', 'gemini-flash-lite-latest'])
    expect(fallbackChoices.hidden).toBe(false)
    expect([...fallbackChoices.options].map(option => option.value)).toEqual(['', 'gemini-flash-latest', 'gemini-flash-lite-latest'])
    expect($('#external-model-names-status').textContent).toContain('2')

    // A field that already holds a name is changed by the list all the same.
    $<HTMLInputElement>('#external-model-model-name').value = 'gemini-flash-lite-latest'
    choose('#external-model-name-choices', 'gemini-flash-latest')
    choose('#external-model-fallback-choices', 'gemini-flash-lite-latest')
    expect($<HTMLInputElement>('#external-model-model-name').value).toBe('gemini-flash-latest')
    expect($<HTMLInputElement>('#external-model-fallback-name').value).toBe('gemini-flash-lite-latest')
    expect(nameChoices.value).toBe('')

    // Another address: the list is gone.
    choose('#external-model-base-url', 'https://api.deepseek.com')
    expect(nameChoices.hidden).toBe(true)
    expect(fallbackChoices.hidden).toBe(true)
  })

  it('asks for the address and key before fetching, and shows a refusal next to the field', async () => {
    const { $, choose, listModelNames } = setupForm({ listModelNames: async () => { throw new Error('HTTP 400：API key not valid') } })
    $<HTMLButtonElement>('#fetch-external-model-names').click()
    await vi.waitFor(() => expect($('#external-model-names-status').textContent).toBe('先填写模型地址和 Key'))
    expect(listModelNames).not.toHaveBeenCalled()

    choose('#external-model-provider', 'gemini')
    $<HTMLInputElement>('#external-model-api-key').value = 'bad'
    $<HTMLButtonElement>('#fetch-external-model-names').click()
    await vi.waitFor(() => expect($('#external-model-names-status').textContent).toBe('HTTP 400：API key not valid'))
  })
})

describe('a backup model in the form', () => {
  it('is saved with the model, filled in when the model is edited, and shown on its card', async () => {
    const { store, view, $, choose, runCommand } = setupForm()
    choose('#external-model-provider', 'gemini')
    $<HTMLInputElement>('#external-model-api-key').value = 'sk-1'
    $<HTMLInputElement>('#external-model-model-name').value = 'gemini-flash-latest'
    $<HTMLInputElement>('#external-model-fallback-name').value = ' gemini-flash-lite-latest '
    $<HTMLFormElement>('#external-model-form').requestSubmit()

    await vi.waitFor(() => expect(runCommand).toHaveBeenCalled())
    expect(runCommand).toHaveBeenCalledWith('EXTERNAL_MODEL_CREATE', expect.objectContaining({ modelName: 'gemini-flash-latest', fallbackModelName: 'gemini-flash-lite-latest' }))

    store.settings.externalModelOrder = ['m-1']
    store.settings.externalModelsById['m-1'] = { id: 'm-1', name: 'Gemini', format: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'sk-1', modelName: 'gemini-flash-latest', fallbackModelName: 'gemini-flash-lite-latest', createdAt: 1, updatedAt: 1 }
    view.renderExternalModels()
    expect($('#external-models-list').textContent).toContain('gemini-flash-lite-latest')
    ;[...document.querySelectorAll<HTMLButtonElement>('#external-models-list button')].find(button => button.textContent === '编辑')!.click()
    expect($<HTMLInputElement>('#external-model-fallback-name').value).toBe('gemini-flash-lite-latest')
  })
})

describe('editing a saved model with the fetched list', () => {
  it('saves the main and backup models chosen from the lists', async () => {
    const { store, view, $, choose, runCommand } = setupForm()
    store.settings.externalModelOrder = ['m-1']
    store.settings.externalModelsById['m-1'] = { id: 'm-1', name: 'Gemini API', format: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'sk-1', modelName: 'gemini-flash-lite-latest', createdAt: 1, updatedAt: 1 }
    view.openExternalModels()
    ;[...document.querySelectorAll<HTMLButtonElement>('#external-models-list button')].find(button => button.textContent === '编辑')!.click()

    $<HTMLButtonElement>('#fetch-external-model-names').click()
    await vi.waitFor(() => expect($<HTMLSelectElement>('#external-model-fallback-choices').hidden).toBe(false))
    choose('#external-model-name-choices', 'gemini-flash-latest')
    choose('#external-model-fallback-choices', 'gemini-flash-lite-latest')
    $<HTMLFormElement>('#external-model-form').requestSubmit()

    await vi.waitFor(() => expect(runCommand).toHaveBeenCalled())
    expect(runCommand).toHaveBeenCalledWith('EXTERNAL_MODEL_UPDATE', expect.objectContaining({ modelId: 'm-1', modelName: 'gemini-flash-latest', fallbackModelName: 'gemini-flash-lite-latest' }))
  })
})

describe('a daily spending cap in the form', () => {
  it('is saved with the price, named in the price\'s currency, and shows what the model spent today when edited', async () => {
    const { store, view, $, choose, runCommand } = setupForm()
    choose('#external-model-provider', 'gemini')
    $<HTMLInputElement>('#external-model-api-key').value = 'sk-1'
    $<HTMLInputElement>('#external-model-model-name').value = 'gemini-flash-latest'
    $<HTMLInputElement>('#external-model-price-input').value = '2'
    $<HTMLInputElement>('#external-model-price-output').value = '8'
    choose('#external-model-price-currency', 'USD')
    expect($('#external-model-daily-cap-unit').textContent).toBe('美元 / 天')
    $<HTMLInputElement>('#external-model-daily-cap').value = ' 5 '
    $<HTMLFormElement>('#external-model-form').requestSubmit()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalled())
    expect(runCommand).toHaveBeenCalledWith('EXTERNAL_MODEL_CREATE', expect.objectContaining({ pricing: { input: '2', output: '8', currency: 'USD' }, dailyCap: '5' }))

    const today = new Date()
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    store.settings.externalModelOrder = ['m-1']
    store.settings.externalModelsById['m-1'] = { id: 'm-1', name: 'Gemini', format: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'sk-1', modelName: 'gemini-flash-latest', pricing: { input: 2, output: 8, currency: 'CNY' }, dailyCap: 5, createdAt: 1, updatedAt: 1 }
    store.modelSpendById = { 'm-1': { day, spent: 1.2 } }
    view.renderExternalModels()
    ;[...document.querySelectorAll<HTMLButtonElement>('#external-models-list button')].find(button => button.textContent === '编辑')!.click()
    expect($<HTMLInputElement>('#external-model-daily-cap').value).toBe('5')
    expect($('#external-model-daily-cap-unit').textContent).toBe('元 / 天')
    expect($('#external-model-daily-cap-today').textContent).toBe('今天估算已花 ¥1.20')
    expect($<HTMLElement>('#external-model-daily-cap-today').hidden).toBe(false)
  })
})

describe('looking up a model\'s price', () => {
  it('fills the price in dollars for a model the list has, after the browser allows openrouter.ai', async () => {
    const { $, choose, requestHostAccess, fetchPriceList } = setupForm()
    choose('#external-model-provider', 'gemini')
    $<HTMLInputElement>('#external-model-model-name').value = 'gemini-3.8-flash'
    $<HTMLButtonElement>('#lookup-external-model-price').click()
    await vi.waitFor(() => expect($<HTMLInputElement>('#external-model-price-input').value).toBe('0.825'))
    expect(requestHostAccess).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models')
    expect(fetchPriceList).toHaveBeenCalledTimes(1)
    expect($<HTMLInputElement>('#external-model-price-output').value).toBe('4.125')
    expect($<HTMLSelectElement>('#external-model-price-currency').value).toBe('USD')
    expect($('#external-model-daily-cap-unit').textContent).toBe('美元 / 天')
    expect($('#external-model-price-status').textContent).toBe('已填入 OpenRouter 列出的「google/gemini-3.8-flash」价格（美元 / 百万 token），以服务商官网为准；用免费额度时实际不花钱。')
  })

  it('lets the user choose for a name such as gemini-flash-latest, and fills the one chosen', async () => {
    const { $, choose } = setupForm()
    choose('#external-model-provider', 'gemini')
    $<HTMLInputElement>('#external-model-model-name').value = 'gemini-flash-latest'
    $<HTMLButtonElement>('#lookup-external-model-price').click()
    await vi.waitFor(() => expect($<HTMLSelectElement>('#external-model-price-choices').hidden).toBe(false))
    const options = [...$<HTMLSelectElement>('#external-model-price-choices').options].map(option => option.textContent)
    expect(options).toEqual(['选择对应的模型…', 'google/gemini-3.8-flash · $0.825 / $4.125', 'google/gemini-3.7-flash · $0.75 / $3.75'])
    expect($('#external-model-price-status').textContent).toBe('价格表里没有「gemini-flash-latest」这个名字，它可能是别名；请选择它对应的模型。')
    expect($<HTMLInputElement>('#external-model-price-input').value).toBe('')
    choose('#external-model-price-choices', 'google/gemini-3.7-flash')
    expect($<HTMLInputElement>('#external-model-price-input').value).toBe('0.75')
    expect($<HTMLInputElement>('#external-model-price-output').value).toBe('3.75')
  })

  it('says to check the maker\'s own page for a maker that charges in yuan', async () => {
    const { $, choose } = setupForm()
    choose('#external-model-provider', 'deepseek')
    $<HTMLInputElement>('#external-model-model-name').value = 'deepseek-chat'
    $<HTMLButtonElement>('#lookup-external-model-price').click()
    await vi.waitFor(() => expect($<HTMLInputElement>('#external-model-price-input').value).toBe('0.2574'))
    expect($('#external-model-price-status').textContent).toContain('这家在国内按人民币计价，官网价格可能不同')
  })

  it('says why when there is no name, access is refused, or the list has nothing that fits', async () => {
    const refused = setupForm({ requestHostAccess: async () => false })
    refused.$<HTMLButtonElement>('#lookup-external-model-price').click()
    expect(refused.$('#external-model-price-status').textContent).toBe('先填写模型名称')
    refused.$<HTMLInputElement>('#external-model-model-name').value = 'gemini-3.8-flash'
    refused.$<HTMLButtonElement>('#lookup-external-model-price').click()
    await vi.waitFor(() => expect(refused.$('#external-model-price-status').textContent).toBe('需要你允许 OpenTeam 访问 openrouter.ai，才能查价格。'))
    expect(refused.fetchPriceList).not.toHaveBeenCalled()

    const { $, choose } = setupForm()
    choose('#external-model-provider', 'qwen')
    $<HTMLInputElement>('#external-model-model-name').value = 'qwen-max'
    $<HTMLButtonElement>('#lookup-external-model-price').click()
    await vi.waitFor(() => expect($('#external-model-price-status').textContent).toBe('价格表里没有找到「qwen-max」，请到服务商官网查价格。'))
  })
})

describe('reading web pages, in the form', () => {
  it('is on for a new model, saved when switched off, and shown as it is when a model is edited', async () => {
    const { store, view, $, choose, runCommand } = setupForm()
    choose('#external-model-provider', 'deepseek')
    $<HTMLInputElement>('#external-model-api-key').value = 'sk-1'
    $<HTMLInputElement>('#external-model-model-name').value = 'deepseek-chat'
    expect($<HTMLInputElement>('#external-model-web-reading').checked).toBe(true)
    $<HTMLInputElement>('#external-model-web-reading').checked = false
    $<HTMLFormElement>('#external-model-form').requestSubmit()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('EXTERNAL_MODEL_CREATE', expect.objectContaining({ webReading: false })))

    store.settings.externalModelOrder = ['m-1']
    store.settings.externalModelsById['m-1'] = { id: 'm-1', name: 'DeepSeek', format: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-1', modelName: 'deepseek-chat', webReading: false, createdAt: 1, updatedAt: 1 }
    view.renderExternalModels()
    ;[...document.querySelectorAll<HTMLButtonElement>('#external-models-list button')].find(button => button.textContent === '编辑')!.click()
    expect($<HTMLInputElement>('#external-model-web-reading').checked).toBe(false)
  })
})

