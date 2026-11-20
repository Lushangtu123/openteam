import type { ExternalModelConfig, ExternalModelFormat, OpenTeamStore } from '../group/types'
import { API_MODEL_PRESETS, listModelNames as fetchModelNames, presetForBaseUrl, type ModelListRequest } from '../shared/apiModelPresets'
import { hasHostAccess, hostAccessLabel, hostAccessPattern, requestHostAccess } from '../shared/hostAccess'
import { normalizeLanguage, translateUi } from '../shared/i18n'
import { modelSpendToday, money } from '../group/spendCap'
import { fetchPriceList, matchModelPrice, PRICE_LIST_URL, type PriceEntry } from '../shared/modelPriceLookup'
import type { LocalAgentInfo } from '../shared/localControlProtocol'

export interface ExternalModelsViewDependencies {
  getStore(): OpenTeamStore
  settingsButtonEl: HTMLButtonElement
  settingsMenuEl: HTMLElement
  openExternalModelsEl: HTMLButtonElement
  closeExternalModelsEl: HTMLButtonElement
  externalModelsModalEl: HTMLElement
  externalModelsListEl: HTMLElement
  externalModelFormEl: HTMLFormElement
  externalModelIdEl: HTMLInputElement
  externalModelNameEl: HTMLInputElement
  externalModelFormatEl: HTMLSelectElement
  externalModelBaseUrlEl: HTMLInputElement
  externalModelApiKeyEl: HTMLInputElement
  externalModelModelNameEl: HTMLInputElement
  resetExternalModelFormEl: HTMLButtonElement
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  testExternalModel(modelId: string): Promise<void>
  // The local agents the daemon offers (for a 本机智能体 model).
  listLocalAgents?(): Promise<LocalAgentInfo[]>
  // Whether OpenTeam may reach an API address, and asking the user to allow it (the browser's own
  // prompt, shown only from a click).
  hasHostAccess?(baseUrl: string): Promise<boolean>
  requestHostAccess?(baseUrl: string): Promise<boolean>
  // The provider's models for the address and key in the form (its /models list).
  listModelNames?(request: ModelListRequest): Promise<string[]>
  // 查价格: OpenRouter's public price list (src/shared/modelPriceLookup.ts).
  fetchPriceList?(): Promise<PriceEntry[]>
  showError(message: string): void
}

export interface ExternalModelsView {
  openExternalModels(): void
  closeExternalModels(): void
  registerExternalModelsEvents(): void
  renderExternalModels(): void
}

export function createExternalModelsView(deps: ExternalModelsViewDependencies): ExternalModelsView {
  const form = deps.externalModelFormEl
  const localAgentEl = form.querySelector<HTMLSelectElement>('#external-model-local-agent')
  const workspaceEl = form.querySelector<HTMLInputElement>('#external-model-workspace')
  const workspacesEl = form.querySelector<HTMLDataListElement>('#external-model-workspaces')
  const remoteWorkspaceEl = form.querySelector<HTMLElement>('#external-model-remote-workspace')
  const priceInputEl = form.querySelector<HTMLInputElement>('#external-model-price-input')
  const priceOutputEl = form.querySelector<HTMLInputElement>('#external-model-price-output')
  const priceCurrencyEl = form.querySelector<HTMLSelectElement>('#external-model-price-currency')
  // 花费上限: at most this much a day, estimated from the price above.
  const dailyCapEl = form.querySelector<HTMLInputElement>('#external-model-daily-cap')
  const dailyCapUnitEl = form.querySelector<HTMLElement>('#external-model-daily-cap-unit')
  const dailyCapTodayEl = form.querySelector<HTMLElement>('#external-model-daily-cap-today')
  const lookupPriceEl = form.querySelector<HTMLButtonElement>('#lookup-external-model-price')
  const priceChoicesEl = form.querySelector<HTMLSelectElement>('#external-model-price-choices')
  const priceStatusEl = form.querySelector<HTMLElement>('#external-model-price-status')
  // Read once a session: it is the same list for every model.
  let priceList: PriceEntry[] | undefined
  let priceCandidates: PriceEntry[] = []
  const localStatusEl = form.querySelector<HTMLElement>('#local-agent-status')
  const localHint = localStatusEl?.textContent ?? ''
  const addButtonEl = form.ownerDocument.querySelector<HTMLButtonElement>('#add-external-model')
  const formTitleEl = form.querySelector<HTMLElement>('#external-model-form-title')
  const providerEl = form.querySelector<HTMLSelectElement>('#external-model-provider')
  const keyLinkEl = form.querySelector<HTMLAnchorElement>('#external-model-key-link')
  const fetchNamesEl = form.querySelector<HTMLButtonElement>('#fetch-external-model-names')
  // Lists of the provider's models, one beside each model field, shown once the list is fetched.
  const nameChoicesEl = form.querySelector<HTMLSelectElement>('#external-model-name-choices')
  const fallbackChoicesEl = form.querySelector<HTMLSelectElement>('#external-model-fallback-choices')
  const namesStatusEl = form.querySelector<HTMLElement>('#external-model-names-status')
  const fallbackNameEl = form.querySelector<HTMLInputElement>('#external-model-fallback-name')
  const defaultModelPlaceholder = deps.externalModelModelNameEl.placeholder
  const listNames = deps.listModelNames ?? fetchModelNames
  // The display name a preset filled in, which the next preset may replace.
  let presetFilledName = ''
  let localAgents: LocalAgentInfo[] = []
  const hasAccess = deps.hasHostAccess ?? hasHostAccess
  const requestAccess = deps.requestHostAccess ?? requestHostAccess

  // The window lists the models; the form opens only to add one or change one, and closes on save or
  // cancel. With no models yet, the form is open from the start.
  function showForm(model?: ExternalModelConfig): void {
    form.hidden = false
    if (addButtonEl) addButtonEl.hidden = true
    if (formTitleEl) formTitleEl.textContent = model ? ui(`修改「${model.name}」`) : ui('添加模型')
    deps.externalModelNameEl.focus()
  }

  function hideForm(): void {
    resetForm()
    form.hidden = listModels().length > 0
    if (addButtonEl) addButtonEl.hidden = !form.hidden
    if (formTitleEl) formTitleEl.textContent = ui('添加模型')
  }

  // A 本机智能体 needs an agent and a folder; an API model needs its address, key and model name.
  function showFieldsForFormat(): void {
    const local = deps.externalModelFormatEl.value === 'local-agent'
    for (const field of form.querySelectorAll<HTMLElement>('.local-agent-field')) field.hidden = !local
    for (const field of form.querySelectorAll<HTMLElement>('.api-model-field')) field.hidden = local
    if (local) void loadLocalAgents()
  }

  async function loadLocalAgents(selectedId?: string): Promise<void> {
    if (!localAgentEl || !deps.listLocalAgents) return
    try {
      localAgents = (await deps.listLocalAgents()).filter(agent => agent.enabled)
      if (localStatusEl) localStatusEl.textContent = localAgents.length ? ui('智能体在本机运行，只能访问它允许的目录。') : ui(localHint)
    } catch (error) {
      localAgents = []
      if (localStatusEl) localStatusEl.textContent = error instanceof Error ? error.message : String(error)
    }
    const keep = selectedId ?? localAgentEl.value
    localAgentEl.replaceChildren(...localAgents.map(agent => {
      const option = document.createElement('option')
      option.value = agent.id
      option.textContent = `${agent.name}（${agent.id}）`
      return option
    }))
    if (keep && localAgents.some(agent => agent.id === keep)) localAgentEl.value = keep
    showWorkspacesForAgent()
  }

  // The folders the chosen agent may work in, offered for the 工作目录 field.
  function showWorkspacesForAgent(): void {
    const agent = localAgents.find(candidate => candidate.id === localAgentEl?.value)
    workspacesEl?.replaceChildren(...(agent?.cwdAllowlist ?? []).map(folder => {
      const option = document.createElement('option')
      option.value = folder
      return option
    }))
    if (workspaceEl && !workspaceEl.value && agent?.cwdAllowlist[0]) workspaceEl.value = agent.cwdAllowlist[0]
    // An agent on another machine works in its own folder there; the folder above is only where its
    // command starts on this Mac.
    if (remoteWorkspaceEl) {
      remoteWorkspaceEl.hidden = !agent?.remoteCwd
      remoteWorkspaceEl.textContent = agent?.remoteCwd
        ? ui(`这个智能体在远程机器上运行，实际在那里的 ${agent.remoteCwd} 里工作（上面的工作目录下的子目录，对应它下面同名的子目录）。`)
        : ''
    }
    if (agent && !deps.externalModelNameEl.value.trim()) deps.externalModelNameEl.value = agent.name
  }

  function fillProviderOptions(): void {
    if (!providerEl) return
    const custom = providerEl.querySelector('option[value=""]')
    providerEl.replaceChildren(...(custom ? [custom] : []), ...API_MODEL_PRESETS.map(preset => {
      const option = document.createElement('option')
      option.value = preset.id
      option.textContent = ui(preset.name)
      return option
    }))
  }

  // Shows the preset the address belongs to (custom for any other) and where to get its key.
  function showProvider(): void {
    const preset = presetForBaseUrl(deps.externalModelBaseUrlEl.value)
    if (providerEl) providerEl.value = preset?.id ?? ''
    if (keyLinkEl) {
      keyLinkEl.hidden = !preset
      if (preset) keyLinkEl.href = preset.keyPage
    }
    deps.externalModelModelNameEl.placeholder = preset?.exampleModel ?? defaultModelPlaceholder
  }

  function choosePreset(): void {
    const preset = API_MODEL_PRESETS.find(candidate => candidate.id === providerEl?.value)
    if (!preset) {
      showProvider()
      return
    }
    deps.externalModelFormatEl.value = preset.format
    deps.externalModelBaseUrlEl.value = preset.baseUrl
    const name = deps.externalModelNameEl.value.trim()
    if (!name || name === presetFilledName) {
      deps.externalModelNameEl.value = ui(preset.name)
      presetFilledName = deps.externalModelNameEl.value
    }
    clearModelNames()
    showProvider()
  }

  function clearModelNames(): void {
    for (const choices of [nameChoicesEl, fallbackChoicesEl]) {
      if (!choices) continue
      choices.replaceChildren()
      choices.hidden = true
    }
    if (namesStatusEl) namesStatusEl.textContent = ''
  }

  // Each list starts with an option that only asks to choose, so every model can be chosen, and
  // goes back to it once a model is put in the field.
  function showModelChoices(names: string[]): void {
    for (const choices of [nameChoicesEl, fallbackChoicesEl]) {
      if (!choices) continue
      const prompt = document.createElement('option')
      prompt.value = ''
      prompt.textContent = ui(choices === nameChoicesEl ? '从列表选择模型' : '从列表选择备用模型')
      choices.replaceChildren(prompt, ...names.map(name => {
        const option = document.createElement('option')
        option.value = name
        option.textContent = name
        return option
      }))
      choices.value = ''
      choices.hidden = false
    }
  }

  function pickFrom(choices: HTMLSelectElement | null, field: HTMLInputElement | null): void {
    if (!choices || !field || !choices.value) return
    field.value = choices.value
    choices.value = ''
  }

  // Asks the provider for its models with the address and key in the form; from a click, so the
  // browser may ask to allow the address.
  async function fetchModelList(): Promise<void> {
    const baseUrl = deps.externalModelBaseUrlEl.value.trim()
    const apiKey = deps.externalModelApiKeyEl.value.trim()
    const format = readFormat()
    if (!baseUrl || !apiKey || format === 'local-agent') {
      if (namesStatusEl) namesStatusEl.textContent = ui('先填写模型地址和 Key')
      return
    }
    const original = fetchNamesEl?.textContent ?? ''
    if (fetchNamesEl) {
      fetchNamesEl.disabled = true
      fetchNamesEl.textContent = ui('获取中')
    }
    try {
      await allowAccess(baseUrl)
      const names = await listNames({ format, baseUrl, apiKey })
      showModelChoices(names)
      if (namesStatusEl) {
        namesStatusEl.textContent = language() === 'en'
          ? `Found ${names.length} models. Choose them from the lists beside the model fields.`
          : `找到 ${names.length} 个模型，可在模型名称和备用模型旁的列表里选择。`
      }
      nameChoicesEl?.focus()
    } catch (error) {
      if (namesStatusEl) namesStatusEl.textContent = ui(error instanceof Error ? error.message : String(error))
    } finally {
      if (fetchNamesEl) {
        fetchNamesEl.disabled = false
        fetchNamesEl.textContent = original
      }
    }
  }

  function registerExternalModelsEvents(): void {
    fillProviderOptions()
    providerEl?.addEventListener('change', choosePreset)
    deps.externalModelBaseUrlEl.addEventListener('input', () => {
      showProvider()
      clearModelNames()
    })
    fetchNamesEl?.addEventListener('click', () => void fetchModelList())
    nameChoicesEl?.addEventListener('change', () => pickFrom(nameChoicesEl, deps.externalModelModelNameEl))
    fallbackChoicesEl?.addEventListener('change', () => pickFrom(fallbackChoicesEl, fallbackNameEl))
    priceCurrencyEl?.addEventListener('change', showCapUnit)
    lookupPriceEl?.addEventListener('click', () => void lookUpPrice())
    priceChoicesEl?.addEventListener('change', () => {
      const entry = priceCandidates.find(candidate => candidate.id === priceChoicesEl.value)
      if (entry) fillPrice(entry)
    })
    deps.externalModelFormatEl.addEventListener('change', showFieldsForFormat)
    localAgentEl?.addEventListener('change', showWorkspacesForAgent)
    deps.openExternalModelsEl.addEventListener('click', openExternalModels)
    deps.closeExternalModelsEl.addEventListener('click', closeExternalModels)
    deps.resetExternalModelFormEl.addEventListener('click', hideForm)
    addButtonEl?.addEventListener('click', () => {
      resetForm()
      showForm()
    })
    deps.externalModelFormEl.addEventListener('submit', event => {
      event.preventDefault()
      saveModel().catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
    })
  }

  function renderExternalModels(): void {
    deps.externalModelsListEl.replaceChildren()
    const models = listModels()
    if (models.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty-card'
      empty.textContent = ui('还没有模型')
      deps.externalModelsListEl.append(empty)
      return
    }

    for (const model of models) deps.externalModelsListEl.append(modelCard(model))
  }

  function modelCard(model: ExternalModelConfig): HTMLElement {
    const card = document.createElement('section')
    card.className = 'template-card'
    const body = document.createElement('div')
    body.className = 'template-card-body'
    const name = document.createElement('div')
    name.className = 'role-name'
    name.textContent = model.name
    const description = document.createElement('div')
    description.className = 'template-description'
    description.textContent = model.format === 'local-agent'
      ? `${ui('本机智能体')} · ${model.localAgentId ?? ''}`
      : `${model.format === 'anthropic' ? 'Anthropic' : 'OpenAI'} · ${model.modelName}${model.fallbackModelName ? ` · ${ui('备用')} ${model.fallbackModelName}` : ''}`
    const baseUrl = document.createElement('div')
    baseUrl.className = 'template-description'
    baseUrl.textContent = model.format === 'local-agent' ? model.workspace ?? '' : model.baseUrl
    body.append(name, description, baseUrl)

    const actions = document.createElement('div')
    actions.className = 'template-card-actions'
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'btn btn-ghost'
    edit.textContent = ui('编辑')
    edit.addEventListener('click', () => {
      fillForm(model)
      showForm(model)
    })
    const test = document.createElement('button')
    test.type = 'button'
    test.className = 'btn btn-ghost'
    test.textContent = ui('测试')
    test.addEventListener('click', () => testModel(model, test))
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'btn btn-ghost model-delete'
    remove.textContent = ui('删除')
    remove.addEventListener('click', () => deleteModel(model))
    actions.append(test, edit, remove)
    card.append(body, actions)
    if (model.format !== 'local-agent') void showAccessNeeded(model, body, actions)
    return card
  }

  // A model whose address OpenTeam may not reach yet (restored from a backup, or added before access
  // was asked per address) says so, with a button to allow it.
  async function showAccessNeeded(model: ExternalModelConfig, body: HTMLElement, actions: HTMLElement): Promise<void> {
    if (await hasAccess(model.baseUrl)) return
    const host = hostAccessLabel(model.baseUrl)
    const notice = document.createElement('div')
    notice.className = 'template-description model-access-needed'
    notice.textContent = language() === 'en' ? `OpenTeam is not allowed to reach ${host} yet, so this model cannot answer.` : `还没有允许 OpenTeam 访问 ${host}，这个模型暂时不能回答。`
    const allow = document.createElement('button')
    allow.type = 'button'
    allow.className = 'btn btn-primary model-allow-access'
    allow.textContent = ui('允许访问')
    allow.addEventListener('click', () => {
      allowAccess(model.baseUrl).then(renderExternalModels).catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
    })
    body.append(notice)
    actions.prepend(allow)
  }

  // Asks for this address alone. Called straight from a click, as the browser requires.
  async function allowAccess(baseUrl: string): Promise<void> {
    if (!hostAccessPattern(baseUrl)) throw new Error(language() === 'en' ? 'The model address must start with https:// or http://' : '模型地址需要以 https:// 或 http:// 开头')
    if (await requestAccess(baseUrl)) return
    const host = hostAccessLabel(baseUrl)
    throw new Error(language() === 'en' ? `OpenTeam needs your permission to reach ${host} before it can use this model.` : `需要你允许 OpenTeam 访问 ${host}，才能使用这个模型。`)
  }

  async function saveModel(): Promise<void> {
    const modelId = deps.externalModelIdEl.value.trim()
    const format = readFormat()
    const payload = format === 'local-agent'
      ? { name: deps.externalModelNameEl.value.trim(), format, localAgentId: localAgentEl?.value ?? '', workspace: workspaceEl?.value.trim() ?? '' }
      : {
          name: deps.externalModelNameEl.value.trim(),
          format,
          baseUrl: deps.externalModelBaseUrlEl.value.trim(),
          apiKey: deps.externalModelApiKeyEl.value.trim(),
          modelName: deps.externalModelModelNameEl.value.trim(),
          fallbackModelName: fallbackNameEl?.value.trim() ?? '',
          // 用量's estimate; both empty removes the price.
          pricing: { input: priceInputEl?.value.trim() ?? '', output: priceOutputEl?.value.trim() ?? '', currency: priceCurrencyEl?.value ?? 'CNY' },
          // Empty removes the cap.
          dailyCap: dailyCapEl?.value.trim() ?? '',
        }
    if (format !== 'local-agent') await allowAccess(deps.externalModelBaseUrlEl.value)
    await deps.runCommand(modelId ? 'EXTERNAL_MODEL_UPDATE' : 'EXTERNAL_MODEL_CREATE', modelId ? { modelId, ...payload } : payload)
    renderExternalModels()
    hideForm()
  }

  function deleteModel(model: ExternalModelConfig): void {
    const message = language() === 'en' ? `Delete the model "${model.name}"?` : `确定删除模型「${model.name}」吗？`
    if (!window.confirm(message)) return
    deps.runCommand('EXTERNAL_MODEL_DELETE', { modelId: model.id })
      .then(() => {
        renderExternalModels()
        hideForm()
      })
      .catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
  }

  async function testModel(model: ExternalModelConfig, button: HTMLButtonElement): Promise<void> {
    const originalText = button.textContent ?? ui('测试')
    button.disabled = true
    button.textContent = ui('测试中')
    try {
      if (model.format !== 'local-agent') await allowAccess(model.baseUrl)
      await deps.testExternalModel(model.id)
      button.textContent = ui('测试通过')
    } catch (error: any) {
      button.textContent = originalText
      const message = error?.friendlyMessage ?? (error instanceof Error ? error.message : String(error))
      deps.showError(message)
    } finally {
      window.setTimeout(() => {
        button.disabled = false
        button.textContent = originalText
      }, 1200)
    }
  }

  // 查价格: the price of the model named in the form, from OpenRouter's list (no key is sent).
  async function lookUpPrice(): Promise<void> {
    clearPriceChoices()
    const name = deps.externalModelModelNameEl.value.trim()
    if (!name) {
      showPriceStatus(ui('先填写模型名称'))
      return
    }
    const original = lookupPriceEl?.textContent ?? ''
    if (lookupPriceEl) {
      lookupPriceEl.disabled = true
      lookupPriceEl.textContent = ui('查询中')
    }
    try {
      if (!priceList) {
        if (!await requestAccess(PRICE_LIST_URL)) {
          showPriceStatus(language() === 'en' ? 'OpenTeam needs your permission to reach openrouter.ai to look up prices.' : '需要你允许 OpenTeam 访问 openrouter.ai，才能查价格。')
          return
        }
        priceList = await (deps.fetchPriceList ?? (() => fetchPriceList()))()
      }
      const match = matchModelPrice(priceList, name, deps.externalModelBaseUrlEl.value)
      if (match.exact) {
        fillPrice(match.exact)
      } else if (match.candidates.length > 0) {
        priceCandidates = match.candidates
        if (priceChoicesEl) {
          priceChoicesEl.replaceChildren(new Option(ui('选择对应的模型…'), ''), ...match.candidates.map(entry => new Option(`${entry.id} · $${entry.input} / $${entry.output}`, entry.id)))
          priceChoicesEl.hidden = false
          priceChoicesEl.focus()
        }
        showPriceStatus(language() === 'en' ? `The price list has no "${name}"; it may be an alias. Choose the model it stands for.` : `价格表里没有「${name}」这个名字，它可能是别名；请选择它对应的模型。`)
      } else {
        showPriceStatus(language() === 'en' ? `"${name}" is not in the price list; look up the price on the provider's site.` : `价格表里没有找到「${name}」，请到服务商官网查价格。`)
      }
    } catch (error) {
      showPriceStatus(ui(error instanceof Error ? error.message : String(error)))
    } finally {
      if (lookupPriceEl) {
        lookupPriceEl.disabled = false
        lookupPriceEl.textContent = original
      }
    }
  }

  // Makers that charge in yuan at home, often at another price than their dollar one.
  const YUAN_MAKERS = ['deepseek/', 'moonshotai/', 'qwen/', 'z-ai/']

  function fillPrice(entry: PriceEntry): void {
    if (priceInputEl) priceInputEl.value = String(entry.input)
    if (priceOutputEl) priceOutputEl.value = String(entry.output)
    if (priceCurrencyEl) priceCurrencyEl.value = 'USD'
    showCapUnit()
    const yuanMaker = YUAN_MAKERS.some(prefix => entry.id.startsWith(prefix))
    showPriceStatus(language() === 'en'
      ? `Filled in the price OpenRouter lists for "${entry.id}" (dollars per million tokens). Check it on the provider's site${yuanMaker ? '; this provider charges in yuan in China, possibly at another price' : ''}; within a free allowance nothing is spent.`
      : `已填入 OpenRouter 列出的「${entry.id}」价格（美元 / 百万 token），以服务商官网为准${yuanMaker ? '；这家在国内按人民币计价，官网价格可能不同' : ''}；用免费额度时实际不花钱。`)
  }

  function showPriceStatus(text: string): void {
    if (priceStatusEl) priceStatusEl.textContent = text
  }

  function clearPriceChoices(): void {
    priceCandidates = []
    if (priceChoicesEl) {
      priceChoicesEl.replaceChildren()
      priceChoicesEl.hidden = true
    }
  }

  // The cap is in the price's currency.
  function showCapUnit(): void {
    if (dailyCapUnitEl) dailyCapUnitEl.textContent = ui(priceCurrencyEl?.value === 'USD' ? '美元 / 天' : '元 / 天')
  }

  // What the model being edited spent today, beside its cap.
  function showSpentToday(model: ExternalModelConfig | undefined): void {
    if (!dailyCapTodayEl) return
    const spent = model?.pricing ? modelSpendToday(deps.getStore(), model.id, Date.now()).spent : 0
    dailyCapTodayEl.hidden = !model?.pricing || spent === 0
    dailyCapTodayEl.textContent = model && !dailyCapTodayEl.hidden ? (language() === 'en' ? `Spent today (estimated): ${money(model, spent)}` : `今天估算已花 ${money(model, spent)}`) : ''
  }

  function fillForm(model: ExternalModelConfig): void {
    deps.externalModelIdEl.value = model.id
    deps.externalModelNameEl.value = model.name
    deps.externalModelFormatEl.value = model.format
    deps.externalModelBaseUrlEl.value = model.baseUrl
    deps.externalModelApiKeyEl.value = model.apiKey
    deps.externalModelModelNameEl.value = model.modelName
    if (fallbackNameEl) fallbackNameEl.value = model.fallbackModelName ?? ''
    if (priceInputEl) priceInputEl.value = model.pricing ? String(model.pricing.input) : ''
    if (priceOutputEl) priceOutputEl.value = model.pricing ? String(model.pricing.output) : ''
    if (priceCurrencyEl) priceCurrencyEl.value = model.pricing?.currency ?? 'CNY'
    if (dailyCapEl) dailyCapEl.value = model.dailyCap !== undefined ? String(model.dailyCap) : ''
    showCapUnit()
    showSpentToday(model)
    clearPriceChoices()
    showPriceStatus('')
    if (workspaceEl) workspaceEl.value = model.workspace ?? ''
    presetFilledName = ''
    clearModelNames()
    showProvider()
    showFieldsForFormat()
    if (model.format === 'local-agent') void loadLocalAgents(model.localAgentId)
  }

  function resetForm(): void {
    deps.externalModelIdEl.value = ''
    deps.externalModelNameEl.value = ''
    deps.externalModelFormatEl.value = 'openai'
    deps.externalModelBaseUrlEl.value = ''
    deps.externalModelApiKeyEl.value = ''
    deps.externalModelModelNameEl.value = ''
    if (fallbackNameEl) fallbackNameEl.value = ''
    if (priceInputEl) priceInputEl.value = ''
    if (priceOutputEl) priceOutputEl.value = ''
    if (priceCurrencyEl) priceCurrencyEl.value = 'CNY'
    if (dailyCapEl) dailyCapEl.value = ''
    showCapUnit()
    showSpentToday(undefined)
    clearPriceChoices()
    showPriceStatus('')
    if (workspaceEl) workspaceEl.value = ''
    presetFilledName = ''
    clearModelNames()
    showProvider()
    showFieldsForFormat()
  }

  function openExternalModels(): void {
    deps.settingsMenuEl.hidden = true
    deps.settingsButtonEl.setAttribute('aria-expanded', 'false')
    deps.externalModelsModalEl.hidden = false
    // In the language chosen now.
    fillProviderOptions()
    renderExternalModels()
    hideForm()
    if (!form.hidden) deps.externalModelNameEl.focus()
    else addButtonEl?.focus()
  }

  function closeExternalModels(): void {
    deps.externalModelsModalEl.hidden = true
  }

  function listModels(): ExternalModelConfig[] {
    const store = deps.getStore()
    return store.settings.externalModelOrder
      .map(modelId => store.settings.externalModelsById[modelId])
      .filter((model): model is ExternalModelConfig => Boolean(model))
  }

  function readFormat(): ExternalModelFormat {
    const value = deps.externalModelFormatEl.value
    return value === 'anthropic' || value === 'local-agent' ? value : 'openai'
  }

  function language() {
    return normalizeLanguage(deps.getStore().settings.language)
  }

  function ui(source: string): string {
    return translateUi(source, language())
  }

  return { openExternalModels, closeExternalModels, registerExternalModelsEvents, renderExternalModels }
}
