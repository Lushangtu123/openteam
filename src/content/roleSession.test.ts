import { expect, it, vi } from 'vitest'
import { createRoleSession } from './roleSession'
import { createDeepSeekAdapter } from './sites/deepseek'

it('keeps a DeepSeek reply pending when the same frame receives another assignment', () => {
  const onAssigned = vi.fn()
  const session = createRoleSession({
    siteAdapter: createDeepSeekAdapter({ href: 'https://chat.deepseek.com/a/chat/s/conversation-1' }),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    onAssigned,
  })

  session.assignRole({ chatId: 'chat-1', roleId: 'role-1', roleName: 'DeepSeek' })
  session.startPrompt('msg-1', 'attempt-1')
  session.assignRole({ chatId: 'chat-1', roleId: 'role-1', roleName: 'DeepSeek' })

  expect(session.getActivePrompt()).toEqual({ messageId: 'msg-1', replyAttemptId: 'attempt-1' })
  expect(onAssigned).toHaveBeenCalledTimes(1)

  session.assignRole({ chatId: 'chat-1', roleId: 'role-2', roleName: 'Other' })
  expect(session.getActivePrompt()).toBeUndefined()
})
