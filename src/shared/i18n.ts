import type { BuiltinGroupTemplate, BuiltinGroupTemplateRole } from '../group/builtinGroupTemplates'
import type { OpenTeamLanguage, RoleTemplate } from '../group/types'

export type TeamLanguage = OpenTeamLanguage

export const DEFAULT_LANGUAGE: TeamLanguage = 'en'

const UI_TRANSLATIONS: Record<string, string> = {
  '缩小窗口': 'Minimize window',
  '全屏窗口': 'Fullscreen window',
  '调整窗口大小': 'Resize window',
  'OpenTeam 导航': 'OpenTeam navigation',
  '群聊': 'Chats',
  '查看全部笔记': 'View all notes',
  '全部笔记': 'All notes',
  '打开人员库': 'Open people library',
  '人员库': 'People library',
  '设置': 'Settings',
  '语言': 'Language',
  '加载群聊中': 'Loading chats',
  '还没有群聊': 'No chats yet',
  '点上方的加号新建：按任务组队、从模板创建，或建一个空白群聊。': 'Use the plus button above: team up for a task, start from a template, or create a blank group.',
  '新建群聊': 'New chat',
  '编辑名称': 'Edit name',
  '复制群聊': 'Duplicate chat',
  '导出记录': 'Export records',
  '清空消息': 'Clear messages',
  '关闭群聊': 'Close chat',
  '删除群聊': 'Delete chat',
  '群聊名称': 'Chat name',
  '例如：产品方案讨论': 'Example: product proposal review',
  '群聊模式': 'Chat mode',
  '协作群聊': 'Collaborative chat',
  '协作群聊模式': 'Collaborative mode',
  '独立专家模式': 'Independent expert mode',
  '人员参考群聊上下文，适合接力讨论。': 'Members share chat context; good for sequential discussion.',
  '独立专家': 'Independent experts',
  '人员独立回答，适合并行评审。': 'Members answer independently; good for parallel review.',
  '取消': 'Cancel',
  '创建': 'Create',
  '从模板中创建': 'Create from template',
  '未选择群聊': 'No chat selected',
  '创建或选择一个群聊开始协作': 'Create or select a chat to start collaborating',
  '选择一个群聊': 'Select a chat',
  '左侧群聊列表会显示最近摘要、状态和更新时间。': 'The chat list on the left shows recent summaries, status, and update time.',
  '选择群聊后可添加、查看、恢复和唤醒人员。': 'Select a chat to add, view, restore, and wake people.',
  '点击添加人员，可从人员库批量加入或临时添加。': 'Click Add people to add from the library or add a temporary person.',
  '界面模式': 'Theme',
  '界面风格': 'Interface style',
  '搜索群聊': 'Search groups',
  '编辑后重新发送': 'Edit and send again',
  '语音输入': 'Voice input',
  '停止语音输入': 'Stop voice input',
  '回复选项': 'Reply options',
  '置顶群聊': 'Pin to top',
  '取消置顶': 'Unpin',
  '已置顶': 'Pinned',
  '没有找到群聊': 'No groups found',
  'ChatGPT 风格界面': 'ChatGPT-style interface',
  'Grok 风格界面': 'Grok-style interface',
  '浅色模式': 'Light mode',
  '深色模式': 'Dark mode',
  '浅色': 'Light',
  '深色': 'Dark',
  '编排': 'Orchestration',
  '不@也回复': 'Reply without @',
  '防止流程无限循环': 'Keeps a looping flow from running forever',
  '由你选的人员整理共识、分歧和需要核实的地方': 'The member you choose writes up the agreements, the disagreements and what to check',
  '添加模型': 'Add model',
  '选择模型': 'Choose models',
  '选择用哪个模型；选几个就加几位成员': 'Choose which models to use; each one chosen adds a member',
  '已在群里': 'Already in the group',
  '可以多选：每选一个模型，就加一位成员。': 'You can choose several: each model chosen adds one member.',
  '请先在「设置 → 模型」里添加模型，再使用自动编排': 'Add a model under Settings → Models before using auto planning',
  '请先在「设置 → 模型」里添加模型，再用 AI 生成人设': 'Add a model under Settings → Models before generating a persona',
  '这个模型正在被成员使用，不能删除': 'Members are using this model, so it cannot be deleted',
  '成员': 'Members',
  '添加成员': 'Add members',
  '登录网站': 'Sign in to sites',
  '在新标签页打开 AI 网站登录': 'Opens an AI site in a new tab to sign in',
  '模型': 'Models',
  'API 模型和本机智能体': 'API models and local agents',
  '添加或修改成员能用的 API 模型（OpenAI 或 Anthropic 格式）和本机智能体（Claude Code、Codex 等）。': 'Add or change the API models (OpenAI or Anthropic format) and the local agents (Claude Code, Codex and others) members can use.',
  '管理模型': 'Manage models',
  '写下要做的事，AI 们自己认领职位': 'Describe the task; the AIs pick their own positions',
  '从模板创建': 'From a template',
  '用现成的角色组合，马上开始': 'Start right away with a ready-made set of roles',
  '空白群聊': 'Blank group',
  '先建群，再自己添加成员': 'Create the group, then add members yourself',
  '选一个群聊，或者新建一个': 'Pick a group, or start a new one',
  '左边是你的群聊。新建的话，可以按任务组队、从模板创建，或先建一个空白群聊。': 'Your groups are on the left. To start one, team up for a task, use a template, or create a blank group.',
  '建一个群，让几个 AI 一起干活': 'Start a group and let several AIs work together',
  '按任务组队最省事：写下要做的事，AI 们自己认领职位。': 'Teaming up for a task is the quickest: describe the task, and the AIs pick their own positions.',
  '点「添加成员」，从人员库批量加入或临时添加。': 'Click "Add members" to add people from the library, or temporary ones.',
  '刷新网页': 'Reload page',
  '移出群聊': 'Remove from group',
  '还没读过群消息': 'Has not read the group yet',
  '通过 API 回复': 'Replies through the API',
  '开启后，不 @ 的消息也会让所有成员回复；@ 了谁就只问谁': 'When on, a message without @ asks every member; @ someone to ask only them',
  '回复方式': 'How members reply',
  '工作流': 'Workflows',
  '按你排好的流程，让成员一步步完成': 'Members follow a flow you arrange, step by step',
  '协调员把目标拆成任务，分给成员并检查结果': 'A coordinator splits the goal into tasks, assigns them and checks the results',
  '重新连接成员的 AI 网页': "Reconnects the members' AI pages",
  '更多': 'More',
  '群聊列表': 'Group list',
  '笔记': 'Notes',
  '空': 'Empty',
  '恢复会话': 'Restore session',
  '输入消息，@成员 让他回复；不 @ 只记在群里': 'Message the group; @ a member to get a reply, or it is only recorded',
  '输入消息，所有成员都会回复；@成员 只问他': 'Message the group; every member replies, or @ one to ask only them',
  '选择群聊后可发送': 'Select a chat to send',
  '发送': 'Send',
  '群聊成员与人员': 'Chat members and people',
  'AI 站点登录': 'AI site login',
  '当前群聊人员': 'Current chat people',
  '收起成员面板': 'Collapse people panel',
  '打开成员面板': 'Open people panel',
  '收起': 'Collapse',
  '添加人员': 'Add people',
  '从人员库批量选择，或临时添加只属于当前群聊的人员。': 'Choose from the people library, or add temporary people for this chat only.',
  '笔记面板': 'Notes panel',
  '拖动笔记': 'Drag notes',
  '手动记录或收集 Mark 内容。': 'Write notes manually or collect marked content.',
  '关闭笔记': 'Close notes',
  '笔记范围': 'Notes scope',
  '当前群聊': 'Current chat',
  '全局笔记': 'Global notes',
  '富文本工具栏': 'Rich-text toolbar',
  '加粗': 'Bold',
  '斜体': 'Italic',
  '删除线': 'Strikethrough',
  '项目列表': 'Bullet list',
  '编号列表': 'Numbered list',
  '撤销': 'Undo',
  '重做': 'Redo',
  '富文本笔记编辑器': 'Rich-text notes editor',
  '打开 OpenTeam': 'Open OpenTeam',
  '全局、群聊、已删除群聊': 'Global, chat, and deleted-chat notes',
  '关闭全部笔记': 'Close all notes',
  '还没有笔记': 'No notes yet',
  '群聊笔记': 'Chat note',
  '已删除群聊的笔记': 'Deleted-chat note',
  '手动记录': 'Manual note',
  '当前笔记富文本编辑器': 'Active note rich-text editor',
  '选择一个现成小组，创建后会自动加入模板人员。': 'Choose a ready-made group; template people will be added automatically.',
  '关闭群聊模板': 'Close chat templates',
  '搜索模板': 'Search templates',
  '搜索任务、行业、角色或模板名称，例如：写论文、合同、面试、AI Agent': 'Search tasks, industries, roles, or template names, e.g. paper, contract, interview, AI Agent',
  '群聊模板分类': 'Chat template categories',
  '群聊模板': 'Chat templates',
  '确认创建': 'Confirm create',
  '了解限制并创建': 'Acknowledge limits and create',
  '没有找到匹配的小组': 'No matching group found',
  '可以试试换个说法，例如搜索「写论文」「合同」「面试」「投放」「装修」。': 'Try another phrasing, such as paper, contract, interview, launch, or renovation.',
  '清空搜索': 'Clear search',
  '查看全部模板': 'View all templates',
  '专业边界': 'Professional boundary',
  '需谨慎': 'Use with care',
  '新群聊': 'New chat',
  '维护可复用人员人设；加入群聊后会复制为独立人员。': 'Manage reusable personas; adding them to a chat creates independent copies.',
  '新建': 'New',
  '关闭人员库': 'Close people library',
  '人员列表': 'People list',
  '搜索人员名称、描述或提示词': 'Search people names, descriptions, or prompts',
  '人员库类型': 'People library type',
  '自定义人员': 'Custom people',
  '内置人员': 'Built-in people',
  '人员分类': 'People categories',
  '不使用人员库，手动创建': 'Do not use the library; create manually',
  '内置': 'Built-in',
  '自定义': 'Custom',
  '详情': 'Details',
  '上一页': 'Previous',
  '下一页': 'Next',
  '未填写人员库描述': 'No people-library description',
  '未填写描述': 'No description',
  '所有可用站点已添加': 'All available sites have already been added',
  '临时人员': 'Temporary person',
  '可以切换到自定义人员，或调整搜索词。': 'Switch to custom people, or adjust the search terms.',
  '点击右上角新建人员，保存后会出现在这里。': 'Click New in the top right; saved people will appear here.',
  '先在人员库中新建人员，或点击右上角临时添加。': 'Create a person in the people library first, or use Add temporary in the top right.',
  'API 模型': 'API model',
  '关闭模型': 'Close models',
  '显示名称': 'Display name',
  '例如：本地模型': 'Example: local model',
  '接口格式': 'API format',
  'OpenAI 格式': 'OpenAI format',
  'Anthropic 格式': 'Anthropic format',
  '模型地址': 'Model URL',
  '模型 Key': 'Model key',
  '模型名称': 'Model name',
  '保存模型': 'Save model',
  '新建人员': 'New person',
  '维护人员名称、人设和默认站点。': 'Manage the person name, persona, and default site.',
  '关闭人员编辑': 'Close person editor',
  '描述想要的人设': 'Describe the persona you want',
  '例如：一个擅长小红书增长的内容顾问': 'Example: a content growth advisor for Xiaohongshu',
  'AI 生成': 'Generate with AI',
  '生成中': 'Generating',
  '生成中...': 'Generating...',
  '已生成，可继续修改后保存': 'Generated. You can edit it before saving.',
  '请先描述想要生成的人设': 'Describe the persona you want to generate first',
  '人员名称': 'Person name',
  '描述': 'Description',
  '人设': 'Persona',
  '默认站点': 'Default site',
  'GPTs 链接前缀': 'GPTs link prefix',
  '选填。保存后，该人员使用 ChatGPT 时会优先打开这个 GPTs。': 'Optional. After saving, this person opens this GPT first when using ChatGPT.',
  'Grok 项目链接': 'Grok project URL',
  '选填。保存后，该人员使用 Grok 时会优先打开这个项目。': 'Optional. After saving, this person opens this project first when using Grok.',
  '保存人员': 'Save person',
  '系统内置人员': 'System built-in person',
  '关闭内置人员详情': 'Close built-in person details',
  '从人员库或临时草稿中选择人员，并为每个人指定站点。': 'Choose people from the library or temporary drafts, and assign a site to each.',
  '临时添加': 'Add temporary',
  '关闭添加人员': 'Close add people',
  '选择人员': 'Choose people',
  '当前群聊还没有人员': 'This chat has no people yet',
  '输入消息；不 @ 会让所有成员回复，也可 @ 指定成员': 'Type a message; without @ all members reply, or @ specific members',
  '输入消息；不 @ 仅记录，@ 人员触发回复': 'Type a message; without @ it is recorded only, while @people triggers replies',
  '将作为群消息记录，不触发 AI；@ 人员可触发回复': 'This will be recorded as a chat message and will not trigger AI; @people can trigger replies',
  '取消引用': 'Cancel quote',
  '所有人': 'Everyone',
  '全员': 'All people',
  '本机智能体控制：开启': 'Local agent control: On',
  '回复完成时通知：开启': 'Notify when replies are in: On',
  '回复完成时通知：关闭': 'Notify when replies are in: Off',
  '多人回复先列要点：开启': 'Key points first in group replies: On',
  '多人回复先列要点：关闭': 'Key points first in group replies: Off',
  '每轮自动汇总：开启': 'Summarize each round: On',
  '每轮自动汇总：关闭': 'Summarize each round: Off',
  '同时问两位以上成员时，回复先列要点，长回复折叠起来；大家都回复后，由一位成员写本轮汇总（优先用 API 成员）。': 'When a message goes to two or more members, their replies start with key points and long replies fold; once everyone has answered, one member (an API member when there is one) summarizes the round.',
  '展开全文': 'Show full reply',
  '本轮汇总': 'Round summary',
  '汇总本轮': 'Summarize round',
  '汇总本轮回复': 'Summarize this round',
  '正在汇总本轮回复': 'Summarizing this round',
  '通用': 'General',
  '看看要执行的任务': 'Read the task first',
  '配置 OpenAI 或 Anthropic 兼容 API，或本机的智能体（Claude Code、Codex 等，经 ACP 连接），人员可直接选择这些模型。': 'Set up OpenAI- or Anthropic-compatible APIs, or agents on this computer (Claude Code, Codex and others, through ACP); people can use these models directly.',
  '本机智能体（ACP）': 'Local agent (ACP)',
  '工作目录': 'Working folder',
  '智能体在本机运行，只能访问它允许的目录。': 'The agent runs on this computer and can reach only the folders it is allowed.',
  '在终端运行 openteamcli agent add --preset claude-code --cwd 你的项目目录，智能体就会出现在这里。需要在设置里打开「本机智能体控制」。': 'Run openteamcli agent add --preset claude-code --cwd <your project folder> in a terminal and the agent shows up here. Local agent control must be on in Settings.',
  '每次执行前都会先问你。执行中它要改文件或运行命令时，会不会再来问你，取决于它的权限模式：Claude Code 预设每次都问。OpenTeam 替它读写文件时只限这个目录；它自己的工具按它自己的权限规则。': 'You are asked before every run. Whether it asks again before changing files or running commands depends on its permission mode; the Claude Code preset always asks. Files OpenTeam reads and writes for it stay in this folder; its own tools follow its own permission rules.',
  '你拒绝了这次执行。': 'You refused this run.',
  '这个请求已经失效（可能后台重启过），请重新发送任务。': 'This request is no longer valid (the background may have restarted); send the task again.',
  '项目': 'Project',
  '项目目标': 'Project goal',
  '补充给协调员': 'Note for the coordinator',
  '最终交付': 'Final deliverable',
  '协调员的任务计划（看板里有整理好的版本）': "The coordinator's task plan (see the board for a tidy version)",
  '协调员的检查结果（看板里有整理好的版本）': "The coordinator's check (see the board for a tidy version)",
  '让协调员把目标拆成任务，分给成员完成并检查结果': 'Have a coordinator break a goal into tasks for the members and check the results',
  '项目进行中，补充的消息暂不支持附件': 'A project is running; notes cannot have attachments',
  '这个群聊已经有进行中的项目，请先停止它': 'This group already has a project running; stop it first',
  '项目至少需要两位成员': 'A project needs at least two members',
  '请写下项目目标': 'Write the project goal',
  '现在没有等待确认的计划': 'There is no plan waiting for approval',
  '只有计划等待确认时才能重新规划': 'You can plan again only while the plan waits for approval',
  '只有计划等待确认时才能改负责人': 'You can change owners only while the plan waits for approval',
  '项目已经完成': 'The project is finished',
  '项目正在进行': 'The project is running',
  '项目暂不支持图片附件，可以附上 PDF、Word 或文本文件': 'Projects do not take images yet; attach PDF, Word or text files',
  '群聊回复': 'Group replies',
  'AI 网页': 'AI pages',
  '本机智能体': 'Local agents',
  '外观': 'Appearance',
  '打开': 'Open',
  '导出': 'Export',
  '选择备份…': 'Choose a backup…',
  '关闭设置': 'Close settings',
  '设置分类': 'Settings categories',
  '本机智能体控制': 'Local agent control',
  '多人回复先列要点': 'Key points first in group replies',
  '每轮自动汇总': 'Summarize each round',
  '回复完成时通知': 'Notify when replies are in',
  '同时问两位以上成员时，每条回复先列 1–3 条要点，长回复折叠起来。': 'When a message goes to two or more members, each reply starts with 1–3 key points and long replies fold.',
  '大家都回复后，由一位成员写本轮汇总：共识、分歧、待定问题和下一步（优先用 API 成员）。': 'Once everyone has answered, one member summarizes the round: agreements, disagreements, open questions and next steps (an API member when there is one).',
  '让本机的智能体（openteamcli）创建群聊、添加成员、发布任务并等待回复。': 'Lets local agents (openteamcli) create groups, add members, post tasks and wait for replies.',
  '备份包含群聊、人员、笔记和图片。': 'The backup includes groups, people, notes and images.',
  '同时导出 API Key（导出后请妥善保管备份文件）': 'Include API keys (keep the backup file safe)',
  '可以把备份合并进来，或用它替换全部数据。': 'Merge a backup into your data, or replace all data with it.',
  '轮流讨论': 'Take turns',
  '开启后，@ 两位以上成员时，他们会一个接一个发言，每人都能看到前面说了什么，也可以 @ 别人接着说': 'When on, messages to two or more members start a discussion: they speak one at a time, each seeing what was said, and can @ someone to answer next',
  '补充给下一位发言的成员': 'Note for the next speaker',
  '你现在发的消息会作为补充，给下一位发言的成员看。': 'What you send now is added as a note for the next speaker.',
  '连续两位成员没有回复，讨论停了下来。': 'Two turns in a row got no reply, so the discussion stopped.',
  '没有可以发言的成员了。': 'No member is free to speak.',
  '停止讨论': 'Stop discussion',
  '再讨论一轮': 'One more round',
  '汇总讨论': 'Summarize discussion',
  '讨论进行中，补充的消息暂不支持附件': 'A discussion is running; notes cannot have attachments',
  '参加讨论的成员都不可用，请等待或恢复后再试': 'None of the discussion members is available; wait or recover them and try again',
  '没有可以继续的讨论': 'There is no discussion to continue',
  '找不到讨论的话题，可能已被删除': 'The discussion topic was not found; it may have been deleted',
  'OpenTeam 不在前台时，成员都回复完会弹出桌面通知。': 'When OpenTeam is not in front, a desktop notification tells you every member has replied.',
  '查看成员的 AI 网页': "View the members' AI pages",
  '成员的网页在 OpenTeam 后面运行。需要登录、验证或关掉弹窗时打开它们，再点「返回 OpenTeam」回来。': "The members' pages run behind OpenTeam. Open them to sign in, pass a check or close a pop-up, then click Back to OpenTeam.",
  '返回 OpenTeam': 'Back to OpenTeam',
  '本机智能体控制：关闭': 'Local agent control: Off',
  '尚未读取消息': 'No messages read yet',
  '等待连接': 'Waiting to connect',
  '网页已连接': 'Web connected',
  '讨论分歧': 'Discuss differences',
  '把所有回答发给回答过的人员，请 TA 们只针对不同意的地方回应': 'Send all answers to the people who answered and ask them to respond only where they disagree',
  '至少要有两份回复才能讨论或汇总。': 'At least two replies are needed to discuss or summarize.',
  '几位都同意，不代表一定正确：数据、引语和日期请到原始出处核实。': 'Agreement is not proof: check figures, quotes and dates against the original sources.',
  '对比回复': 'Compare replies',
  '关闭': 'Close',
  '正在回复…': 'Replying…',
  '回复失败': 'Reply failed',
  '按任务组队': 'Team up for a task',
  '⚑ 查看分工': '⚑ View positions',
  '还没有回复': 'No reply yet',
  '这位人员没有给出回复。': 'This person did not reply.',
  '回复到了会显示在这里。': 'The reply will show up here.',
  '请': 'Ask',
  '正在发送…': 'Sending…',
  '汇总异同': 'Summarize differences',
  '复制对比': 'Copy comparison',
  '已复制对比内容': 'Comparison copied',
  '搜索消息': 'Search messages',
  '搜索消息（Ctrl/⌘ K）': 'Search messages (Ctrl/⌘ K)',
  '搜索所有群聊的消息…': 'Search messages in all chats…',
  '全部群聊': 'All chats',
  '没有找到消息': 'No messages found',
  '输入关键词，多个词用空格分开': 'Type keywords; separate several words with spaces',
  '我': 'Me',
  'AI 人员': 'AI person',
  '系统': 'System',
  '添加图片或文件': 'Add image or file',
  '附件只在发送时上传给对应的 AI 网站或模型。': 'Attachments are uploaded to the AI site or model only when you send them.',
  '读取中…': 'Reading…',
  '附件只在发送时上传给对应的 AI 网站或模型。PDF 和 Office 文件发送的是读出的文字。': 'Attachments are uploaded to the AI site or model only when you send them. PDF and Office files are sent as the text read from them.',
  '移除附件': 'Remove attachment',
  '数据备份': 'Data backup',
  '导出全部数据': 'Export all data',
  '从备份恢复…': 'Restore from backup…',
  '同时导出 API Key': 'Also export API keys',
  '备份包含群聊、人员、笔记和图片。导出 API Key 后，请妥善保管备份文件。': 'Backups include chats, people, notes and images. If you export API keys, keep the backup file safe.',
  '从备份恢复': 'Restore from backup',
  '备份时间': 'Backed up',
  '消息': 'Messages',
  '图片': 'Images',
  '合并：保留当前数据，只加入当前没有的群聊和人员，设置保持不变。': 'Merge keeps your current data and only adds chats and people you do not have yet. Settings stay as they are.',
  '替换：用备份覆盖当前全部数据，替换前会先下载一份当前数据的备份。已配置的 API 模型会保留。': 'Replace swaps all current data for the backup. A backup of the current data is downloaded first. API models configured here are kept.',
  '这些 API 模型在备份里没有 API Key，需要在「设置 → 模型」里重新添加：': 'These API models were saved without their API key and need to be added again under Settings → Models: ',
  '合并到当前数据': 'Merge into current data',
  '替换全部数据': 'Replace all data',
  '导出备份失败': 'Could not export the backup',
  '恢复备份失败': 'Could not restore the backup',
  '读取群聊数据失败': 'Could not read chat data',
  '这不是 OpenTeam 备份文件': 'This is not an OpenTeam backup file',
  '这个备份来自更新版本的 OpenTeam，请先升级扩展': 'This backup comes from a newer OpenTeam. Update the extension first.',
  '备份文件里没有可用的群聊数据': 'The backup file has no usable chat data',
  '无法读取这个文件，请确认它是 OpenTeam 备份': 'Could not read this file. Make sure it is an OpenTeam backup.',
  '网页未打开': 'Page not open',
  '正在打开网页': 'Opening page',
  '网页没有响应': 'Page not responding',
  '正在检查网页': 'Checking page',
  '网页加载中': 'Page loading',
  '可以发送': 'Ready to send',
  '可以发送（未登录）': 'Ready (not logged in)',
  '网页回复中': 'Page replying',
  '需要登录': 'Login required',
  '需要人机验证': 'Verification required',
  '网站拒绝访问': 'Site refused access',
  '有弹窗挡住页面': 'A pop-up covers the page',
  '网站不允许嵌入': 'Site blocks embedding',
  'Claude 网页这次没能在这里加载。把这个成员移出群聊，再重新添加，通常就能恢复。还不行的话，可以改用 Claude API：在「设置 → 模型」里添加 Anthropic 格式的模型，再让这个成员使用它。': 'The Claude website did not load here this time. Removing this member from the group and adding it again usually fixes it. If not, use the Claude API: add an Anthropic-format model under Settings → Models, then switch this member to it.',
  '这个网站会检查自己是否被嵌在别的页面里，发现后就拒绝运行，所以在 OpenTeam 里用不了它的网页版。可以改用这个模型的 API，在「设置 → 模型」里添加。': 'This site checks whether it runs inside another page and refuses to run if it does, so its website cannot be used in OpenTeam. Use the model through its API instead, under Settings → Models.',
  '页面被拦截': 'Page blocked',
  '找不到输入框': 'Input box not found',
  '网站报错': 'Site error',
  '网页异常': 'Page error',
  '页面可用': 'Page available',
  '页面回复中': 'Page replying',
  '页面异常': 'Page error',
  '页面被阻止': 'Page blocked',
  '页面加载中': 'Page loading',
  '打开网站': 'Open site',
  '查看网页': 'View page',
  '重新加载': 'Reload',
  '网页 20 秒内没有连上 OpenTeam。常见原因是网站跳转到了登录页、网络不通，或者网站拒绝在这里打开。可以先在新标签页打开网站登录，再点「重新加载」。': 'The page did not connect to OpenTeam within 20 seconds. Usually the site redirected to its login page, the network is down, or the site refuses to open here. Open the site in a new tab to log in, then click Reload.',
  '这个网站还没有登录。请在新标签页打开网站登录，然后点「重新加载」。': 'You are not logged in to this site. Open the site in a new tab to log in, then click Reload.',
  '网站要求完成人机验证。请在新标签页打开网站完成验证，然后点「重新加载」。': 'The site asks you to verify that you are human. Open the site in a new tab to complete it, then click Reload.',
  '网站拒绝了这次访问，可能是网络、地区或访问频率的限制。稍后再试，或者换一个网络。': 'The site refused access, probably because of the network, region or rate limits. Try again later or from another network.',
  '页面上有弹窗（例如 Cookie 提示）挡住了输入框。点「查看网页」把它关掉。': 'A pop-up on the page (such as a cookie notice) covers the input box. Click View page to close it.',
  '页面里找不到输入框，可能还没加载完，或者网站改版了。可以点「重新加载」再试。': 'The page has no input box. It may not have finished loading, or the site changed its layout. Click Reload to try again.',
  '网站显示了错误信息，消息可能发不出去。': 'The site shows an error message, so messages may not go through.',
  '网页暂时无法使用。可以点「重新加载」再试。': 'The page cannot be used right now. Click Reload to try again.',
  '连接 API': 'API connected',
  '待唤醒': 'Pending',
  '加载中': 'Loading',
  '在线': 'Online',
  '回复中': 'Replying',
  '已停止': 'Stopped',
  '异常': 'Error',
  '草稿': 'Draft',
  '初始化中': 'Initializing',
  '进行中': 'Active',
  '运行中': 'Running',
  '暂无成员': 'No members yet',
  '正在初始化角色': 'Initializing roles',
  '正在创建角色窗口，准备好后就可以继续对话。': 'Creating role windows. You can continue once they are ready.',
  '等待第一条消息': 'Waiting for the first message',
  '直接发送会记录消息；@ 人员或 @所有人 后触发回复。': 'Send directly to record a message; mention @people or @all to trigger replies.',
  '正在回复中': 'Replying',
  '已停止回复': 'Reply stopped',
  '停止回复': 'Stop reply',
  '重新回复': 'Retry reply',
  '重新发送': 'Resend',
  '跳转到原始窗口': 'Jump to source window',
  '重新同步完整回复': 'Resync full reply',
  '引用回复': 'Quote reply',
  '复制回复': 'Copy reply',
  '已复制': 'Copied',
  '高亮颜色': 'Highlight color',
  '高亮': 'Highlight',
  '加入笔记': 'Add to notes',
  '高亮并加入笔记': 'Highlight and add to notes',
  '任务': 'Task',
  '人员': 'Person',
  '复核': 'Review',
  '状态': 'Status',
  '决策': 'Decision',
  '原因': 'Reason',
  '未通过': 'Failed',
  '重试说明': 'Retry note',
  '通过': 'Pass',
  '不通过': 'Fail',
  '未填写人员描述': 'No person description',
  '人员异常。若目标站点未登录，请打开登录页后点击恢复人员。': 'Person error. If the target site is not signed in, open the login page and then click restore.',
  '查看提示词': 'View prompt',
  '关闭提示词详情': 'Close prompt details',
  '未填写提示词': 'No prompt provided',
  '先在「设置 → 模型」里添加模型': 'Add a model under Settings → Models first',
  'API 成员无需刷新窗口': 'API members do not need a window refresh',
  '刷新成员窗口': 'Refresh member window',
  '删除成员': 'Delete member',
  '未配置': 'Not configured',
  '还没有模型': 'No models yet',
  '编辑': 'Edit',
  '测试': 'Test',
  '删除': 'Delete',
  '测试中': 'Testing',
  '测试通过': 'Test passed',
  '琥珀': 'Amber',
  '蓝色': 'Blue',
  '绿色': 'Green',
  '粉色': 'Pink',
  '紫色': 'Purple',
}

export const PROMPT_I18N = {
  'zh-CN': {
    responseLanguageInstruction: '请使用中文回复，除非用户明确要求其他语言。',
    personaLanguageInstruction: 'systemPrompt 使用中文，避免空泛口号，尽量可执行。',
    jsonOnly: '你必须只返回合法 JSON，不要 Markdown，不要解释文字，不要代码块。',
  },
  en: {
    responseLanguageInstruction: 'Respond in English unless the user explicitly asks for another language.',
    personaLanguageInstruction: 'Write name, description, and systemPrompt in English. Keep the systemPrompt concrete and actionable.',
    jsonOnly: 'Return valid JSON only. Do not include Markdown, explanations, or code fences.',
  },
} satisfies Record<TeamLanguage, Record<string, string>>

interface GroupTemplateLocalization {
  name: string
  summary?: string
  userTypes?: string[]
}

interface RoleTemplateLocalization {
  name: string
  description: string
  systemPrompt?: string
}

const CATEGORY_TRANSLATIONS: Record<string, string> = {
  '全部': 'All',
  '思想风格顾问': 'Thought-style advisors',
  '学生与学习': 'Study and Learning',
  '职场效率': 'Work Productivity',
  '内容创作': 'Content Creation',
  '产品与创业': 'Product and Startups',
  '市场营销与销售': 'Marketing and Sales',
  '技术研发': 'Technology and R&D',
  '企业管理': 'Business Management',
  '财务、法律、合规': 'Finance, Legal, and Compliance',
  '电商与本地生意': 'E-commerce and Local Business',
  '专业服务': 'Professional Services',
  '行业垂直专家团': 'Industry Expert Teams',
}

const GROUP_TEMPLATE_LOCALIZATIONS: Record<string, GroupTemplateLocalization> = {
  'study-master': {
    name: 'Study Master Group',
    summary: 'Breaks real study work into goals, materials, schedules, practice, review, and feedback loops. Produces study plans, clear explanations, mistake reviews, memory-card plans, exam strategy, and next actions.',
    userTypes: ['Middle school students', 'College students', 'Self-learners'],
  },
  'exam-prep': { name: 'Exam Prep Group', summary: 'Turns long-cycle exam prep into scope maps, practice plans, mock questioning, weak-point reviews, feedback loops, and recovery plans.' },
  'thesis-writing': { name: 'Thesis Writing Group', summary: 'Supports topic narrowing, literature mapping, method design, structure, academic language, and research-risk review without replacing the student author.' },
  'study-abroad-application': { name: 'Study Abroad Application Group', summary: 'Helps applicants organize positioning, background evidence, narratives, resumes, interview prep, and visa materials while keeping final admissions judgment external.' },
  'daily-work-secretary': { name: 'Daily Work Secretary Group', summary: 'Converts schedules, emails, meetings, tasks, priorities, and daily reviews into executable work materials and follow-up plans.' },
  'project-delivery': { name: 'Project Delivery Group', summary: 'Breaks complex projects into goals, milestones, owners, progress tracking, risks, cross-team coordination, metrics, and retrospective outputs.' },
  'job-interview': { name: 'Job Interview Group' },
  'wechat-editorial': { name: 'WeChat Editorial Team' },
  'short-video-creation': { name: 'Short Video Creation Group' },
  'xiaohongshu-seeding': { name: 'Xiaohongshu Content Group' },
  'novel-writing': { name: 'Novel Writing Group' },
  'startup-advisory': { name: 'Startup Advisory Group' },
  'product-requirement-review': { name: 'Product Requirement Review Group' },
  'indie-developer-growth': { name: 'Indie Developer Growth Group' },
  'fundraising-bp-review': { name: 'Fundraising BP Review Group' },
  'growth-marketing': { name: 'Growth Marketing Group' },
  'sales-coaching': { name: 'Sales Coaching Group' },
  'brand-positioning': { name: 'Brand Positioning Group' },
  'software-development': { name: 'Software Development Group' },
  'ai-agent-development': { name: 'AI Agent Development Group' },
  'data-analysis': { name: 'Data Analysis Group' },
  'ceo-decision': { name: 'CEO Decision Group' },
  'manager-coaching': { name: 'Manager Coaching Group' },
  'hr-recruiting': { name: 'HR Recruiting Group' },
  'personal-finance': { name: 'Personal Finance Group' },
  'small-business-finance': { name: 'Small Business Finance Group' },
  'contract-review': { name: 'Contract Review Group' },
  'ecommerce-operations': { name: 'E-commerce Operations Group' },
  'local-store-growth': { name: 'Local Store Growth Group' },
  'restaurant-operations': { name: 'Restaurant Operations Group' },
  'consulting-advisory': { name: 'Consulting Advisory Group' },
  'teacher-lesson-planning': { name: 'Teacher Lesson Planning Group' },
  'mental-support-growth': { name: 'Mental Support and Growth Group' },
  'real-estate-analysis': { name: 'Real Estate Analysis Group' },
  'renovation-design': { name: 'Renovation Design Group' },
  'travel-planning': { name: 'Travel Planning Group' },
  'fitness-fat-loss': { name: 'Fitness and Fat Loss Group' },
  'medical-visit-prep': { name: 'Medical Visit Prep Group' },
  'agriculture-planting': { name: 'Agriculture Planting Group' },
  'manufacturing-improvement': { name: 'Manufacturing Improvement Group' },
  'supply-chain-procurement': { name: 'Supply Chain Procurement Group' },
  'construction-project': { name: 'Construction Project Group' },
  'law-firm-assistant': { name: 'Law Firm Assistant Group' },
  'medical-research': { name: 'Medical Research Group' },
  'financial-research': { name: 'Financial Research Group' },
}

const ROLE_NAME_TRANSLATIONS: Record<string, string> = Object.fromEntries([
  ['学习规划师', 'StudyPlanner'],
  ['知识讲解老师', 'ConceptTutor'],
  ['错题复盘师', 'MistakeReviewer'],
  ['记忆与复习教练', 'MemoryCoach'],
  ['考试策略师', 'ExamStrategist'],
  ['学习反馈教练', 'StudyFeedbackCoach'],
  ['大纲拆解员', 'SyllabusMapper'],
  ['真题研究员', 'PastPaperResearcher'],
  ['复习计划师', 'ReviewPlanner'],
  ['模拟考官', 'MockExaminer'],
  ['弱点诊断师', 'WeaknessDiagnostician'],
  ['心态恢复教练', 'MindsetRecoveryCoach'],
  ['选题评估顾问', 'TopicEvaluator'],
  ['文献脉络整理员', 'LiteratureMapper'],
  ['研究方法顾问', 'MethodsAdvisor'],
  ['论文结构编辑', 'ThesisStructureEditor'],
  ['学术语言润色师', 'AcademicLanguageEditor'],
  ['学术风险审查员', 'AcademicRiskReviewer'],
  ['选校定位顾问', 'SchoolPositioningAdvisor'],
  ['背景评估师', 'BackgroundEvaluator'],
  ['文书叙事导师', 'EssayNarrativeCoach'],
  ['申请简历顾问', 'ApplicationResumeAdvisor'],
  ['面试教练', 'InterviewCoach'],
  ['签证材料审核员', 'VisaMaterialsReviewer'],
  ['日程管家', 'ScheduleSteward'],
  ['邮件与消息助手', 'EmailMessageAssistant'],
  ['会议纪要员', 'MeetingNoteTaker'],
  ['任务拆解员', 'TaskDecomposer'],
  ['优先级排序顾问', 'PriorityAdvisor'],
  ['每日复盘员', 'DailyReviewFacilitator'],
  ['项目计划经理', 'ProjectPlanningManager'],
  ['进度追踪员', 'ProgressTracker'],
  ['项目风险审查员', 'ProjectRiskReviewer'],
  ['跨部门协调员', 'CrossTeamCoordinator'],
  ['项目指标分析师', 'ProjectMetricsAnalyst'],
  ['复盘主持人', 'RetrospectiveFacilitator'],
  ['职业方向规划师', 'CareerDirectionPlanner'],
  ['JD拆解师', 'JDAnalyzer'],
  ['简历证据优化师', 'ResumeEvidenceOptimizer'],
  ['面试官模拟器', 'InterviewerSimulator'],
  ['案例题教练', 'CaseInterviewCoach'],
  ['薪资谈判顾问', 'SalaryNegotiationAdvisor'],
  ['选题编辑', 'TopicEditor'],
  ['资料研究员', 'Researcher'],
  ['主笔', 'LeadWriter'],
  ['标题与开头顾问', 'HeadlineOpeningAdvisor'],
  ['事实核查员', 'FactChecker'],
  ['传播设计顾问', 'DistributionDesignAdvisor'],
  ['选题策划', 'TopicPlanner'],
  ['爆款拆解师', 'ViralContentAnalyst'],
  ['脚本作者', 'Scriptwriter'],
  ['分镜导演', 'StoryboardDirector'],
  ['标题封面顾问', 'TitleCoverAdvisor'],
  ['完播率优化师', 'CompletionRateOptimizer'],
  ['用户洞察师', 'UserInsightAnalyst'],
  ['笔记选题策划', 'PostTopicPlanner'],
  ['种草文案师', 'SeedingCopywriter'],
  ['评论区运营', 'CommentOpsManager'],
  ['内容合规审查员', 'ContentComplianceReviewer'],
  ['世界观设计师', 'WorldbuildingDesigner'],
  ['角色设计师', 'CharacterDesigner'],
  ['情节架构师', 'PlotArchitect'],
  ['场景描写师', 'SceneWriter'],
  ['对白编辑', 'DialogueEditor'],
  ['读者体验审查员', 'ReaderExperienceReviewer'],
  ['商业模式顾问', 'BusinessModelAdvisor'],
  ['用户研究员', 'UserResearcher'],
  ['MVP产品经理', 'MVPProductManager'],
  ['增长实验顾问', 'GrowthExperimentAdvisor'],
  ['创业财务顾问', 'StartupFinanceAdvisor'],
  ['创业风险审查员', 'StartupRiskReviewer'],
  ['需求产品经理', 'RequirementsProductManager'],
  ['工程评估师', 'EngineeringEvaluator'],
  ['产品设计师', 'ProductDesigner'],
  ['指标与实验分析师', 'MetricsExperimentAnalyst'],
  ['增长价值评审员', 'GrowthValueReviewer'],
  ['产品定位顾问', 'ProductPositioningAdvisor'],
  ['轻量技术架构师', 'LeanTechArchitect'],
  ['定价与包装顾问', 'PricingPackagingAdvisor'],
  ['冷启动顾问', 'ColdStartAdvisor'],
  ['落地执行教练', 'ExecutionCoach'],
  ['用户反馈分析师', 'UserFeedbackAnalyst'],
  ['投资人模拟器', 'InvestorSimulator'],
  ['BP结构顾问', 'BPStructureAdvisor'],
  ['市场规模分析师', 'MarketSizingAnalyst'],
  ['财务模型师', 'FinancialModeler'],
  ['竞争分析师', 'CompetitiveAnalyst'],
  ['风险质询官', 'RiskQuestioner'],
  ['用户画像分析师', 'PersonaAnalyst'],
  ['渠道策略师', 'ChannelStrategist'],
  ['转化率优化师', 'ConversionRateOptimizer'],
  ['A/B测试设计师', 'ABTestDesigner'],
  ['增长数据分析师', 'GrowthDataAnalyst'],
  ['留存运营顾问', 'RetentionOpsAdvisor'],
  ['客户分层画像师', 'CustomerSegmentationAnalyst'],
  ['需求挖掘话术教练', 'DiscoveryScriptCoach'],
  ['客户异议模拟器', 'ObjectionSimulator'],
  ['跟进节奏策略师', 'FollowUpCadenceStrategist'],
  ['成交流程推进顾问', 'DealFlowAdvisor'],
  ['CRM复盘记录员', 'CRMReviewRecorder'],
  ['品牌定位架构师', 'BrandPositioningArchitect'],
  ['用户心智研究员', 'CustomerMindsetResearcher'],
  ['品牌表达文案总监', 'BrandCopyDirector'],
  ['视觉方向顾问', 'VisualDirectionAdvisor'],
  ['竞品差异分析师', 'CompetitorDifferentiationAnalyst'],
  ['公关风险审查员', 'PRRiskReviewer'],
  ['需求澄清架构师', 'RequirementClarificationArchitect'],
  ['后端实现工程师', 'BackendImplementationEngineer'],
  ['前端交互工程师', 'FrontendInteractionEngineer'],
  ['质量测试工程师', 'QAEngineer'],
  ['DevOps发布工程师', 'DevOpsReleaseEngineer'],
  ['防御安全审查员', 'DefensiveSecurityReviewer'],
  ['Agent任务产品经理', 'AgentTaskProductManager'],
  ['Prompt规范工程师', 'PromptSpecEngineer'],
  ['工作流编排架构师', 'WorkflowOrchestrationArchitect'],
  ['工具调用与权限工程师', 'ToolPermissionEngineer'],
  ['Agent评测工程师', 'AgentEvaluationEngineer'],
  ['安全与治理审查员', 'SafetyGovernanceReviewer'],
  ['指标口径分析师', 'MetricDefinitionAnalyst'],
  ['指标体系顾问', 'MetricsSystemAdvisor'],
  ['SQL查询构造员', 'SQLQueryBuilder'],
  ['可视化看板设计师', 'DashboardDesigner'],
  ['业务假设解释员', 'BusinessHypothesisInterpreter'],
  ['数据决策实验设计师', 'DataDecisionExperimentDesigner'],
  ['战略取舍顾问', 'StrategicTradeoffAdvisor'],
  ['经营财务顾问', 'BusinessFinanceAdvisor'],
  ['组织能力顾问', 'OrgCapabilityAdvisor'],
  ['市场机会顾问', 'MarketOpportunityAdvisor'],
  ['合规与法务风险顾问', 'ComplianceLegalRiskAdvisor'],
  ['反方论证顾问', 'DevilAdvocate'],
  ['管理目标教练', 'ManagementGoalCoach'],
  ['绩效标准顾问', 'PerformanceStandardsAdvisor'],
  ['困难沟通教练', 'DifficultConversationCoach'],
  ['冲突调解员', 'ConflictMediator'],
  ['会议机制设计师', 'MeetingSystemDesigner'],
  ['员工视角模拟器', 'EmployeePerspectiveSimulator'],
  ['岗位能力设计师', 'RoleCapabilityDesigner'],
  ['简历证据筛选员', 'ResumeEvidenceScreener'],
  ['结构化面试官', 'StructuredInterviewer'],
  ['薪酬区间顾问', 'CompensationRangeAdvisor'],
  ['文化与协作评估员', 'CultureCollaborationEvaluator'],
  ['入职体验设计师', 'OnboardingExperienceDesigner'],
  ['预算规划师', 'BudgetPlanner'],
  ['储蓄与应急金教练', 'SavingsEmergencyFundCoach'],
  ['债务管理顾问', 'DebtManagementAdvisor'],
  ['投资知识老师', 'InvestmentLiteracyTutor'],
  ['财务风险提醒员', 'FinancialRiskReminder'],
  ['保障与生活方式顾问', 'ProtectionLifestyleAdvisor'],
  ['记账顾问', 'BookkeepingAdvisor'],
  ['成本分析师', 'CostAnalyst'],
  ['定价顾问', 'PricingAdvisor'],
  ['现金流顾问', 'CashflowAdvisor'],
  ['税务提醒员', 'TaxReminder'],
  ['经营建议员', 'BusinessOperationsAdvisor'],
  ['合同结构分析师', 'ContractStructureAnalyst'],
  ['合同风险审查员', 'ContractRiskReviewer'],
  ['商务谈判顾问', 'CommercialNegotiationAdvisor'],
  ['权责对照员', 'RightsObligationsMapper'],
  ['付款条款审查员', 'PaymentTermsReviewer'],
  ['法域与律师确认清单员', 'LegalJurisdictionChecklistReviewer'],
  ['选品顾问', 'ProductSelectionAdvisor'],
  ['竞品分析师', 'CompetitorAnalyst'],
  ['详情页文案师', 'ProductPageCopywriter'],
  ['广告投放顾问', 'AdCampaignAdvisor'],
  ['客服话术师', 'CustomerServiceScriptwriter'],
  ['复购运营顾问', 'RepeatPurchaseOpsAdvisor'],
  ['门店定位顾问', 'StorePositioningAdvisor'],
  ['活动策划师', 'CampaignPlanner'],
  ['点评优化师', 'ReviewOptimizationAdvisor'],
  ['私域运营顾问', 'PrivateTrafficOpsAdvisor'],
  ['短视频顾问', 'ShortVideoAdvisor'],
  ['复购顾问', 'RepeatPurchaseAdvisor'],
  ['菜单顾问', 'MenuAdvisor'],
  ['成本控制师', 'CostController'],
  ['外卖运营顾问', 'DeliveryOpsAdvisor'],
  ['用户评价分析师', 'CustomerReviewAnalyst'],
  ['店长顾问', 'StoreManagerAdvisor'],
  ['问题诊断师', 'ProblemDiagnostician'],
  ['行业研究员', 'IndustryResearcher'],
  ['框架顾问', 'FrameworkAdvisor'],
  ['方案设计师', 'SolutionDesigner'],
  ['PPT结构师', 'DeckStructureDesigner'],
  ['客户质询模拟器', 'ClientQuestionSimulator'],
  ['课程设计师', 'CurriculumDesigner'],
  ['教案编写员', 'LessonPlanWriter'],
  ['练习题设计师', 'ExerciseDesigner'],
  ['学生理解模拟器', 'StudentUnderstandingSimulator'],
  ['课堂互动设计师', 'ClassroomInteractionDesigner'],
  ['作业批改助手', 'HomeworkReviewAssistant'],
  ['情绪倾听者', 'EmotionListener'],
  ['CBT自助练习引导员', 'CBTSelfHelpGuide'],
  ['习惯教练', 'HabitCoach'],
  ['关系沟通顾问', 'RelationshipCommunicationAdvisor'],
  ['价值澄清教练', 'ValuesClarificationCoach'],
  ['安全与求助资源提醒员', 'SafetyResourceReminder'],
  ['市场分析师', 'MarketAnalyst'],
  ['区域研究员', 'RegionalResearcher'],
  ['贷款顾问', 'LoanAdvisor'],
  ['合同风险员', 'ContractRiskChecker'],
  ['谈判顾问', 'NegotiationAdvisor'],
  ['装修预算顾问', 'RenovationBudgetAdvisor'],
  ['空间设计师', 'SpaceDesigner'],
  ['预算控制师', 'BudgetController'],
  ['材料顾问', 'MaterialsAdvisor'],
  ['施工监理', 'ConstructionSupervisor'],
  ['收纳顾问', 'StorageAdvisor'],
  ['风格顾问', 'StyleAdvisor'],
  ['行程规划师', 'ItineraryPlanner'],
  ['酒店顾问', 'HotelAdvisor'],
  ['美食顾问', 'FoodAdvisor'],
  ['交通顾问', 'TransportAdvisor'],
  ['预算顾问', 'BudgetAdvisor'],
  ['风险提醒员', 'RiskReminder'],
  ['训练教练', 'TrainingCoach'],
  ['饮食规划师', 'NutritionPlanner'],
  ['动作纠正员', 'MovementCorrectionCoach'],
  ['数据记录员', 'DataRecorder'],
  ['健康风险提醒员', 'HealthRiskReminder'],
  ['症状整理员', 'SymptomOrganizer'],
  ['病史记录员', 'MedicalHistoryRecorder'],
  ['检查单解释员', 'TestReportExplainer'],
  ['就诊问题设计师', 'DoctorVisitQuestionDesigner'],
  ['用药信息提醒员', 'MedicationInfoReminder'],
  ['专业就医提醒员', 'ProfessionalCareReminder'],
  ['作物顾问', 'CropAdvisor'],
  ['病虫害分析师', 'PestDiseaseAnalyst'],
  ['土壤顾问', 'SoilAdvisor'],
  ['农资采购顾问', 'FarmInputProcurementAdvisor'],
  ['销售渠道顾问', 'SalesChannelAdvisor'],
  ['天气风险提醒员', 'WeatherRiskReminder'],
  ['生产流程顾问', 'ProductionProcessAdvisor'],
  ['质量管理顾问', 'QualityManagementAdvisor'],
  ['设备维护顾问', 'EquipmentMaintenanceAdvisor'],
  ['生产安全员', 'ProductionSafetyOfficer'],
  ['交付计划员', 'DeliveryPlanner'],
  ['供应商筛选员', 'SupplierScreener'],
  ['报价分析师', 'QuotationAnalyst'],
  ['库存规划师', 'InventoryPlanner'],
  ['物流顾问', 'LogisticsAdvisor'],
  ['供应链质量审查员', 'SupplyChainQualityReviewer'],
  ['项目计划员', 'ProjectPlanner'],
  ['预算员', 'Estimator'],
  ['施工协调员', 'ConstructionCoordinator'],
  ['工程安全提醒员', 'EngineeringSafetyReminder'],
  ['材料采购与质量资料员', 'MaterialsProcurementQualityClerk'],
  ['工程风险审查员', 'EngineeringRiskReviewer'],
  ['案件事实整理员', 'CaseFactOrganizer'],
  ['法规检索员', 'LegalResearcher'],
  ['证据清单员', 'EvidenceChecklistClerk'],
  ['文书草拟员', 'LegalDraftingAssistant'],
  ['对方观点模拟器', 'OpposingViewSimulator'],
  ['程序期限与风险提示员', 'ProcedureDeadlineRiskReminder'],
  ['文献检索员', 'LiteratureSearcher'],
  ['临床问题拆解员', 'ClinicalQuestionDecomposer'],
  ['研究设计顾问', 'ResearchDesignAdvisor'],
  ['统计分析师', 'StatisticalAnalyst'],
  ['论文编辑', 'PaperEditor'],
  ['伦理合规提醒员', 'EthicsComplianceReminder'],
  ['宏观分析师', 'MacroAnalyst'],
  ['公司与估值情景分析师', 'CompanyValuationScenarioAnalyst'],
  ['财务报表分析师', 'FinancialStatementAnalyst'],
  ['金融风险控制员', 'FinancialRiskController'],
  ['反方观点分析师', 'ContrarianAnalyst'],
] satisfies Array<readonly [string, string]>)

const ROLE_DESCRIPTION_TRANSLATIONS: Record<string, string> = {
  '学习规划师': 'Turns courses, exams, and self-study goals into realistic daily plans, weekly plans, checkpoints, and review loops.',
  '知识讲解老师': 'Explains a requested concept clearly and checks understanding with examples, counterexamples, mistakes, and short exercises.',
  '错题复盘师': 'Finds knowledge gaps, reading errors, process mistakes, and habit issues from problems, answers, and working steps.',
  '记忆与复习教练': 'Turns memorization and long-term retention work into active-recall, spaced-review, and testing systems.',
  '考试策略师': 'Builds practical exam strategies from scope, scoring rules, time limits, and weak points.',
  '学习反馈教练': 'Reviews learning progress and turns feedback into focused next actions.',
  '大纲拆解员': 'Breaks an exam syllabus into topics, priorities, and review checkpoints.',
  '真题研究员': 'Studies past papers to find patterns, high-frequency topics, and practice priorities.',
  '复习计划师': 'Creates review plans that balance scope, time, weak points, and repetition.',
  '模拟考官': 'Simulates exam questioning and gives structured feedback.',
  '弱点诊断师': 'Diagnoses weak areas and turns them into targeted practice plans.',
  '心态恢复教练': 'Helps recover confidence and focus during stressful preparation cycles.',
}

const ROLE_TEMPLATE_LOCALIZATIONS: Record<string, RoleTemplateLocalization> = {
  'builtin-frankl': { name: 'ViktorFrankl', description: 'Meaning therapy, responsibility, dignity in suffering, and direction for action.' },
  'builtin-camus': { name: 'AlbertCamus', description: 'Absurdity, revolt, freedom, dignity, and clear-eyed living.' },
  'builtin-nietzsche': { name: 'FriedrichNietzsche', description: 'Self-overcoming, revaluing values, amor fati, and life force.' },
  'builtin-wang-yangming': { name: 'WangYangming', description: 'Unity of knowing and doing, conscience, practice in real affairs, and self-cultivation.' },
  'builtin-steve-jobs': { name: 'SteveJobs', description: 'Product taste, focus, tradeoffs, aesthetics, and end-to-end experience.' },
  'builtin-inamori': { name: 'KazuoInamori', description: 'Management, self-cultivation, altruism, diligence, and long-term integrity.' },
  'builtin-drucker': { name: 'PeterDrucker', description: 'Self-management, contribution, time management, and results-oriented work.' },
  'builtin-munger': { name: 'CharlieMunger', description: 'Mental models, inversion, circle of competence, and avoiding major mistakes.' },
  'builtin-buffett': { name: 'WarrenBuffett', description: 'Long-term wealth, compounding, circle of competence, reputation, and prudent money habits.' },
  'builtin-howard-marks': { name: 'HowardMarks', description: 'Risk, cycles, probability, second-order thinking, and market psychology.' },
  'builtin-graham': { name: 'BenjaminGraham', description: 'Value investing, margin of safety, defensive investing, and Mr. Market.' },
  'builtin-peter-lynch': { name: 'PeterLynch', description: 'Everyday investment observation, fundamental research, and common-sense judgment.' },
  'builtin-dalio': { name: 'RayDalio', description: 'Principles, reflection, radical truth, systematic decision-making, and risk diversification.' },
  'builtin-naval': { name: 'NavalRavikant', description: 'Wealth, freedom, specific knowledge, leverage, ownership, and happiness.' },
  'builtin-zhang-yiming': { name: 'ZhangYiming', description: 'Long-term growth, delayed gratification, real feedback, and equanimity.' },
  'builtin-ren-zhengfei': { name: 'RenZhengfei', description: 'Organizational capability, customer value, crisis awareness, and growth from real battles.' },
  'builtin-feynman': { name: 'RichardFeynman', description: 'Learning, understanding, curiosity, simple explanation, and anti-jargon thinking.' },
  'builtin-kahneman': { name: 'DanielKahneman', description: 'Judgment bias, slow thinking, evidence, and decision process design.' },
  'builtin-taleb': { name: 'NassimTaleb', description: 'Antifragility, black swans, nonlinear risk, and barbell strategy.' },
  'builtin-bezos': { name: 'JeffBezos', description: 'Customer obsession, long-term thinking, flywheels, and working backwards.' },
  'builtin-musk': { name: 'ElonMusk', description: 'First principles, engineering decomposition, speed, and real constraints.' },
  'builtin-paul-graham': { name: 'PaulGraham', description: 'Early startups, MVPs, user pain, and doing things that do not scale.' },
  'builtin-thiel': { name: 'PeterThiel', description: 'Zero to one thinking, secrets, moats, and avoiding commodity competition.' },
  'builtin-huang-zheng': { name: 'HuangZheng', description: 'Supply-demand structure, group psychology, efficiency, price, and trust.' },
  'builtin-sam-altman': { name: 'SamAltman', description: 'AI-era opportunity, startups, fast learning, major trends, and leverage.' },
  'builtin-adler': { name: 'AlfredAdler', description: 'Inferiority and striving, separation of tasks, community feeling, and courage.' },
  'builtin-jung': { name: 'CarlJung', description: 'Shadow, persona, individuation, self-integration, and projection.' },
  'builtin-schopenhauer': { name: 'ArthurSchopenhauer', description: 'Desire, suffering, comparison, solitude, aesthetics, and restraint.' },
  'builtin-fei-xiaotong': { name: 'FeiXiaotong', description: 'Rural China, differential association, family ethics, and social pressure.' },
  'builtin-liang-shuming': { name: 'LiangShuming', description: 'Chinese culture, ethical relationships, life settlement, and modern tensions.' },
  'builtin-waldinger': { name: 'RobertWaldinger', description: 'Harvard adult development research, relationship quality, happiness, and long-term connection.' },
  'builtin-school-of-life': { name: 'SchoolOfLife', description: 'Emotional education, relationship repair, self-understanding, and practical philosophy.' },
  'builtin-kevin-kelly': { name: 'KevinKelly', description: 'Technology trends, complex systems, AI, creator economy, and experimentation.' },
  'builtin-toffler': { name: 'AlvinToffler', description: 'Future shock, the third wave, technology speed, and adaptation.' },
  'builtin-einstein': { name: 'AlbertEinstein', description: 'Curiosity, imagination, independent thinking, simple questions, and scientific spirit.' },
  'builtin-80000-hours': { name: 'EightyThousandHours', description: 'High-impact careers, fit, career capital, and exploration value.' },
  'builtin-who-health': { name: 'WHOHealth', description: 'Sleep, movement, nutrition, stress, and sustainable health habits.' },
  'builtin-wef-future': { name: 'WEFFuture', description: 'Global trends, future work, AI, macro risks, and skill building.' },
  'default-custom-product-manager': { name: 'ProductManager', description: 'Focuses on user needs, priorities, tradeoffs, and product experience.' },
  'default-custom-engineer': { name: 'Engineer', description: 'Focuses on implementation, complexity, stability, and maintainability.' },
  'default-custom-growth': { name: 'GrowthAdvisor', description: 'Focuses on target users, conversion paths, distribution, retention, and experiments.' },
}

const USER_TYPE_TRANSLATIONS: Record<string, string> = {
  '中学生': 'Middle school students',
  '大学生': 'College students',
  '自学者': 'Self-learners',
  '考研': 'Graduate exam candidates',
  '考公': 'Civil-service exam candidates',
  '本科生': 'Undergraduates',
  '研究生': 'Graduate students',
  '博士生': 'Doctoral students',
  '科研新人': 'New researchers',
  '知识工作者': 'Knowledge workers',
  '白领': 'Office workers',
  '远程工作者': 'Remote workers',
  '自由职业者': 'Freelancers',
  '项目经理': 'Project managers',
  '团队负责人': 'Team leads',
  '运营负责人': 'Operations leads',
  '求职者': 'Job seekers',
  '转行者': 'Career changers',
  '应届生': 'New graduates',
  '创业者': 'Founders',
  '独立开发者': 'Indie developers',
  '小团队老板': 'Small-team owners',
  '产品经理': 'Product managers',
  '程序员': 'Programmers',
  '技术负责人': 'Technical leads',
  '销售': 'Salespeople',
  '市场团队': 'Marketing teams',
  '老师': 'Teachers',
  '咨询师': 'Consultants',
  '顾问': 'Advisors',
  '医生': 'Doctors',
  '律师': 'Lawyers',
  '法务': 'Legal staff',
  '普通个人': 'Individuals',
  '家庭用户': 'Households',
  '小老板': 'Small business owners',
  '个体户': 'Solo business owners',
}

export function normalizeLanguage(value: unknown): TeamLanguage {
  return value === 'zh-CN' ? 'zh-CN' : DEFAULT_LANGUAGE
}

export function defaultLanguageForEnvironment(navigatorLike: Pick<Navigator, 'language' | 'languages'> | undefined = globalThis.navigator): TeamLanguage {
  const languages = [
    ...(Array.isArray(navigatorLike?.languages) ? navigatorLike.languages : []),
    navigatorLike?.language,
  ].filter((language): language is string => typeof language === 'string')
  return languages.some(language => /^zh(?:-|$)/i.test(language)) ? 'zh-CN' : DEFAULT_LANGUAGE
}

export function translateUi(source: string, language: TeamLanguage): string {
  if (language === 'zh-CN') return source
  return UI_TRANSLATIONS[source] ?? translateUiPattern(source) ?? source
}

export function localizeCategory(category: string | undefined, language: TeamLanguage): string | undefined {
  if (!category) return undefined
  if (normalizeLanguage(language) === 'zh-CN') return category
  return CATEGORY_TRANSLATIONS[category] ?? category
}

export function localizeGroupTemplate(template: BuiltinGroupTemplate, language: TeamLanguage): BuiltinGroupTemplate {
  if (normalizeLanguage(language) === 'zh-CN') return template
  const localization = GROUP_TEMPLATE_LOCALIZATIONS[template.id]
  const name = localization?.name ?? fallbackGroupTemplateName(template)
  return {
    ...template,
    name,
    category: localizeCategory(template.category, 'en') ?? template.category,
    summary: localization?.summary ?? fallbackGroupSummary(name),
    userTypes: localizeUserTypes(template.userTypes, localization),
    aliases: englishTemplateAliases(template, name),
    suggestedQuestions: englishTemplateQuestions(name),
    defaultChatName: name,
    roles: template.roles.map(role => localizeGroupTemplateRole(template, role, name)),
  }
}

export function localizeRoleTemplate(template: RoleTemplate, language: TeamLanguage): RoleTemplate {
  if (normalizeLanguage(language) === 'zh-CN') return template
  const direct = ROLE_TEMPLATE_LOCALIZATIONS[template.id]
  if (direct) {
    return {
      ...template,
      name: direct.name,
      category: localizeCategory(template.category, 'en'),
      description: direct.description,
      sourceTemplateName: localizeSourceTemplateName(template.sourceTemplateId, template.sourceTemplateName),
      systemPrompt: direct.systemPrompt ?? englishAdvisorPrompt(direct.name, direct.description),
    }
  }

  if (template.sourceTemplateId) {
    const sourceTemplateName = localizeSourceTemplateName(template.sourceTemplateId, template.sourceTemplateName)
    const roleName = localizeRoleName(template.name, sourceTemplateName, template.sourceTemplateId)
    const description = localizeRoleDescription(template.name, sourceTemplateName)
    return {
      ...template,
      name: roleName,
      category: localizeCategory(template.category, 'en'),
      description,
      sourceTemplateName,
      systemPrompt: englishRolePrompt(roleName, description),
    }
  }

  if (template.type === 'builtin') {
    const roleName = fallbackRoleName(template.name, 'BuiltInAdvisor')
    const description = 'Built-in advisor persona.'
    return {
      ...template,
      name: roleName,
      category: localizeCategory(template.category, 'en'),
      description,
      systemPrompt: englishRolePrompt(roleName, description),
    }
  }

  return template
}

function translateUiPattern(source: string): string | undefined {
  const storeSummary = source.match(/^(\d+) 个群聊 · (\d+) 个人员库人员$/)
  if (storeSummary) return `${storeSummary[1]} chats · ${storeSummary[2]} people`
  const agentControlPort = source.match(/^端口 (\d+)，仅允许本机连接。(?:开启后本机工具可创建群聊并发送任务。)?$/)
  if (agentControlPort) {
    return `Port ${agentControlPort[1]}; local connections only.${source.includes('开启后') ? ' When enabled, local tools can create chats and send tasks.' : ''}`
  }
  const agentControlConnected = source.match(/^已连接 OpenTeam CLI daemon（端口 (\d+)）。本机工具可以创建群聊并发送任务。$/)
  if (agentControlConnected) return `Connected to OpenTeam CLI daemon (port ${agentControlConnected[1]}). Local tools can create chats and send tasks.`
  const agentControlConnecting = source.match(/^正在连接 OpenTeam CLI daemon（端口 (\d+)）。$/)
  if (agentControlConnecting) return `Connecting to OpenTeam CLI daemon (port ${agentControlConnecting[1]}).`
  const agentControlDisconnected = source.match(/^未连接 OpenTeam CLI daemon（端口 (\d+)）。请安装 OpenTeam CLI，或运行 openteamcli daemon start 启动守护进程。$/)
  if (agentControlDisconnected) return `Not connected to OpenTeam CLI daemon (port ${agentControlDisconnected[1]}). Install OpenTeam CLI, or run openteamcli daemon start to start the daemon.`
  const currentPerson = source.match(/^(\d+) 人员 · 当前：(.+)$/)
  if (currentPerson) return `${currentPerson[1]} people · Current: ${currentPerson[2]}`
  const memberCount = source.match(/^成员 (\d+)$/)
  if (memberCount) return `Members ${memberCount[1]}`
  const summarizerAnswered = source.match(/^「(.+)」也回答了这个问题，汇总可能偏向自己的观点。换一位没参与回答、或用不同模型的人员会更客观。$/)
  if (summarizerAnswered) return `${summarizerAnswered[1]} answered this question too, so the summary may lean toward its own view. Someone who did not answer, or on another model, would be more neutral.`
  const editModel = source.match(/^修改「(.+)」$/)
  if (editModel) return `Edit "${editModel[1]}"`
  const memberSummary = source.match(/^(\d+) 位成员(?: · 当前：(.+))?$/)
  if (memberSummary) return memberSummary[2] ? `${memberSummary[1]} members · Current: ${memberSummary[2]}` : `${memberSummary[1]} members`
  const memberMenu = source.match(/^(.+) 的更多操作$/)
  if (memberMenu) return `More for ${memberMenu[1]}`
  const roleSummaryCount = source.match(/^(\d+) 人员$/)
  if (roleSummaryCount) return `${roleSummaryCount[1]} people`
  const peopleCount = source.match(/^(\d+) 个人员$/)
  if (peopleCount) return `${peopleCount[1]} people`
  const peopleSummary = source.match(/^(\d+) 人$/)
  if (peopleSummary) return `${peopleSummary[1]} people`
  const roleCount = source.match(/^(\d+) 个角色$/)
  if (roleCount) return `${roleCount[1]} roles`
  const readCount = source.match(/^已读 (\d+) 条$/)
  if (readCount) return `Read ${readCount[1]} messages`
  const defaultModel = source.match(/^默认模型：(.+)$/)
  if (defaultModel) return `Default model: ${translateUi(defaultModel[1], 'en')}`
  const appliesTo = source.match(/^适用：(.+)$/)
  if (appliesTo) return `For: ${appliesTo[1]}`
  const editPerson = source.match(/^编辑人员：(.+)$/)
  if (editPerson) return `Edit person: ${editPerson[1]}`
  const deletedChat = source.match(/^已删除群聊 (.+)$/)
  if (deletedChat) return `Deleted chat ${deletedChat[1]}`
  const missingPeople = source.match(/^没有匹配的(内置|自定义)人员$/)
  if (missingPeople) return `No matching ${missingPeople[1] === '内置' ? 'built-in' : 'custom'} people`
  const emptyPeople = source.match(/^暂无(内置|自定义)人员$/)
  if (emptyPeople) return `No ${emptyPeople[1] === '内置' ? 'built-in' : 'custom'} people yet`
  const emptyCategory = source.match(/^当前分类暂无(内置|自定义)人员$/)
  if (emptyCategory) return `No ${emptyCategory[1] === '内置' ? 'built-in' : 'custom'} people in this category`
  const colonLabel = source.match(/^(.+)：$/)
  if (colonLabel && UI_TRANSLATIONS[colonLabel[1]]) return `${UI_TRANSLATIONS[colonLabel[1]]}:`
  const quote = source.match(/^引用 (.+)：(.+)$/)
  if (quote) return `Quote ${quote[1]}: ${quote[2]}`
  const highlightColor = source.match(/^高亮颜色：(.+)$/)
  if (highlightColor) return `Highlight color: ${translateUi(highlightColor[1], 'en')}`
  const orchestrationStep = source.match(/^第 (\d+) 步$/)
  if (orchestrationStep) return `Step ${orchestrationStep[1]}`
  const headerSummary = source.match(/^(协作群聊模式|独立专家模式) · (\d+) 位成员 · (\d+) 条消息$/)
  if (headerSummary) return `${translateUi(headerSummary[1], 'en')} · ${headerSummary[2]} members · ${headerSummary[3]} messages`
  if (source.includes(' · ')) return source.split(' · ').map(part => translateUi(part, 'en')).join(' · ')
  const sendWithConnecting = source.match(/^将发送给：(.+)；正在连接：(.+)$/)
  if (sendWithConnecting) return `Will send to: ${sendWithConnecting[1]}; connecting: ${sendWithConnecting[2]}`
  const compareReplies = source.match(/^⇆ 对比 (\d+) 个回复$/)
  if (compareReplies) return `⇆ Compare ${compareReplies[1]} replies`
  const discussionRequested = source.match(/^已请 (\d+) 位人员针对分歧讨论$/)
  if (discussionRequested) return `Asked ${discussionRequested[1]} people to discuss their differences`
  const summaryRequested = source.match(/^已请 (.+) 汇总异同$/)
  if (summaryRequested) return `Asked ${summaryRequested[1]} to summarize the differences`
  const searchCountLimited = source.match(/^找到 (\d+) 条消息，显示最近 (\d+) 条$/)
  if (searchCountLimited) return `${searchCountLimited[1]} messages found, showing the latest ${searchCountLimited[2]}`
  const searchCount = source.match(/^找到 (\d+) 条消息$/)
  if (searchCount) return `${searchCount[1]} ${searchCount[1] === '1' ? 'message' : 'messages'} found`
  const uploadLimit = source.match(/^一条消息最多 (\d+) 个附件$/)
  if (uploadLimit) return `A message can have at most ${uploadLimit[1]} attachments`
  const uploadUnsupported = source.match(/^不支持这种文件：(.+)。可以上传 PDF、Word、PowerPoint、Excel 文件，PNG、JPEG、WebP、GIF 图片，或文本、Markdown、代码等文本文件。$/)
  if (uploadUnsupported) return `Unsupported file: ${uploadUnsupported[1]}. You can attach PDF, Word, PowerPoint or Excel files, PNG, JPEG, WebP or GIF images, or text files such as text, Markdown or code.`
  const legacyOffice = source.match(/^暂不支持旧版 Office 文件：(.+)。请另存为 \.docx、\.pptx、\.xlsx 或 PDF 后再上传。$/)
  if (legacyOffice) return `Older Office files are not supported yet: ${legacyOffice[1]}. Save it as .docx, .pptx, .xlsx or PDF and attach it again.`
  const documentTooLarge = source.match(/^文件太大：(.+)（最大 30 MB）$/)
  if (documentTooLarge) return `File too large: ${documentTooLarge[1]} (30 MB at most)`
  const documentTooLong = source.match(/^文件里的文字太多：(.+)（最多 1 MB 文字）$/)
  if (documentTooLong) return `Too much text in ${documentTooLong[1]} (1 MB of text at most)`
  const scannedPdf = source.match(/^没有读到文字：(.+)（可能是扫描件或图片）。可以把页面截图后作为图片发送。$/)
  if (scannedPdf) return `No text found in ${scannedPdf[1]} (it may be a scan or pictures). You can send screenshots of its pages as images.`
  const noText = source.match(/^没有读到文字：(.+)$/)
  if (noText) return `No text found in ${noText[1]}`
  const passwordFile = source.match(/^无法打开有密码的文件：(.+)$/)
  if (passwordFile) return `Cannot open a password-protected file: ${passwordFile[1]}`
  const unreadableFile = source.match(/^无法读取文件：(.+)（文件已损坏或格式不对）$/)
  if (unreadableFile) return `Cannot read ${unreadableFile[1]} (the file is damaged or not in the expected format)`
  const summaryAsked = source.match(/^已请「(.+)」汇总本轮回复$/)
  if (summaryAsked) return `Asked ${summaryAsked[1]} to summarize this round`
  const discussionRunning = source.match(/^轮流讨论中 · 第 (\d+)\/(\d+) 轮$/)
  if (discussionRunning) return `Discussion running · turn ${discussionRunning[1]}/${discussionRunning[2]}`
  const discussionSpeaker = source.match(/^「(.+)」正在发言。你现在发的消息会作为补充，给下一位发言的成员看。$/)
  if (discussionSpeaker) return `${discussionSpeaker[1]} is speaking. What you send now is added as a note for the next speaker.`
  const discussionDone = source.match(/^讨论(结束|已停止) · 共 (\d+) 轮$/)
  if (discussionDone) return `Discussion ${discussionDone[1] === '结束' ? 'finished' : 'stopped'} · ${discussionDone[2]} turns`
  const discussionHandoff = source.match(/^第 (\d+)\/(\d+) 轮 · 「(.+)」请「(.+)」接着说$/)
  if (discussionHandoff) return `Turn ${discussionHandoff[1]}/${discussionHandoff[2]}: ${discussionHandoff[3]} asked ${discussionHandoff[4]} to speak`
  const discussionTurn = source.match(/^第 (\d+)\/(\d+) 轮 · 请「(.+)」发言$/)
  if (discussionTurn) return `Turn ${discussionTurn[1]}/${discussionTurn[2]}: ${discussionTurn[3]} speaks`
  const projectTask = source.match(/^任务 (\S+) · (.+)$/)
  if (projectTask) return `Task ${projectTask[1]} · ${projectTask[2]}`
  const projectPlan = source.match(/^项目 · 请「(.+)」(拆分任务|检查结果|整理最终交付)$/)
  if (projectPlan) return `Project · ${projectPlan[1]} ${projectPlan[2] === '拆分任务' ? 'plans the tasks' : projectPlan[2] === '检查结果' ? 'checks the results' : 'writes the final deliverable'}`
  const projectTaskTo = source.match(/^项目 · 任务 (\S+)「(.+)」交给「(.+)」(?:（第 (\d+) 次）)?$/)
  if (projectTaskTo) return `Project · task ${projectTaskTo[1]} "${projectTaskTo[2]}" to ${projectTaskTo[3]}${projectTaskTo[4] ? ` (try ${projectTaskTo[4]})` : ''}`
  const documentPage = source.match(/^—— 第 (\d+) 页 ——$/)
  if (documentPage) return `—— Page ${documentPage[1]} ——`
  const documentSheet = source.match(/^—— 工作表：(.+) ——$/)
  if (documentSheet) return `—— Sheet: ${documentSheet[1]} ——`
  const charactersRead = source.match(/^(\d+) 字$/)
  if (charactersRead) return `${charactersRead[1]} ${charactersRead[1] === '1' ? 'character' : 'characters'}`
  const imageTooLarge = source.match(/^图片太大：(.+)（最大 10 MB）$/)
  if (imageTooLarge) return `Image too large: ${imageTooLarge[1]} (10 MB at most)`
  const textTooLarge = source.match(/^文本文件太大：(.+)（最大 1 MB）$/)
  if (textTooLarge) return `Text file too large: ${textTooLarge[1]} (1 MB at most)`
  const unreadableText = source.match(/^无法读取文本文件：(.+)（不是 UTF-8 文本）$/)
  if (unreadableText) return `Cannot read text file: ${unreadableText[1]} (not UTF-8 text)`
  const download = source.match(/^下载 (.+)$/)
  if (download) return `Download ${download[1]}`
  const backupExported = source.match(/^已导出备份：(\d+) 个群聊、(\d+) 条消息$/)
  if (backupExported) return `Backup exported: ${backupExported[1]} chats, ${backupExported[2]} messages`
  const backupReplaced = source.match(/^已用备份替换全部数据：(\d+) 个群聊$/)
  if (backupReplaced) return `All data replaced from the backup: ${backupReplaced[1]} chats`
  const backupMerged = source.match(/^已恢复：新增 (\d+) 个群聊(?:，跳过 (\d+) 个已存在的群聊)?$/)
  if (backupMerged) return `Restored: ${backupMerged[1]} chats added${backupMerged[2] ? `, ${backupMerged[2]} existing chats skipped` : ''}`
  const backupReplaceConfirm = source.match(/^替换会删除当前的 (\d+) 个群聊和它们的消息，换成备份里的数据。替换前会先下载一份当前数据的备份。继续吗？$/)
  if (backupReplaceConfirm) return `Replacing deletes your current ${backupReplaceConfirm[1]} chats and their messages and puts the backup's data in their place. A backup of the current data is downloaded first. Continue?`
  const backupExisting = source.match(/^备份里有 (\d+) 个群聊当前已经存在，合并时会保留当前的版本。$/)
  if (backupExisting) return `${backupExisting[1]} chats in the backup already exist here; merging keeps the current version.`
  const unreachable = source.match(/^网页暂时无法接收：(.+)$/)
  if (unreachable) {
    // Each entry is "<person> <status>"; status labels contain no spaces.
    const people = unreachable[1].split('；').map(item => {
      const person = item.match(/^(.+) (\S+)$/)
      return person ? `${person[1]}: ${translateUi(person[2], 'en')}` : item
    })
    return `Pages that cannot receive messages right now: ${people.join('; ')}`
  }
  const sendWithWaiting = source.match(/^将发送给：(.+)；跳过正在回复：(.+)$/)
  if (sendWithWaiting) return `Will send to: ${sendWithWaiting[1]}; skipping people already replying: ${sendWithWaiting[2]}`
  const sendTo = source.match(/^将发送给：(.+)$/)
  if (sendTo) return `Will send to: ${sendTo[1]}`
  const autoConnecting = source.match(/^正在自动连接：(.+)$/)
  if (autoConnecting) return `Connecting: ${autoConnecting[1]}`
  const connectFirst = source.match(/^将先自动连接：(.+)$/)
  if (connectFirst) return `Will connect first: ${connectFirst[1]}`
  const waitForReply = source.match(/^请稍等：(.+) 正在回复$/)
  if (waitForReply) return `Please wait: ${waitForReply[1]} is replying`
  const replying = source.match(/^正在回复：(.+)$/)
  if (replying) return `Replying: ${replying[1]}`
  return undefined
}

function localizeGroupTemplateRole(template: BuiltinGroupTemplate, role: BuiltinGroupTemplateRole, groupName: string): BuiltinGroupTemplateRole {
  const name = localizeRoleName(role.name, groupName, template.id)
  const description = ROLE_DESCRIPTION_TRANSLATIONS[baseRoleName(role.name)] ?? fallbackRoleDescription(name, groupName)
  return {
    name,
    description,
    systemPrompt: englishRolePrompt(name, description),
  }
}

function localizeRoleName(rawName: string, groupName: string | undefined, sourceTemplateId?: string): string {
  const baseName = baseRoleName(rawName)
  return ROLE_NAME_TRANSLATIONS[baseName] ?? fallbackRoleName(groupName ?? sourceTemplateId ?? rawName, 'Specialist')
}

function localizeRoleDescription(rawName: string, groupName: string | undefined): string {
  return ROLE_DESCRIPTION_TRANSLATIONS[baseRoleName(rawName)] ?? fallbackRoleDescription(localizeRoleName(rawName, groupName), groupName ?? 'this workflow')
}

function localizeSourceTemplateName(sourceTemplateId: string | undefined, sourceTemplateName: string | undefined): string | undefined {
  if (!sourceTemplateId && !sourceTemplateName) return undefined
  return sourceTemplateId ? GROUP_TEMPLATE_LOCALIZATIONS[sourceTemplateId]?.name ?? sourceTemplateName : sourceTemplateName
}

function baseRoleName(name: string): string {
  const parts = name.split('·')
  return parts[parts.length - 1]?.trim() || name
}

function englishRolePrompt(name: string, description: string): string {
  return [
    `You are ${name}.`,
    description,
    'Ask for missing context before making firm recommendations. Give concrete outputs, state assumptions, and call out risks or limits. Respond in English unless the user explicitly asks for another language.',
  ].join('\n\n')
}

function englishAdvisorPrompt(name: string, description: string): string {
  return [
    `You are ${name}, an advisory persona inspired by public ideas around: ${description}`,
    'You are not the original person and should not fabricate quotes. Help the user reason clearly, separate facts from judgments, and turn insight into practical next actions. Respond in English unless the user explicitly asks for another language.',
  ].join('\n\n')
}

function fallbackGroupTemplateName(template: Pick<BuiltinGroupTemplate, 'id' | 'name'>): string {
  return `${titleCaseIdentifier(template.id || template.name)} Group`
}

function fallbackGroupSummary(groupName: string): string {
  return `Ready-made AI team for ${stripGroupSuffix(groupName).toLowerCase()} work. It helps clarify goals, organize inputs, draft useful outputs, review risks, and define next actions.`
}

function fallbackRoleDescription(name: string, groupName: string): string {
  return `${name} supports ${stripGroupSuffix(groupName).toLowerCase()} work with concrete analysis, useful drafts, risk checks, and next actions.`
}

function localizeUserTypes(userTypes: string[], localization: GroupTemplateLocalization | undefined): string[] {
  if (localization?.userTypes) return localization.userTypes
  return userTypes.map(userType => USER_TYPE_TRANSLATIONS[userType] ?? fallbackUserType(userType))
}

function fallbackUserType(userType: string): string {
  if (/^[\w\s./+-]+$/.test(userType)) return userType
  return 'Relevant users'
}

function englishTemplateAliases(template: BuiltinGroupTemplate, groupName: string): string[] {
  return [
    stripGroupSuffix(groupName),
    template.id,
    localizeCategory(template.category, 'en') ?? '',
    ...template.roles.map(role => localizeRoleName(role.name, groupName, template.id)),
  ].filter(Boolean)
}

function englishTemplateQuestions(groupName: string): string[] {
  return [
    'What problem do I want to solve?',
    'What materials or background do I already have?',
    'What final output do I need?',
    `Help me clarify the goal, context, and missing information for this ${stripGroupSuffix(groupName).toLowerCase()} task.`,
    'Create an information checklist from my materials.',
    'Ask the right roles to review this and summarize consensus, risks, and next actions.',
  ]
}

function fallbackRoleName(value: string, suffix: string): string {
  const readable = titleCaseIdentifier(value)
  const collapsed = readable.replace(/\s+/g, '')
  return collapsed.endsWith(suffix) ? collapsed : `${collapsed}${suffix}`
}

function titleCaseIdentifier(value: string): string {
  const withoutHan = value.replace(/[\u3400-\u9fff]+/g, ' ')
  const words = withoutHan
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return 'OpenTeam'
  return words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

function stripGroupSuffix(value: string): string {
  return value.replace(/\s+Group$/, '')
}
