// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import { createExternalModelsView } from './externalModelsView'

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
