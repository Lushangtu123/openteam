import { newChatCollaboration } from '../group/collaboration'
import type { GroupChat, GroupMessage, GroupRole, OpenTeamStore, RoleTemplate } from '../group/types'
import type { GeneratedPersonDraft } from '../group/personaGeneration'
import { createDefaultStore } from '../group/store'
import { getAllRoleTemplates } from '../group/roleTemplates'
import { createTeamPageState, pickSelectedChatId } from './appState'
import { createAllNotesView } from './allNotesView'
import { createBackupView } from './backupView'
import { createChatHeaderView } from './chatHeaderView'
import { NARROW_LAYOUT_QUERY, registerChatListDrawer } from './chatListDrawer'
import { createComposerModesView } from './composerModesView'
import { registerHeaderMenus } from './headerMenus'
import { createChatListView } from './chatListView'
import { currentScheduledTasksDialog } from './scheduledTasksDialog'
import { openPollDialog } from './pollDialog'
import { openWebPagesDialog } from './webPagesDialog'
import { openFilePreview } from './filePreviewDialog'
import { currentLibraryDialog, openLibraryDialog } from './libraryDialog'
import { readDocumentText } from './documentText'
import { documentFormat } from '../group/messageUploads'
import { currentUsageDialog, openUsageDialog } from './usageDialog'
import { createComposerAttachments } from './composerAttachments'
import { createComposerView } from './composerView'
import { createTeamPageDomRefs } from './domRefs'
import { createExternalModelsView } from './externalModelsView'
import type { LocalAgentInfo } from '../shared/localControlProtocol'
import { createAiPagesView } from './aiPagesView'
import { createMemberFocusGuard } from './memberFocusGuard'
import { openMemoryDialog } from './memoryDialog'
import { openMemoryPanel } from './memoryPanel'
import { createIframeHost } from './iframeHost'
import { applyTeamLanguage, createLanguageSettingsController } from './languageController'
import { createMessageSearchView } from './messageSearchView'
import { createReplyComparisonView } from './replyComparisonView'
import { createTeamFormationView } from './teamFormationView'
import { createProjectView } from './projectView'
import { createSiteCheckView } from './siteCheckView'
import { createUpdateNotice } from './updateNotice'
import { createBackupReminderView } from './backupReminderView'
import { createWebPageOfferView } from './webPageOfferView'
import { WEB_PAGE_OFFER_KEY } from '../group/webPage'
import { BACKUP_REMINDER_STORAGE_KEY, type BackupReminderState } from '../shared/backupReminder'
import { exportDiagnostics, saveTextFile } from './diagnosticsExport'
import type { RecentLogEntry } from '../shared/logger'
import { UPDATE_CHECK_STORAGE_KEY, type UpdateCheckState } from '../shared/updateCheck'
import { CHAT_SITE_INFO } from '../group/chatSites'
import { createMessagesView } from './messagesView'
import { createNotesView } from './notesView'
import { createPeopleLibraryView } from './peopleLibraryView'
import { createOrchestrationModalView } from './orchestrationModalView'
import { createOrchestrationStatusView } from './orchestrationStatusView'
import { createRoleRecoveryController } from './roleRecoveryController'
import { createRoleHealthTracker } from './roleHealth'
import { createRolePanelView } from './rolePanelView'
import { createTeamPageRuntimeClient, type StorePushMessage } from './runtimeClient'
import { createTeamPagePrimaryCoordinator } from './teamPagePrimary'
import { createErrorPresenter, createSuccessPresenter, teamPageLog } from './teamPageServices'
import { createThemeController } from './themeController'
import { createUiStyleController } from './uiStyleController'
import { registerSettingsWindow } from './settingsWindow'
import { createVoiceInput, speechRecognitionFromWindow } from './voiceInput'
import { replyChoiceAnswer } from '../group/replyChoices'
import { createTeamUiController } from './teamUiController'
import { emptyCard, getChatRecentSummary as getStoreChatRecentSummary, messageTitle, roleAvatarLabel, roleToneClass } from './viewHelpers'
import { agentControlStatusState, agentControlStatusText } from './agentControlStatusView'
import { createIndexedDbImageAttachmentRepository } from '../shared/imageAttachmentRepository'
import { getSafeSupportedChatIframeSrcForRole } from '../group/conversationUrl'
import { normalizeLanguage, translateUi } from '../shared/i18n'
import { createSidePanel, isSidePanel } from './sidePanel'
import { movePanelTools } from './panelTools'
import { createPanelHandover } from './panelHandover'
import { createSiteFaultNotice } from './siteFaultNotice'
import { createSiteCheckDeliveryNotice } from './siteCheckDeliveryNotice'
import { currentWebSearchDialog, openWebSearchDialog } from './webSearchDialog'
import { currentSiteCheckScheduleDialog, openSiteCheckScheduleDialog } from './siteCheckScheduleDialog'
import { PANEL_PORT_NAME } from '../group/runtimeProtocol'
import type { RolePageHealth } from './roleHealth'

const SITE_HEALTH_STATUSES: ReadonlySet<string> = new Set(['ready', 'generating', 'loading', 'error', 'blocked', 'unauthorized'])

const appState = createTeamPageState()
const imageAttachmentRepository = createIndexedDbImageAttachmentRepository()

let store: OpenTeamStore = appState.store

const teamDomRefs = createTeamPageDomRefs()
const { appShellEl, storeSummaryEl, chatListEl, chatTitleEl, chatTitleAvatarEl, chatSubtitleEl, chatStatusEl, messagesEl } = teamDomRefs
const { roleSummaryEl, roleListEl, roleTemplateSelectEl, templateListEl, targetPreviewEl, busyPreviewEl, composerFormEl, sendButtonEl } = teamDomRefs
const { messageInputEl, referenceDraftEl, mentionPanelEl, errorEl, newChatNameEl, createChatFormEl, quickCreateChatEl } = teamDomRefs
const { templateNameEl, templateDescriptionEl, templatePromptEl, templateAiDescriptionEl, generateTemplatePersonaEl, templatePersonaGenerationStatusEl, templateFormTitleEl, settingsButtonEl, settingsMenuEl, languageEnEl, languageZhEl, agentControlToggleEl, agentControlStatusEl, settingsUiStyleChatGptEl, settingsUiStyleGrokEl } = teamDomRefs
const { openAllNotesEl, closeAllNotesEl, allNotesModalEl, allNotesListEl, allNotesActiveTitleEl, allNotesActiveMetaEl, allNotesEditorEl } = teamDomRefs
const { allNoteBoldEl, allNoteItalicEl, allNoteStrikeEl, allNoteBulletListEl, allNoteOrderedListEl, allNoteUndoEl, allNoteRedoEl } = teamDomRefs
const { openPeopleLibraryEl, openExternalModelsEl, openOrchestrationEl, closeOrchestrationEl, orchestrationModalEl, orchestrationAutoModalEl, orchestrationTaskEl, autoOrchestrationEl, openOrchestrationTemplateEl, orchestrationTemplateModalEl, closeOrchestrationTemplateEl, orchestrationTemplateContentEl, closeAutoOrchestrationEl, orchestrationAutoContentEl, orchestrationPeopleListEl, arrangeOrchestrationEl, orchestrationCanvasEl, orchestrationHintEl, orchestrationStageSettingsEl, orchestrationReviewSettingsEl, orchestrationMaxRoundsEl, saveOrchestrationEl, runOrchestrationEl, closeExternalModelsEl, externalModelsModalEl, externalModelsListEl, externalModelFormEl, externalModelIdEl, externalModelNameEl, externalModelFormatEl, externalModelBaseUrlEl, externalModelApiKeyEl, externalModelModelNameEl, resetExternalModelFormEl, closePeopleLibraryEl, peopleLibraryModalEl, personTemplateModalEl, addPersonModalEl, temporaryPersonModalEl } = teamDomRefs
const { notesPanelEl, notesDragHandleEl, notesResizeHandleEl, toggleNotesPanelEl, closeNotesPanelEl, globalNoteTabEl, chatNoteTabEl, notesEditorEl } = teamDomRefs
const { noteBoldEl, noteItalicEl, noteStrikeEl, noteBulletListEl, noteOrderedListEl, noteUndoEl, noteRedoEl } = teamDomRefs
const { peopleLibrarySummaryEl, peopleLibraryListEl, peopleLibraryPaginationEl, peopleLibrarySearchEl, peopleLibraryCategoryFilterEl, peopleLibraryBuiltinTabEl, peopleLibraryCustomTabEl, addLibraryPeopleListEl, addPersonSearchEl, addPersonCategoryFilterEl, addPersonBuiltinTabEl, addPersonCustomTabEl } = teamDomRefs
const { builtinTemplateDetailModalEl, builtinTemplateDetailTitleEl, builtinTemplateDetailMetaEl, builtinTemplateDetailPromptEl, closeBuiltinTemplateDetailEl, newTemplateEl, closePersonTemplateEl, closeAddPersonEl } = teamDomRefs
const { openTemporaryPersonEl, closeTemporaryPersonEl, addRoleFormEl, addLibraryPeopleFormEl, addTemporaryPersonFormEl, peopleLibraryFormEl } = teamDomRefs
const { templateSiteEls, templateSiteExternalEl, templateExternalModelFieldEl, templateExternalModelSelectEl, templateChatGptGptsFieldEl, templateChatGptGptsUrlEl, templateGrokProjectFieldEl, templateGrokProjectUrlEl, temporaryPersonNameEl, temporaryPersonDescriptionEl, temporaryPersonPromptEl } = teamDomRefs
const { togglePeopleDrawerEl, rolePanelEl, returnToTeamEl, showAiPagesEl } = teamDomRefs
const log = teamPageLog
const presentError = createErrorPresenter(errorEl)
// The background answers in Chinese; the toast shows what has an English version in English.
const showError = (message: string) => presentError(translateUi(message, normalizeLanguage(store.settings.language)))
const showSuccess = createSuccessPresenter(errorEl)
const themeController = createThemeController({
  root: document.documentElement,
  // The choice lives in the settings window.
  lightButton: teamDomRefs.settingsThemeLightEl,
  darkButton: teamDomRefs.settingsThemeDarkEl,
})
themeController.initializeTheme()
const uiStyleController = createUiStyleController({
  root: document.documentElement,
  buttons: { chatgpt: [settingsUiStyleChatGptEl], grok: [settingsUiStyleGrokEl] },
})
uiStyleController.initializeStyle()
createVoiceInput({
  button: teamDomRefs.voiceInputEl,
  input: teamDomRefs.messageInputEl as HTMLTextAreaElement,
  language: () => store.settings.language === 'en' ? 'en' : 'zh-CN',
  showError: message => showError(message),
  Recognition: speechRecognitionFromWindow(),
})

let roleHealthRenderPending = false
// OpenTeam in Chrome's side panel (sidePanel.ts): while open, it holds the members' AI pages, which
// keep working there while the user reads another tab; an OpenTeam tab lets them go until it closes.
const inSidePanel = isSidePanel(location.search)
if (inSidePanel) document.body.dataset.view = 'panel'

const roleHealth = createRoleHealthTracker({
  onChange() {
    if (roleHealthRenderPending) return
    roleHealthRenderPending = true
    window.setTimeout(() => {
      roleHealthRenderPending = false
      renderRolePanel()
      renderComposerState()
      languageSettingsController.render()
      teamFormationView.refresh()
    }, 0)
  },
})
const iframeHost = createIframeHost({
  visibleHost: teamDomRefs.iframeHostEl,
  onEvent(event) {
    log.debug(`iframe-host:${event.type}`, event)
    if (event.type === 'role-created' || event.type === 'role-recovered' || event.type === 'role-navigated') roleHealth.frameOpened(event.chatId, event.roleId)
    else if (event.type === 'role-ready') roleHealth.frameConnected(event.chatId, event.roleId)
    else if (event.type === 'role-disposed') roleHealth.frameClosed(event.chatId, event.roleId)
  },
})
const primaryCoordinator = createTeamPagePrimaryCoordinator({
  navigator,
  window,
  onPrimaryChange: handlePrimaryModeChange,
  log,
})
// When the side panel opens, this tab keeps the member pages while a member replies.
const panelHandover = createPanelHandover({
  replying: () => primaryCoordinator.isPrimary() && membersReplying(),
  yieldToPanel: yielding => primaryCoordinator.yieldToPanel(yielding),
  log,
})

const runtimeClient = createTeamPageRuntimeClient({
  getHostTabId: () => appState.hostTabId,
  applyStore,
  refreshStore,
  log,
})
const sendRuntimeMessage = runtimeClient.sendRuntimeMessage
const runCommand = runtimeClient.runCommand
const languageSettingsController = createLanguageSettingsController({
  englishButton: languageEnEl,
  chineseButton: languageZhEl,
  getLanguage: () => store.settings.language,
  runCommand,
  showError,
})
languageSettingsController.render()
async function generatePersona(description: string): Promise<GeneratedPersonDraft> {
  const response = await sendRuntimeMessage('ROLE_TEMPLATE_PERSONA_GENERATE', { description }) as Awaited<ReturnType<typeof sendRuntimeMessage>> & { persona?: GeneratedPersonDraft }
  if (response.ok === false) throw new Error(response.error || 'AI 生成人设失败')
  if (!response.persona) throw new Error('AI 生成人设返回格式无效')
  return response.persona
}

async function testExternalModel(modelId: string): Promise<void> {
  const response = await sendRuntimeMessage('EXTERNAL_MODEL_TEST', { modelId })
  if (response.ok === false) throw new Error(response.error || '外部模型测试失败')
}

let renderComposerState = (): void => {}
let insertMention = (_role: GroupRole): void => {}
let insertTextIntoActiveNote = (_text: string): void => {}
const aiPagesView = createAiPagesView({
  appShellEl,
  returnEl: returnToTeamEl,
  showPagesEl: showAiPagesEl,
  pagesHostEl: teamDomRefs.iframeHostEl,
  homeFocusEl: teamDomRefs.messageInputEl,
})
const showAiPages = aiPagesView.showAiPages
createMemberFocusGuard({
  hostEl: teamDomRefs.iframeHostEl,
  isShowingPages: aiPagesView.isShowingAiPages,
  homeFocusEl: teamDomRefs.messageInputEl,
})
const allNotesView = createAllNotesView({
  openAllNotesEl,
  closeAllNotesEl,
  allNotesModalEl,
  allNotesListEl,
  allNotesActiveTitleEl,
  allNotesActiveMetaEl,
  allNotesEditorEl,
  noteToolbarButtons: {
    bold: allNoteBoldEl,
    italic: allNoteItalicEl,
    strike: allNoteStrikeEl,
    bulletList: allNoteBulletListEl,
    orderedList: allNoteOrderedListEl,
    undo: allNoteUndoEl,
    redo: allNoteRedoEl,
  },
  getStore: () => store,
  getCurrentChat,
  runCommand,
  showError,
})
const renderAllNotes = allNotesView.renderAllNotes
const registerAllNotesEvents = allNotesView.registerAllNotesEvents
const rolePanelView = createRolePanelView({
  state: appState,
  getStore: () => store,
  rolePanelEl,
  roleSummaryEl,
  roleListEl,
  iframeHost,
  getCurrentChat,
  getCurrentRoles,
  emptyCard,
  insertMention: role => inSidePanel ? pickMember(role) : insertMention(role),
  refreshCurrentChat: () => roleRecoveryController.refreshCurrentChat(),
  focusRoleFrame: (chatId, roleId) => showMemberPage(chatId, roleId),
  // In the side panel the member list covers the message box: choosing a member there @-mentions it.
  onSelectRole: inSidePanel ? role => pickMember(role) : undefined,
  runCommand,
  showError,
  getRoleHealth: role => pageHealth(role),
  openRoleSite: role => {
    chrome.tabs.create({ url: getSafeSupportedChatIframeSrcForRole(undefined, role), active: true })
      .catch(error => showError(error instanceof Error ? error.message : String(error)))
  },
})
const renderRolePanel = rolePanelView.renderRolePanel
const chatHeaderView = createChatHeaderView({
  state: appState,
  chatTitleEl,
  chatTitleAvatarEl,
  chatSubtitleEl,
  chatStatusEl,
  togglePeopleDrawerEl,
  openOrchestrationEl,
  workflowMenuWrapEl: teamDomRefs.workflowMenuWrapEl,
  moreMenuWrapEl: teamDomRefs.moreMenuWrapEl,
  getLanguage: () => store.settings.language,
  getCurrentChat,
  getCurrentRoles,
  getCurrentMessages,
})
const composerModesView = createComposerModesView({
  composerFormEl: teamDomRefs.composerFormEl,
  modesEl: teamDomRefs.composerModesEl,
  replyAllToggleEl: teamDomRefs.replyAllToggleEl,
  styleToggleEl: teamDomRefs.collaborationStyleToggleEl,
  styleMenuEl: teamDomRefs.collaborationStyleMenuEl,
  messageInputEl: teamDomRefs.messageInputEl as HTMLTextAreaElement,
  getLanguage: () => store.settings.language,
  getCurrentChat,
  runCommand,
  showError: message => showError(message),
})
composerModesView.register()
const renderChatHeader = () => {
  chatHeaderView.renderChatHeader()
  composerModesView.render()
}
const chatListView = createChatListView({
  state: appState,
  getStore: () => store,
  applyStore,
  storeSummaryEl,
  chatListEl,
  chatListSearchBoxEl: teamDomRefs.chatListSearchBoxEl,
  chatListSearchEl: teamDomRefs.chatListSearchEl,
  iframeHost,
  getTemplates,
  getChatRecentSummary: chat => getStoreChatRecentSummary(chat, store),
  roleToneClass,
  roleAvatarLabel,
  emptyCard,
  renderSelectedChat,
  renderRolePanel,
  sendRuntimeMessage,
  runCommand,
  log,
  showError,
  openLibrary: chatId => openLibrary(chatId),
})
const renderChatList = chatListView.renderChatList
const switchChat = chatListView.switchChat
const roleRecoveryController = createRoleRecoveryController({
  state: appState,
  getStore: () => store,
  getCurrentRoles,
  refreshStore,
  switchChat,
  renderComposerState: () => renderComposerState(),
  showAiPages,
  iframeHost,
  runCommand,
  showError,
  log,
})
const notifyRoleReadyWaiters = roleRecoveryController.notifyRoleReadyWaiters
const reconnectRolesForSend = roleRecoveryController.reconnectRolesForSend
// In the side panel, choosing a member in the member list: it is @-mentioned in the message box,
// and the list, which covers that box, closes. (Its AI page is in the card's menu, 查看网页.)
function pickMember(role: GroupRole): void {
  appState.peopleDrawerOpen = false
  render()
  insertMention(role)
}

// A member's AI page: here, where this page holds them; else (a side panel while another holds
// them) in the OpenTeam tab (sidePanel.ts).
function showMemberPage(chatId: string, roleId: string | undefined): void {
  if (!inSidePanel || primaryCoordinator.isPrimary()) return roleRecoveryController.focusRoleFrame(chatId, roleId)
  if (roleId) void sidePanel?.showMemberPage(chatId, roleId)
}
const resyncMessageReply = roleRecoveryController.resyncMessageReply
const retryRoleReply = roleRecoveryController.retryRoleReply
const stopRoleReply = roleRecoveryController.stopRoleReply
const composerAttachments = createComposerAttachments({
  trayEl: teamDomRefs.attachmentTrayEl,
  attachButtonEl: teamDomRefs.attachFileEl,
  fileInputEl: teamDomRefs.attachFileInputEl,
  pasteTargetEl: messageInputEl,
  dropTargetEl: composerFormEl,
  ui: source => translateUi(source, normalizeLanguage(store.settings.language)),
  showError,
  onChange: () => renderComposerState(),
  previewFile: (file, save) => openFilePreview(file, { english: normalizeLanguage(store.settings.language) === 'en', onClose: () => messageInputEl.focus(), onSave: save }),
})
const composerView = createComposerView({
  onSourcesUsed: () => renderSourcesToggle(),
  state: appState,
  composerFormEl,
  targetPreviewEl,
  busyPreviewEl,
  sendButtonEl,
  messageInputEl,
  referenceDraftEl,
  mentionPanelEl,
  getStore: () => store,
  getCurrentChat,
  getCurrentRoles,
  reconnectRolesForSend,
  runCommand,
  showError,
  getRoleHealth: role => pageHealth(role),
  localize: root => applyTeamLanguage(normalizeLanguage(store.settings.language), root),
  attachments: composerAttachments,
})
renderComposerState = composerView.renderComposerState
insertMention = composerView.insertMention
const registerComposerEvents = composerView.registerComposerEvents
const setReference = composerView.setReference
const notesView = createNotesView({
  state: appState,
  notesPanelEl,
  notesDragHandleEl,
  notesResizeHandleEl,
  toggleNotesPanelEl,
  closeNotesPanelEl,
  globalNoteTabEl,
  chatNoteTabEl,
  notesEditorEl,
  noteToolbarButtons: {
    bold: noteBoldEl,
    italic: noteItalicEl,
    strike: noteStrikeEl,
    bulletList: noteBulletListEl,
    orderedList: noteOrderedListEl,
    undo: noteUndoEl,
    redo: noteRedoEl,
  },
  getStore: () => store,
  getCurrentChat,
  runCommand,
  showError,
})
const renderNotes = notesView.renderNotes
const registerNotesEvents = notesView.registerNotesEvents
insertTextIntoActiveNote = notesView.insertTextIntoActiveNote
const peopleLibraryView = createPeopleLibraryView({
  state: appState,
  getStore: () => store,
  settingsButtonEl,
  settingsMenuEl,
  openPeopleLibraryEl,
  closePeopleLibraryEl,
  peopleLibraryModalEl,
  personTemplateModalEl,
  addPersonModalEl,
  temporaryPersonModalEl,
  peopleLibrarySummaryEl,
  peopleLibraryListEl,
  peopleLibraryPaginationEl,
  peopleLibrarySearchEl,
  peopleLibraryCategoryFilterEl,
  peopleLibraryBuiltinTabEl,
  peopleLibraryCustomTabEl,
  addLibraryPeopleListEl,
  addPersonSearchEl,
  addPersonCategoryFilterEl,
  addPersonBuiltinTabEl,
  addPersonCustomTabEl,
  builtinTemplateDetailModalEl,
  builtinTemplateDetailTitleEl,
  builtinTemplateDetailMetaEl,
  builtinTemplateDetailPromptEl,
  closeBuiltinTemplateDetailEl,
  roleTemplateSelectEl,
  templateListEl,
  templateNameEl,
  templateDescriptionEl,
  templatePromptEl,
  templateAiDescriptionEl,
  generateTemplatePersonaEl,
  templatePersonaGenerationStatusEl,
  templateFormTitleEl,
  templateSiteEls,
  templateSiteExternalEl,
  templateExternalModelFieldEl,
  templateExternalModelSelectEl,
  templateChatGptGptsFieldEl,
  templateChatGptGptsUrlEl,
  templateGrokProjectFieldEl,
  templateGrokProjectUrlEl,
  temporaryPersonNameEl,
  temporaryPersonDescriptionEl,
  temporaryPersonPromptEl,
  newTemplateEl,
  closePersonTemplateEl,
  closeAddPersonEl,
  openTemporaryPersonEl,
  closeTemporaryPersonEl,
  addRoleFormEl,
  addLibraryPeopleFormEl,
  addTemporaryPersonFormEl,
  peopleLibraryFormEl,
  getCurrentChat,
  getTemplates,
  emptyCard,
  generatePersona,
  runCommand,
  showError,
  log,
})
const externalModelsView = createExternalModelsView({
  getStore: () => store,
  listLocalAgents: async () => {
    const response = await sendRuntimeMessage<unknown>('LOCAL_AGENT_LIST', {}) as { ok?: boolean; error?: string; agents?: unknown }
    if (response.ok === false) throw new Error(response.error ?? '没有拿到本机智能体列表')
    return Array.isArray(response.agents) ? response.agents as LocalAgentInfo[] : []
  },
  settingsButtonEl,
  settingsMenuEl,
  openExternalModelsEl,
  closeExternalModelsEl,
  externalModelsModalEl,
  externalModelsListEl,
  externalModelFormEl,
  externalModelIdEl,
  externalModelNameEl,
  externalModelFormatEl,
  externalModelBaseUrlEl,
  externalModelApiKeyEl,
  externalModelModelNameEl,
  resetExternalModelFormEl,
  runCommand,
  testExternalModel,
  showError,
})
const renderExternalModels = externalModelsView.renderExternalModels
const openExternalModels = externalModelsView.openExternalModels
const closeExternalModels = externalModelsView.closeExternalModels
const registerExternalModelsEvents = externalModelsView.registerExternalModelsEvents
const orchestrationModalView = createOrchestrationModalView({
  openOrchestrationEl,
  orchestrationModalEl,
  orchestrationAutoModalEl,
  closeOrchestrationEl,
  orchestrationTaskEl,
  autoOrchestrationEl,
  openOrchestrationTemplateEl,
  orchestrationTemplateModalEl,
  closeOrchestrationTemplateEl,
  orchestrationTemplateContentEl,
  closeAutoOrchestrationEl,
  orchestrationAutoContentEl,
  orchestrationPeopleListEl,
  arrangeOrchestrationEl,
  orchestrationCanvasEl,
  orchestrationHintEl,
  orchestrationStageSettingsEl,
  orchestrationReviewSettingsEl,
  orchestrationMaxRoundsEl,
  saveOrchestrationEl,
  runOrchestrationEl,
  getStore: () => store,
  applyStore,
  getCurrentChat,
  getCurrentRoles,
  reconnectRolesForSend,
  sendRuntimeMessage,
  runCommand,
  openExternalModels,
  showError,
  showSuccess,
})
const registerOrchestrationEvents = orchestrationModalView.registerOrchestrationEvents
const renderOrchestrationModal = orchestrationModalView.render
const orchestrationStatusView = createOrchestrationStatusView({
  getStore: () => store,
  getCurrentChat,
  getCurrentRoles,
  reconnectRolesForSend,
  runCommand,
  showError,
})
const renderTemplates = peopleLibraryView.renderTemplates
const renderAddPersonDialog = peopleLibraryView.renderAddPersonDialog
const openAddPersonDialog = peopleLibraryView.openAddPersonDialog
const closePeopleModals = peopleLibraryView.closePeopleModals
const registerPeopleLibraryEvents = peopleLibraryView.registerPeopleLibraryEvents
const messagesView = createMessagesView({
  state: appState,
  requestSiteAccess: patterns => chrome.permissions.request({ origins: patterns }),
  getStore: () => store,
  messagesEl,
  getCurrentChat,
  getCurrentRoles,
  getCurrentMessages,
  emptyCard,
  openAddPersonDialog,
  // teamUiController is created further down; this runs only on a click.
  startNewChat: kind => teamUiController.startNewChat(kind),
  openSiteLogin: site => {
    chrome.tabs.create({ url: CHAT_SITE_INFO[site].homeUrl }).catch(error => showError(error instanceof Error ? error.message : String(error)))
  },
  startSiteCheck: () => startSiteCheck(),
  messageTitle,
  focusRoleFrame: showMemberPage,
  insertMention,
  setReference,
  editAndResend: message => composerView.editMessage(message),
  saveToLibrary: (message, button) => void saveMessageToLibrary(message, button),
  saveFileToLibrary: file => saveFileToLibrary(file),
  rememberMessage: (message, opener) => openMemoryDialog({ message, chatId: message.chatId }, { getStore: () => store, runCommand, onClose: () => { if (opener.isConnected) opener.focus() } }),
  adoptSummary: (message, opener) => openMemoryDialog({ message, adopt: true, chatId: message.chatId }, { getStore: () => store, runCommand, onClose: () => { if (opener.isConnected) opener.focus() } }),
  rememberProposal: (message, proposal, opener) => openMemoryDialog({ message, proposal, chatId: message.chatId }, { getStore: () => store, runCommand, onClose: () => { if (opener.isConnected) opener.focus() } }),
  answerChoice: (role, choice) => {
    composerView.sendToRole(role, replyChoiceAnswer(choice, store.settings.language === 'en' ? 'en' : 'zh-CN'))
      .catch(error => showError(error instanceof Error ? error.message : String(error)))
  },
  insertTextIntoActiveNote,
  resyncMessageReply,
  retryRoleReply,
  stopRoleReply,
  loadImageAttachment: id => imageAttachmentRepository.get(id),
  runCommand,
  render,
  showError,
  showSuccess,
  renderOrchestrationStatus: orchestrationStatusView.renderOrchestrationStatus,
  openReplyComparison: questionId => replyComparisonView.open(questionId),
  renderTeamFormationStatus: chat => teamFormationView.statusBanner(chat),
  isTeamInvitation: (chat, messageId) => teamFormationView.isInvitation(chat, messageId),
  openTeamCard: chatId => teamFormationView.openCard(chatId),
  renderTeamClaim: message => teamFormationView.renderClaim(message),
  renderProjectBoard: (chat, messages) => projectView.renderBoard(chat, messages),
  renderSiteCheck: chat => siteCheckView.renderBoard(chat),
  log,
})
const renderMessages = messagesView.renderMessages
const teamUiController = createTeamUiController({
  state: appState,
  getNewChatCollaboration: () => newChatCollaboration(store.settings),
  settingsButtonEl,
  settingsMenuEl,
  quickCreateChatEl,
  createChatFormEl,
  newChatNameEl,
  togglePeopleDrawerEl,
  rolePanelEl,
  iframeHost,
  getLanguage: () => store.settings.language,
  getCurrentChat,
  getCurrentRoles,
  getSelectedLoginSite: () => store.rolesById[appState.selectedRoleId ?? '']?.chatSite ?? store.settings.defaultChatSite,
  render,
  renderChatList,
  renderRolePanel,
  renderAddPersonDialog,
  closePeopleModals,
  closeExternalModels,
  registerComposerEvents,
  registerPeopleLibraryEvents,
  registerExternalModelsEvents,
  runCommand,
  showError,
  openTeamFormation: () => teamFormationView.openSetup(),
  log,
})
const registerUi = teamUiController.registerUi

async function resolveHostTabId(): Promise<void> {
  const tab = await chrome.tabs.getCurrent()
  appState.hostTabId = tab?.id
  log.info('host-tab:resolved', { hostTabId: appState.hostTabId, url: tab?.url })
  iframeHost.setHostTabId(appState.hostTabId)
}

async function refreshStore(showFailure = true): Promise<void> {
  try {
    const response = await sendRuntimeMessage('GROUP_STORE_GET')
    if (response.ok === false) throw new Error(response.error || '读取群聊数据失败')
    if (response.controlStatus) appState.controlStatus = response.controlStatus
    applyStore(response.store ?? createDefaultStore())
  } catch (error) {
    applyStore(createDefaultStore())
    if (showFailure) showError(error instanceof Error ? error.message : String(error))
  }
}

function applyStore(nextStore: OpenTeamStore): void {
  appState.store = nextStore
  store = appState.store
  appState.selectedChatId = pickSelectedChatId(appState)
  const roles = getCurrentRoles()
  if (!appState.selectedRoleId || !roles.some(role => role.id === appState.selectedRoleId)) appState.selectedRoleId = roles[0]?.id
  if (appState.selectedReference && appState.selectedReference.messageId && !getCurrentMessages().some(message => message.id === appState.selectedReference?.messageId)) {
    appState.selectedReference = undefined
  }
  syncIframeHost()
  render()
  notifyRoleReadyWaiters()
  panelHandover.storeChanged()
}

// A web member is writing a reply.
function membersReplying(): boolean {
  return Object.values(store.rolesById).some(role => role.modelSource !== 'external' && role.status === 'thinking')
}

// In the side panel, before the OpenTeam tab has handed over the member pages (panelHandover.ts).
function renderPanelHandoverNote(): void {
  const note = teamDomRefs.panelHandoverNoteEl
  note.hidden = !(inSidePanel && !primaryCoordinator.isPrimary() && membersReplying())
  note.textContent = translateUi('成员正在 OpenTeam 标签页里写回复，写完后由侧边栏接手', normalizeLanguage(store.settings.language))
}

function getCurrentChat(): GroupChat | undefined {
  return appState.selectedChatId ? store.chatsById[appState.selectedChatId] : undefined
}

function getCurrentRoles(): GroupRole[] {
  const chat = getCurrentChat()
  if (!chat) return []
  return chat.roleIds.map(roleId => store.rolesById[roleId]).filter((role): role is GroupRole => Boolean(role))
}

function getCurrentMessages(): GroupMessage[] {
  const chat = getCurrentChat()
  if (!chat) return []
  return chat.messageIds.map(messageId => store.messagesById[messageId]).filter((message): message is GroupMessage => Boolean(message))
}

function getTemplates(): RoleTemplate[] {
  return getAllRoleTemplates(store)
}

function syncIframeHost(): void {
  if (!primaryCoordinator.isPrimary()) {
    iframeHost.setEnabled(false)
    return
  }

  const chat = getCurrentChat()
  if (!chat) return
  iframeHost.setEnabled(true)
  const roles = getCurrentRoles()
  const siteRoles = roles.filter(role => role.modelSource !== 'external')
  log.debug('iframe-sync:activate-chat', {
    chatId: chat.id,
    roleIds: siteRoles.map(role => role.id),
    roleStatuses: roles.map(role => ({ id: role.id, name: role.name, status: role.status, conversationUrl: role.geminiConversationUrl })),
  })
  iframeHost.activateChat({ ...chat, roleIds: siteRoles.map(role => role.id) }, siteRoles)
}

function handlePrimaryModeChange(isPrimary: boolean, reason?: 'yielded'): void {
  iframeHost.setEnabled(isPrimary)
  document.body.dataset.teamPagePrimary = String(isPrimary)
  if (isPrimary) {
    log.info('team-page-primary:enabled', { hostTabId: appState.hostTabId, panel: inSidePanel })
    syncIframeHost()
    render()
    return
  }

  log.warn('team-page-primary:passive', { hostTabId: appState.hostTabId, panel: inSidePanel, reason })
  render()
  // Letting the side panel hold the member pages is expected; so is a second panel (another window).
  if (reason === 'yielded' || inSidePanel) return
  showError('已检测到另一个 OpenTeam 页面正在运行。当前页面已暂停 AI iframe，避免两个页面同时加载导致卡死。')
}

// 网站自检: the background makes the group, opens it and sends the question.
function startSiteCheck(): void {
  runCommand('GROUP_SITE_CHECK_START').catch(error => showError(error instanceof Error ? error.message : String(error)))
}

// 投票: a vote needs at least two members to vote.
teamDomRefs.startPollEl.addEventListener('click', () => {
  const chat = getCurrentChat()
  if (chat) openPollDialog(chat.id, { getStore: () => store, runCommand, showError, onClose: () => teamDomRefs.startPollEl.focus() })
})

// 用量 (usageDialog.ts).
teamDomRefs.openUsageEl.addEventListener('click', () => {
  openUsageDialog({
    getStore: () => store,
    async refreshBalances() {
      const response = await sendRuntimeMessage('USAGE_BALANCES_REFRESH') as { ok?: boolean; error?: string; errors?: Array<{ label: string; error: string }> }
      if (response.ok === false) throw new Error(response.error || '没读到余额')
      return { errors: response.errors }
    },
    liftSpendCap: modelId => runCommand('MODEL_SPEND_CAP_LIFT', { modelId }),
    onClose: () => teamDomRefs.openUsageEl.focus(),
  })
})

// 附上网页 from the tabs open in this window (webPagesDialog.ts).
teamDomRefs.attachPagesEl.addEventListener('click', () => {
  void openWebPagesDialog({
    english: normalizeLanguage(store.settings.language) === 'en',
    listTabs: async () => (await chrome.tabs.query({ currentWindow: true })).flatMap(tab => tab.id !== undefined && tab.url ? [{ id: tab.id, url: tab.url, title: tab.title ?? '' }] : []),
    requestAccess: patterns => chrome.permissions.request({ origins: patterns }),
    async readPages(tabs) {
      const response = await sendRuntimeMessage('WEB_PAGES_READ', { tabs }) as { ok?: boolean; error?: string; upload?: { fileName: string; mimeType: string; text: string }; failed?: Array<{ title: string; reason: string }> }
      if (response.ok === false || !response.upload) throw new Error(response.error || '没有读到网页')
      return { upload: response.upload, failed: response.failed }
    },
    addFile: file => {
      composerAttachments.addFiles([file])
      messageInputEl.focus()
    },
    showError,
    onClose: () => { if (!teamDomRefs.attachPagesEl.hidden && document.activeElement === document.body) teamDomRefs.attachPagesEl.focus() },
  })
})

// 群资料库 (libraryDialog.ts, src/group/groupLibrary.ts).
function openLibrary(chatId: string): void {
  const english = () => normalizeLanguage(store.settings.language) === 'en'
  openLibraryDialog(chatId, {
    getStore: () => store,
    runCommand,
    async request(type, payload) {
      const response = await sendRuntimeMessage(type, payload) as Record<string, unknown> & { ok?: boolean; error?: string }
      if (response.ok === false) throw new Error(response.error || translateUi('操作失败', normalizeLanguage(store.settings.language)))
      return response
    },
    readFile: readLibraryFile,
    pickPages: () => new Promise((resolve, reject) => {
      let picked = false
      let readPages: Array<{ title: string; url: string; text: string }> = []
      openWebPagesDialog({
        english: english(),
        listTabs: async () => (await chrome.tabs.query({ currentWindow: true })).flatMap(tab => tab.id !== undefined && tab.url ? [{ id: tab.id, url: tab.url, title: tab.title ?? '' }] : []),
        requestAccess: patterns => chrome.permissions.request({ origins: patterns }),
        async readPages(tabs) {
          const response = await sendRuntimeMessage('WEB_PAGES_READ', { tabs }) as { ok?: boolean; error?: string; upload?: { fileName: string; mimeType: string; text: string }; pages?: Array<{ title: string; url: string; text: string }>; failed?: Array<{ title: string; reason: string }> }
          if (response.ok === false || !response.upload) throw new Error(response.error || '没有读到网页')
          readPages = response.pages ?? []
          return { upload: response.upload, failed: response.failed }
        },
        // Each page a document of its own, with its address (the attachment is all of them in one).
        addFile: () => {
          picked = true
          resolve(readPages.filter(page => page.text).map(page => ({ title: page.title, source: page.url, text: page.text })))
        },
        showError,
        onClose: () => { if (!picked) resolve(undefined) },
      }).catch(reject)
    }),
    previewText: (title, text) => openFilePreview({ fileName: /\.[a-z0-9]+$/i.test(title) ? title : `${title}.md`, text }, { english: english() }),
  })
}

// A file's text for the library: PDF and Office files read, a text file as it is (2 MB at most).
async function readLibraryFile(file: File): Promise<string> {
  if (documentFormat(file.name)) {
    return readDocumentText(file, {
      pageLabel: page => translateUi(`—— 第 ${page} 页 ——`, normalizeLanguage(store.settings.language)),
      sheetLabel: name => translateUi(`—— 工作表：${name} ——`, normalizeLanguage(store.settings.language)),
    })
  }
  if (file.size > 2 * 1024 * 1024) throw new Error(`文件太大：${file.name}（文本文件最多 2 MB）`)
  return file.text()
}

async function saveMessageToLibrary(message: GroupMessage, button: HTMLButtonElement): Promise<void> {
  const speaker = message.type === 'user' ? translateUi('我', normalizeLanguage(store.settings.language)) : message.roleName ?? ''
  const firstLine = message.content.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 40)
  button.disabled = true
  try {
    await runCommand('LIBRARY_ADD', { chatId: message.chatId, doc: { title: `${speaker}：${firstLine}`, kind: 'message', source: message.id, text: message.content } })
    showSuccess(translateUi('已存入资料库', normalizeLanguage(store.settings.language)))
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error))
  } finally {
    button.disabled = false
  }
}

// An attached file, from its preview; resolves to why it was not kept, if it was not.
async function saveFileToLibrary(file: { fileName: string; text: string }): Promise<string | undefined> {
  const chatId = appState.selectedChatId
  if (!chatId) return translateUi('先打开一个群聊', normalizeLanguage(store.settings.language))
  try {
    await runCommand('LIBRARY_ADD', { chatId, doc: { title: file.fileName, kind: 'file', source: file.fileName, text: file.text } })
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function renderPollButton(): void {
  teamDomRefs.attachPagesEl.hidden = !getCurrentChat()
  teamDomRefs.startPollEl.hidden = !getCurrentChat() || getCurrentRoles().length < 2
  renderSourcesToggle()
}

// 要来源: for the next message only.
teamDomRefs.sourcesToggleEl.addEventListener('click', () => {
  appState.wantSources = !appState.wantSources
  renderSourcesToggle()
})

function renderSourcesToggle(): void {
  teamDomRefs.sourcesToggleEl.hidden = !getCurrentChat() || getCurrentRoles().length === 0
  teamDomRefs.sourcesToggleEl.setAttribute('aria-checked', String(appState.wantSources === true))
}

function render(): void {
  renderSelectedChat()
  renderPollButton()
  // In the language chosen now.
  updateNotice.render()
  backupReminderView.render()
  siteFaultNotice.render()
  siteCheckDeliveryNotice.render()
  webPageOfferView.render()
  renderPanelHandoverNote()
  replyComparisonView.refresh()
  teamFormationView.refresh()
  currentScheduledTasksDialog()?.refresh()
  currentLibraryDialog()?.refresh()
  currentSiteCheckScheduleDialog()?.refresh()
  currentWebSearchDialog()?.refresh()
  currentUsageDialog()?.refresh()
  renderTemplates()
  renderAgentControlSettings()
  renderReplyNotificationSettings()
  if (!externalModelsModalEl.hidden) renderExternalModels()
  if (!orchestrationModalEl.hidden) renderOrchestrationModal()
  renderAddPersonDialog()
  if (!allNotesModalEl.hidden) renderAllNotes()
  languageSettingsController.render()
}

// On/off settings that are on unless set to false, each with its switch in the settings menu.
const REPLY_SETTING_TOGGLES = [
  { key: 'replyNotifications', element: () => teamDomRefs.replyNotificationsToggleEl },
  { key: 'replyKeyPoints', element: () => teamDomRefs.replyKeyPointsToggleEl },
  { key: 'roundSummary', element: () => teamDomRefs.roundSummaryToggleEl },
] as const

function renderReplyNotificationSettings(): void {
  for (const toggle of REPLY_SETTING_TOGGLES) renderSettingSwitch(toggle.element(), store.settings[toggle.key] !== false)
  // Off unless switched on, unlike the ones above.
  renderSettingSwitch(teamDomRefs.memoryProposalsToggleEl, store.settings.memoryProposals === true)
}

// A switch in the settings window; its row's title names it.
function renderSettingSwitch(element: HTMLButtonElement, on: boolean): void {
  element.setAttribute('aria-checked', String(on))
}

function registerReplyNotificationSettings(): void {
  for (const toggle of REPLY_SETTING_TOGGLES) {
    toggle.element().addEventListener('click', () => {
      runCommand('GROUP_SETTINGS_UPDATE', {
        [toggle.key]: store.settings[toggle.key] === false,
      }).catch(error => showError(error instanceof Error ? error.message : String(error)))
    })
  }
}

function registerMemoryProposalSetting(): void {
  teamDomRefs.memoryProposalsToggleEl.addEventListener('click', () => {
    runCommand('GROUP_SETTINGS_UPDATE', { memoryProposals: store.settings.memoryProposals !== true })
      .catch(error => showError(error instanceof Error ? error.message : String(error)))
  })
}

function renderAgentControlSettings(): void {
  renderSettingSwitch(agentControlToggleEl, store.settings.agentControlEnabled)
  agentControlStatusEl.dataset.controlState = agentControlStatusState(store, appState.controlStatus)
  agentControlStatusEl.textContent = agentControlStatusText(store, appState.controlStatus)
}

function registerAgentControlSettings(): void {
  agentControlToggleEl.addEventListener('click', () => {
    runCommand('GROUP_SETTINGS_UPDATE', {
      agentControlEnabled: !store.settings.agentControlEnabled,
    }).catch(error => showError(error instanceof Error ? error.message : String(error)))
  })
}

function renderSelectedChat(): void {
  renderChatList()
  renderChatHeader()
  renderMessages()
  renderComposerState()
  renderRolePanel()
  renderNotes()
}

function registerRuntimePush(): void {
  chrome.runtime.onMessage.addListener((message: StorePushMessage, sender, sendResponse) => handlePush(message, sender, sendResponse))
}

// News from the background (and from member pages): over runtime messages, and in the side panel
// also over its port.
function handlePush(message: StorePushMessage, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void): boolean {
  {
    if (!message || typeof message.type !== 'string') return false
    if (message.type === 'TEAM_PANEL_PRESENCE') {
      if (!inSidePanel) panelHandover.panelChanged(message.open)
      return false
    }
    if (message.type === 'TEAM_ROLE_FOCUS') {
      if (!inSidePanel && primaryCoordinator.isPrimary()) showMemberPage(message.chatId, message.roleId)
      return false
    }
    if (message.type === 'TEAM_SITE_STATUS_UPDATE') recordSiteStatus(message, sender)
    if (message.type === 'GROUP_ROLE_RECOVERY_REQUEST') {
      handleRoleRecoveryRequest(message, sendResponse)
      return true
    }
    if (message.type === 'GROUP_CONTROL_STATUS_UPDATED') {
      appState.controlStatus = message.controlStatus
      renderAgentControlSettings()
      languageSettingsController.render()
      return false
    }
    if (orchestrationModalView.handleRuntimeMessage(message)) return false
    if (message.type === 'TEAM_FRAME_ROLE_READY') iframeHost.markRoleReady(message.chatId, message.roleId)
    if (message.type === 'GROUP_STORE_UPDATED' && message.storeSync) {
      const syncedStore = runtimeClient.receiveStorePush(message.storeSync)
      if (syncedStore) applyStore(syncedStore)
    } else if ('store' in message && message.store) {
      applyStore(message.store)
    } else if (message.type.startsWith('GROUP_') || message.type.startsWith('TEAM_')) {
      refreshStore(false).catch(error => log.warn('runtime-push:refresh-failed', { type: message.type, error: error instanceof Error ? error.message : String(error) }))
    }
    if (message.type === 'GROUP_DELIVERY_ERROR') {
      const errorMessage = message.error || message.message
      if (errorMessage) showError(errorMessage)
    }
    return false
  }
}

// Role frames report their page health to every extension page; only frames in this tab are ours.
function recordSiteStatus(message: Extract<StorePushMessage, { type: 'TEAM_SITE_STATUS_UPDATE' }>, sender: chrome.runtime.MessageSender): void {
  // The side panel hears its member pages through the background, with no tab (memberPorts.ts).
  if (inSidePanel ? sender.tab !== undefined : appState.hostTabId === undefined || sender.tab?.id !== appState.hostTabId) return
  if (typeof message.chatId !== 'string' || typeof message.roleId !== 'string') return
  if (!SITE_HEALTH_STATUSES.has(message.status)) return
  roleHealth.siteReported(message.chatId, message.roleId, {
    status: message.status,
    ...(typeof message.reason === 'string' ? { reason: message.reason } : {}),
    ...(typeof message.detail === 'string' ? { detail: message.detail.slice(0, 160) } : {}),
  })
}

function handleRoleRecoveryRequest(message: Extract<StorePushMessage, { type: 'GROUP_ROLE_RECOVERY_REQUEST' }>, sendResponse: (response?: unknown) => void): void {
  const chat = store.chatsById[message.chatId]
  const role = store.rolesById[message.roleId]
  if (!chat || !role || role.chatId !== chat.id) {
    log.warn('orchestration-diagnostic:role-recovery:missing-role', {
      chatId: message.chatId,
      roleId: message.roleId,
      reason: message.reason,
      hasChat: Boolean(chat),
      hasRole: Boolean(role),
      roleChatId: role?.chatId,
    })
    sendResponse({ ok: false, error: '找不到要恢复的成员' })
    return
  }
  log.warn('orchestration-diagnostic:role-recovery:start', {
    chatId: chat.id,
    roleId: role.id,
    roleName: role.name,
    chatSite: role.chatSite,
    reason: message.reason,
  })
  reconnectRolesForSend(chat, [role], { keepReplyAttempt: true })
    .then(() => {
      log.warn('orchestration-diagnostic:role-recovery:ready', {
        chatId: chat.id,
        roleId: role.id,
        roleName: role.name,
        chatSite: role.chatSite,
      })
      sendResponse({ ok: true })
    })
    .catch(error => {
      const reason = error instanceof Error ? error.message : String(error)
      log.warn('orchestration-diagnostic:role-recovery:failed', { chatId: chat.id, roleId: role.id, roleName: role.name, chatSite: role.chatSite, reason: message.reason, error: reason })
      sendResponse({ ok: false, error: reason })
    })
}

// 附上网页: the page the OpenTeam icon or 发到 OpenTeam was used on (webPageOffers.ts).
const webPageOfferView = createWebPageOfferView({
  element: teamDomRefs.webPageOfferEl,
  ui: source => translateUi(source, normalizeLanguage(store.settings.language)),
  storage: {
    get: async () => (await chrome.storage.session.get(WEB_PAGE_OFFER_KEY))[WEB_PAGE_OFFER_KEY],
    onChange: listener => chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'session' && WEB_PAGE_OFFER_KEY in changes) listener(changes[WEB_PAGE_OFFER_KEY].newValue)
    }),
  },
  async readPage() {
    const response = await sendRuntimeMessage('WEB_PAGE_READ') as { ok?: boolean; error?: string; upload?: { fileName: string; mimeType: string; text: string } }
    if (response.ok === false || !response.upload) throw new Error(response.error || '读不了这个网页')
    return response.upload
  },
  dismiss: async () => { await sendRuntimeMessage('WEB_PAGE_DISMISS') },
  addFile: file => {
    composerAttachments.addFiles([file])
    messageInputEl.focus()
  },
  showError,
  now: () => Date.now(),
})

// 网站失效提醒: over the group list, with 备份提醒 (src/group/siteFaults.ts).
const siteFaultNotice = createSiteFaultNotice({
  element: document.getElementById('site-fault-notice'),
  language: () => normalizeLanguage(store.settings.language),
  getStore: () => store,
  startSiteCheck: () => startSiteCheck(),
  runCommand,
  showError,
})

// 定时自检's result not sent: over the group list too (siteCheckDeliveryNotice.ts).
const siteCheckDeliveryNotice = createSiteCheckDeliveryNotice({
  element: document.getElementById('site-check-delivery-notice'),
  language: () => normalizeLanguage(store.settings.language),
  getStore: () => store,
  openSchedule: () => openSiteCheckSchedule(),
  runCommand,
  showError,
})

function openSiteCheckSchedule(onClose?: () => void): void {
  openSiteCheckScheduleDialog({ getStore: () => store, runCommand, onClose })
}

// 备份提醒: kept in its own storage key, outside the store and its backups.
const backupReminderView = createBackupReminderView({
  document,
  language: () => normalizeLanguage(store.settings.language),
  getStore: () => store,
  storage: {
    get: async () => (await chrome.storage.local.get(BACKUP_REMINDER_STORAGE_KEY))[BACKUP_REMINDER_STORAGE_KEY],
    set: (state: BackupReminderState) => chrome.storage.local.set({ [BACKUP_REMINDER_STORAGE_KEY]: state }),
  },
  now: () => Date.now(),
  exportBackup: () => backupView.exportBackup(),
})

const backupView = createBackupView({
  onExported: () => void backupReminderView.noteBackup(),
  exportButtonEl: teamDomRefs.backupExportEl,
  restoreButtonEl: teamDomRefs.backupRestoreEl,
  fileInputEl: teamDomRefs.backupFileEl,
  includeApiKeysEl: teamDomRefs.backupIncludeKeysEl,
  getStore: () => store,
  sendRuntimeMessage,
  images: imageAttachmentRepository,
  extensionVersion: chrome.runtime.getManifest?.().version,
  applyRestoredStore(nextStore) {
    // Frames and rendered messages of the old data must not survive into the restored data.
    appState.messageNodeCache.clear()
    for (const group of iframeHost.listChatGroups()) {
      if (!nextStore.chatsById[group.chatId]) iframeHost.removeChat(group.chatId)
    }
    applyStore(nextStore)
  },
  showError,
  showSuccess,
})

const replyComparisonView = createReplyComparisonView({
  getStore: () => store,
  runCommand,
  copyText: text => navigator.clipboard.writeText(text),
  showError,
  showSuccess,
})

const teamFormationView = createTeamFormationView({
  getStore: () => store,
  getCurrentChatId: () => appState.selectedChatId,
  runCommand,
  getRoleHealth: role => pageHealth(role) ?? { status: role.status === 'error' ? 'error' : 'ready' },
  focusRoleFrame: (chatId, roleId) => showMemberPage(chatId, roleId),
  showError,
  showSuccess,
  openAutoPlan: (task, instruction) => orchestrationModalView.openAutoPlan(task, instruction),
})

// 检查新版本: kept in its own storage key, outside the store and its backups.
const updateNotice = createUpdateNotice({
  document,
  settingsButtonEl,
  currentVersion: chrome.runtime.getManifest().version,
  language: () => normalizeLanguage(store.settings.language),
  storage: {
    get: async () => (await chrome.storage.local.get(UPDATE_CHECK_STORAGE_KEY))[UPDATE_CHECK_STORAGE_KEY],
    set: (state: UpdateCheckState) => chrome.storage.local.set({ [UPDATE_CHECK_STORAGE_KEY]: state }),
  },
  now: () => Date.now(),
})
const siteCheckView = createSiteCheckView({ getStore: () => store, now: () => Date.now(), requestRender: () => render() })
const projectView = createProjectView({
  getStore: () => store,
  getCurrentChat,
  getCurrentRoles,
  getLanguage: () => normalizeLanguage(store.settings.language),
  getDraft: () => teamDomRefs.messageInputEl.value.trim(),
  runCommand,
  showError,
})

const messageSearchView = createMessageSearchView({
  openButtonEl: teamDomRefs.openMessageSearchEl,
  getStore: () => store,
  getCurrentChatId: () => appState.selectedChatId,
  openMessage: openMessageInChat,
  openChat: chatId => switchChat(chatId),
})

// Switches to the message's chat, scrolls it into view and highlights it for a moment.
function openMessageInChat(chatId: string, messageId: string): void {
  if (!store.chatsById[chatId]) return
  switchChat(chatId)
  window.requestAnimationFrame(() => {
    const row = messagesEl.querySelector<HTMLElement>(`.message-row[data-message-id="${CSS.escape(messageId)}"]`)
    if (!row) return
    row.scrollIntoView({ block: 'center' })
    row.classList.remove('message-search-hit')
    void row.offsetWidth
    row.classList.add('message-search-hit')
    window.setTimeout(() => row.classList.remove('message-search-hit'), 2400)
  })
}

const sidePanel = inSidePanel ? createSidePanel({
  connect: () => chrome.runtime.connect({ name: PANEL_PORT_NAME }),
  onPush: message => handlePush(message as StorePushMessage, {}, () => undefined),
  onReconnected: () => void refreshStore(false),
  sendRuntimeMessage: (type, payload) => sendRuntimeMessage(type, payload),
  getWindowId: async () => (await chrome.windows.getCurrent()).id,
  openInTabButton: teamDomRefs.openInTabEl,
  closeWindow: () => window.close(),
}) : undefined

async function boot(): Promise<void> {
  await resolveHostTabId()
  // An OpenTeam tab opened while a side panel holds the member pages leaves them to it.
  if (!inSidePanel) {
    const presence = await sendRuntimeMessage<unknown>('TEAM_PANEL_PRESENCE_GET').catch(() => undefined) as { open?: boolean } | undefined
    if (presence?.open) panelHandover.panelChanged(true)
  }
  window.addEventListener('pagehide', () => primaryCoordinator.dispose(), { once: true })
  registerRuntimePush()
  // The panel's port tells OpenTeam tabs to let go of the member pages; the panel then takes them.
  await sidePanel?.start()
  await primaryCoordinator.start()
  themeController.registerThemeEvents()
  uiStyleController.registerStyleEvents()
  aiPagesView.registerAiPagesControls()
  registerSettingsWindow({ windowEl: settingsMenuEl, settingsButtonEl })
  void updateNotice.start()
  void backupReminderView.start()
  void webPageOfferView.start()
  // The memory store's list takes the settings window's place, as the models window does.
  teamDomRefs.openMemoryPanelEl.addEventListener('click', () => {
    settingsMenuEl.hidden = true
    settingsButtonEl.setAttribute('aria-expanded', 'false')
    openMemoryPanel({ getStore: () => store, runCommand, getCurrentChatId: () => getCurrentChat()?.id, onClose: () => settingsButtonEl.focus() })
  })
  registerHeaderMenus(teamDomRefs.chatHeaderEl)
  registerHeaderMenus(teamDomRefs.composerModesEl)
  const chatListDrawer = registerChatListDrawer({
    appShellEl,
    sidebarEl: teamDomRefs.chatSidebarEl,
    toggles: [teamDomRefs.openChatListEl, teamDomRefs.railChatsEl],
    narrowQuery: window.matchMedia(NARROW_LAYOUT_QUERY),
  })
  // The side panel shows no rail; its buttons are at the bottom of the group list (panelTools.ts).
  if (inSidePanel) {
    movePanelTools({
      sidebarEl: teamDomRefs.chatSidebarEl,
      buttons: [teamDomRefs.openMessageSearchEl, teamDomRefs.openAllNotesEl, teamDomRefs.openPeopleLibraryEl, teamDomRefs.openUsageEl, teamDomRefs.openInTabEl, settingsButtonEl],
      label: '工具',
      onUse: () => chatListDrawer.close(),
    })
  }
  document.querySelector<HTMLButtonElement>('#open-project')?.addEventListener('click', () => projectView.openSetup())
  showAiPagesEl.addEventListener('click', () => {
    settingsMenuEl.hidden = true
    settingsButtonEl.setAttribute('aria-expanded', 'false')
  })
  document.querySelector<HTMLButtonElement>('#export-diagnostics')?.addEventListener('click', () => {
    exportDiagnostics({
      getStore: () => store,
      extensionVersion: chrome.runtime.getManifest().version,
      userAgent: navigator.userAgent,
      now: () => Date.now(),
      getBackgroundLogs: async () => {
        const response = await sendRuntimeMessage('DIAGNOSTICS_LOGS_GET') as { ok?: boolean; error?: string; logs?: RecentLogEntry[] }
        if (response.ok === false) throw new Error(response.error || '后台没有回应')
        return Array.isArray(response.logs) ? response.logs : []
      },
      getUpdateState: async () => (await chrome.storage.local.get(UPDATE_CHECK_STORAGE_KEY))[UPDATE_CHECK_STORAGE_KEY],
      save: saveTextFile,
    }).catch(error => showError(error instanceof Error ? error.message : String(error)))
  })
  document.querySelector<HTMLButtonElement>('#start-site-check')?.addEventListener('click', () => {
    settingsMenuEl.hidden = true
    settingsButtonEl.setAttribute('aria-expanded', 'false')
    startSiteCheck()
  })
  // 联网搜索's key (webSearchDialog.ts).
  document.querySelector<HTMLButtonElement>('#open-web-search')?.addEventListener('click', () => {
    settingsMenuEl.hidden = true
    settingsButtonEl.setAttribute('aria-expanded', 'false')
    openWebSearchDialog({
      getStore: () => store,
      runCommand,
      async request(type, payload) {
        const response = await sendRuntimeMessage(type, payload) as Record<string, unknown> & { ok?: boolean; error?: string }
        if (response.ok === false) throw new Error(response.error || translateUi('操作失败', normalizeLanguage(store.settings.language)))
        return response
      },
      onClose: () => settingsButtonEl.focus(),
    })
  })
  // 定时自检 (siteCheckScheduleDialog.ts).
  document.querySelector<HTMLButtonElement>('#open-site-check-schedule')?.addEventListener('click', () => {
    settingsMenuEl.hidden = true
    settingsButtonEl.setAttribute('aria-expanded', 'false')
    openSiteCheckSchedule(() => settingsButtonEl.focus())
  })
  registerAllNotesEvents()
  languageSettingsController.registerEvents()
  registerReplyNotificationSettings()
  registerMemoryProposalSetting()
  registerAgentControlSettings()
  backupView.registerEvents()
  messageSearchView.registerEvents()
  registerUi()
  registerOrchestrationEvents()
  registerNotesEvents()
  render()
  await refreshStore(false)
}

boot().catch(error => showError(error instanceof Error ? error.message : String(error)))

// A member page's health as this page sees it, where it holds the member pages. Otherwise (a tab
// that let the side panel have them) it goes by what the store says of each member.
function pageHealth(role: GroupRole): RolePageHealth | undefined {
  return primaryCoordinator.isPrimary() ? roleHealth.get(role.chatId, role.id) : undefined
}
