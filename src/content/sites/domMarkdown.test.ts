// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { extractMarkdownFromDom } from './domMarkdown'

function reply(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

describe('extractMarkdownFromDom', () => {
  it('reads a DeepSeek code block without its toolbar, naming the language', () => {
    const root = reply(`
      <div class="md-code-block md-code-block-light">
        <div class="md-code-block-banner-wrap">
          <div class="md-code-block-banner md-code-block-banner-lite">
            <div class="_121d384">
              <div class="d2a24f03"><span class="d813de27">json</span></div>
              <div class="d2a24f03 _246a029"><div class="efa13877">
                <div role="button" class="ds-button"><div class="ds-button__icon"><svg></svg></div><span class="ds-button__content"><span class="code-info-button-text">Copy</span></span></div>
                <div role="button" class="ds-button"><span class="ds-button__content"><span class="code-info-button-text">Download</span></span></div>
              </div></div>
            </div>
          </div>
        </div>
        <pre>{"first_choice": "数据安全"}</pre>
      </div>`)

    expect(extractMarkdownFromDom(root)).toBe('```json\n{"first_choice": "数据安全"}\n```')
  })

  it('reads a ChatGPT code block without its toolbar, naming the language', () => {
    const root = reply(`
      <div class="relative Root-iW7ipz w-full min-w-0">
        <div class="flex items-center font-sans text-sm">
          <svg class="Icon-X4VkKC"><use></use></svg>
          <div class="min-w-0 truncate flex-1">JSON</div>
          <div class="ms-auto flex items-center min-w-0"><div class="flex min-w-0 items-center gap-px" role="presentation">
            <button class="no-drag"><svg><use></use></svg></button>
            <button class="no-drag"><svg><use></use></svg></button>
          </div></div>
        </div>
        <div class="relative">
          <div class="InlineCodePane-EYx4bd w-full"><div class="relative z-0 flex max-w-full"><div class="chatgpt-code-scrollport flex w-full">
            <pre class="m-0 flex-1"><code><span>{</span><span>"tasks"</span><span>: []}</span></code></pre>
          </div></div></div>
          <button class="absolute"><svg><use></use></svg></button>
        </div>
      </div>`)

    expect(extractMarkdownFromDom(root)).toBe('```json\n{"tasks": []}\n```')
  })

  it('keeps the prose around a code block with a toolbar', () => {
    const root = reply(`
      <p>下面是计划：</p>
      <div class="code-block">
        <div class="bar"><span>json</span><button>Copy</button></div>
        <pre><code>{"tasks": []}</code></pre>
      </div>
      <p>请确认。</p>`)

    expect(extractMarkdownFromDom(root)).toBe('下面是计划：\n\n```json\n{"tasks": []}\n```\n\n请确认。')
  })

  it('keeps a paragraph drawn as a <div> beside a code block that has no toolbar', () => {
    const root = reply(`
      <div class="paragraph">示例如下：</div>
      <pre><code class="language-python">print("hi")</code></pre>`)

    expect(extractMarkdownFromDom(root)).toBe('示例如下：\n\n```python\nprint("hi")\n```')
  })

  it('reads a ChatGPT writing block once, without the title bar above it', () => {
    const root = reply(`
      <div data-testid="chatgpt-writing-block">
        <header><span class="truncate"><span>上线前检查清单（最终版）</span></span><button>Copy</button></header>
        <div class="ProseMirror" role="textbox" contenteditable="true">
          <h1><span>上线前检查清单（最终版）</span></h1>
          <table><tbody>
            <tr><th>项目</th><th>内容</th></tr>
            <tr><td>产品名称</td><td>大学生记账小程序 V1</td></tr>
          </tbody></table>
        </div>
      </div>`)

    expect(extractMarkdownFromDom(root)).toBe('# 上线前检查清单（最终版）\n\n项目 | 内容\n --- | ---\n产品名称 | 大学生记账小程序 V1')
  })
})
