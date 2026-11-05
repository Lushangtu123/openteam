// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { checkSiteHealth, NO_EDITOR_GRACE_MS, type SiteHealthProbe } from './siteHealth'

const EDITOR = '#prompt'

function probe(overrides: Partial<SiteHealthProbe> = {}): SiteHealthProbe {
  return {
    findEditor: () => document.querySelector(EDITOR),
    isGenerating: () => false,
    ...overrides,
  }
}

function check(overrides: Partial<SiteHealthProbe> = {}, pageAgeMs = NO_EDITOR_GRACE_MS + 1) {
  const { timestamp: _timestamp, ...status } = checkSiteHealth(probe(overrides), { pageAgeMs })
  return status
}

describe('site health check', () => {
  beforeEach(() => {
    document.title = ''
    document.body.innerHTML = ''
  })

  it('is ready when the input box is there', () => {
    document.body.innerHTML = '<div id="prompt" contenteditable="true"></div>'
    expect(check()).toEqual({ status: 'ready' })
  })

  it('notes a usable page that is not logged in (Gemini and Grok guests)', () => {
    document.body.innerHTML = '<div id="prompt" contenteditable="true"></div><button>Sign in</button><a href="/sign-up">Sign up</a>'
    expect(check()).toEqual({ status: 'ready', reason: 'guest' })
  })

  it('recognises a Cloudflare check page (ChatGPT and Claude in a fresh profile)', () => {
    document.title = 'Just a moment...'
    expect(check()).toEqual({ status: 'blocked', reason: 'verification' })

    document.title = 'claude.ai'
    document.body.innerHTML = '<p>Performing security verification</p><p>This website uses a security service to protect against malicious bots.</p>'
    expect(check()).toEqual({ status: 'blocked', reason: 'verification' })
  })

  it('recognises an HTTP error page (DeepSeek answering 403)', () => {
    document.title = 'ERROR: The request could not be satisfied'
    document.body.innerHTML = '<h1>403 ERROR</h1><p>Request blocked.</p>'
    expect(check()).toEqual({ status: 'blocked', reason: 'http-error', detail: 'ERROR: The request could not be satisfied' })
  })

  it('does not mistake a conversation titled like an error for an error page', () => {
    document.title = 'Error handling in Python'
    document.body.innerHTML = '<div id="prompt" contenteditable="true"></div>'
    expect(check()).toEqual({ status: 'ready' })

    document.title = 'Just a moment, I need a recipe'
    expect(check()).toEqual({ status: 'ready' })
  })

  it('needs login on the site login page or when only sign-in controls are shown', () => {
    expect(check({ isLoginPage: () => true })).toEqual({ status: 'unauthorized', reason: 'login' })

    document.body.innerHTML = '<main><button aria-label="Log in"></button><button>登录</button></main>'
    expect(check()).toEqual({ status: 'unauthorized', reason: 'login' })
  })

  it('does not call a still-loading guest page logged out before its input box appears', () => {
    document.body.innerHTML = '<header><button>Sign in</button></header>'
    expect(check({}, 1500)).toEqual({ status: 'loading', reason: 'no-editor' })
    expect(check({ isLoginPage: () => true }, 1500)).toEqual({ status: 'unauthorized', reason: 'login' })
  })

  it('ignores hidden sign-in controls', () => {
    document.body.innerHTML = '<div id="prompt" contenteditable="true"></div><nav hidden><a>Log in</a></nav><div aria-hidden="true"><button>Sign in</button></div>'
    expect(check()).toEqual({ status: 'ready' })
  })

  it('reports a site error message and a reply in progress', () => {
    document.body.innerHTML = '<div id="prompt" contenteditable="true"></div>'
    expect(check({ findSiteError: () => 'Something went wrong' })).toEqual({ status: 'error', reason: 'site-error', detail: 'Something went wrong' })
    expect(check({ isGenerating: () => true })).toEqual({ status: 'generating' })
  })

  it('reports a modal dialog in front of the input box, with its text', () => {
    document.body.innerHTML = '<div id="prompt" contenteditable="true"></div><button>Log in</button>'
    expect(check({ findBlockingDialog: () => 'Confirm your age to continue' })).toEqual({ status: 'blocked', reason: 'overlay', detail: 'Confirm your age to continue' })
    expect(check({ findBlockingDialog: () => '' })).toEqual({ status: 'blocked', reason: 'overlay' })
    expect(check({ findBlockingDialog: () => undefined })).toEqual({ status: 'ready', reason: 'guest' })
  })

  it('reports an overlay or a verification widget covering a page without an input box', () => {
    expect(check({ hasBlockingOverlay: () => true })).toEqual({ status: 'blocked', reason: 'overlay' })

    document.body.innerHTML = '<iframe src="https://challenges.cloudflare.com/turnstile/v0"></iframe>'
    expect(check()).toEqual({ status: 'blocked', reason: 'verification' })
  })

  it('waits for a missing input box before calling it an error', () => {
    expect(check({}, 5000)).toEqual({ status: 'loading', reason: 'no-editor' })
    expect(check({}, NO_EDITOR_GRACE_MS)).toEqual({ status: 'error', reason: 'no-editor' })
  })
})
