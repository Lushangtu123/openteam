import { describe, expect, it } from 'vitest'
import { BACKGROUND_GONE_MESSAGE, MEMBER_PAGE_GONE_MESSAGE, backgroundErrorForUser, isReceiverGoneError } from './connectionErrors'
import { translateUi } from './i18n'

const CHROME_WORDING = 'Could not establish connection. Receiving end does not exist.'

describe('a message nobody received', () => {
  it('is recognised by Chrome\'s wording, either half of it', () => {
    expect(isReceiverGoneError(CHROME_WORDING)).toBe(true)
    expect(isReceiverGoneError('Error: Receiving end does not exist.')).toBe(true)
    expect(isReceiverGoneError('Could not establish connection')).toBe(true)
    expect(isReceiverGoneError('记忆内容不能为空')).toBe(false)
  })

  it('is told to the user in plain words when the background answers with it, and other errors are left alone', () => {
    expect(backgroundErrorForUser(CHROME_WORDING)).toBe(MEMBER_PAGE_GONE_MESSAGE)
    expect(backgroundErrorForUser('记忆内容不能为空')).toBe('记忆内容不能为空')
  })

  it('has both messages in English, naming the menu item as the English page does', () => {
    expect(translateUi(MEMBER_PAGE_GONE_MESSAGE, 'en')).toContain('Reload page')
    expect(translateUi('刷新网页', 'en')).toBe('Reload page')
    expect(MEMBER_PAGE_GONE_MESSAGE).toContain('「刷新网页」')
    expect(translateUi(BACKGROUND_GONE_MESSAGE, 'en')).toBe('OpenTeam\'s background is not responding (the extension may have just been reloaded). Reload this page, then try again.')
  })
})
