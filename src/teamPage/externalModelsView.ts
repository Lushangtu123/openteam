import type { ExternalModelConfig, ExternalModelFormat, OpenTeamStore } from '../group/types'
import { normalizeLanguage, translateUi } from '../shared/i18n'
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
  const localStatusEl = form.querySelector<HTMLElement>('#local-agent-status')
  const localHint = localStatusEl?.textContent ?? ''
  let localAgents: LocalAgentInfo[] = []

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
    if (agent && !deps.externalModelNameEl.value.trim()) deps.externalModelNameEl.value = agent.name
  }

  function registerExternalModelsEvents(): void {
    deps.externalModelFormatEl.addEventListener('change', showFieldsForFormat)
    localAgentEl?.addEventListener('change', showWorkspacesForAgent)
    deps.openExternalModelsEl.addEventListener('click', openExternalModels)
    deps.closeExternalModelsEl.addEventListener('click', closeExternalModels)
    deps.resetExternalModelFormEl.addEventListener('click', resetForm)
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
      : `${model.format === 'anthropic' ? 'Anthropic' : 'OpenAI'} · ${model.modelName}`
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
    edit.addEventListener('click', () => fillForm(model))
    const test = document.createElement('button')
    test.type = 'button'
    test.className = 'btn btn-ghost'
    test.textContent = ui('测试')
    test.addEventListener('click', () => testModel(model, test))
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'btn btn-danger'
    remove.textContent = ui('删除')
    remove.addEventListener('click', () => deleteModel(model))
    actions.append(test, edit, remove)
    card.append(body, actions)
    return card
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
        }
    await deps.runCommand(modelId ? 'EXTERNAL_MODEL_UPDATE' : 'EXTERNAL_MODEL_CREATE', modelId ? { modelId, ...payload } : payload)
    resetForm()
    renderExternalModels()
  }

  function deleteModel(model: ExternalModelConfig): void {
    const message = language() === 'en' ? `Delete external model "${model.name}"?` : `确定删除外部模型「${model.name}」吗？`
    if (!window.confirm(message)) return
    deps.runCommand('EXTERNAL_MODEL_DELETE', { modelId: model.id })
      .then(() => {
        resetForm()
        renderExternalModels()
      })
      .catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
  }

  async function testModel(model: ExternalModelConfig, button: HTMLButtonElement): Promise<void> {
    const originalText = button.textContent ?? ui('测试')
    button.disabled = true
    button.textContent = ui('测试中')
    try {
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

  function fillForm(model: ExternalModelConfig): void {
    deps.externalModelIdEl.value = model.id
    deps.externalModelNameEl.value = model.name
    deps.externalModelFormatEl.value = model.format
    deps.externalModelBaseUrlEl.value = model.baseUrl
    deps.externalModelApiKeyEl.value = model.apiKey
    deps.externalModelModelNameEl.value = model.modelName
    if (workspaceEl) workspaceEl.value = model.workspace ?? ''
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
    if (workspaceEl) workspaceEl.value = ''
    showFieldsForFormat()
  }

  function openExternalModels(): void {
    deps.settingsMenuEl.hidden = true
    deps.settingsButtonEl.setAttribute('aria-expanded', 'false')
    deps.externalModelsModalEl.hidden = false
    resetForm()
    renderExternalModels()
    deps.externalModelNameEl.focus()
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
