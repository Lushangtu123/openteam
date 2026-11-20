// 查价格: a model's price per million tokens, looked up in OpenRouter's public model list (no key, no
// account), for the model form's price fields (src/group/pricing.ts). OpenRouter lists most makers'
// models at their own list price, in dollars; a maker that charges in yuan (DeepSeek, Kimi, Qwen) may
// price differently at home, so the form says to check the maker's page.

export const PRICE_LIST_URL = 'https://openrouter.ai/api/v1/models'

export interface PriceEntry {
  // As OpenRouter names it: maker/model.
  id: string
  name: string
  created: number
  // Dollars per million tokens.
  input: number
  output: number
}

export interface PriceMatch {
  exact?: PriceEntry
  // For a name that is not in the list as it is (an alias such as gemini-flash-latest): the maker's
  // models that fit it, newest first.
  candidates: PriceEntry[]
}

const MAX_CANDIDATES = 10
// Words of an alias that no listed name carries.
const ALIAS_WORDS = new Set(['latest', 'preview', 'exp', 'experimental'])
// Kinds of model a chat member is not, unless its name says so.
const OTHER_KINDS = ['image', 'vision', 'tts', 'audio', 'embedding', 'live']

export async function fetchPriceList(fetchImpl: typeof fetch = fetch): Promise<PriceEntry[]> {
  const response = await fetchImpl(PRICE_LIST_URL, { credentials: 'omit' })
  if (!response.ok) throw new Error(`没能读到价格表（HTTP ${response.status}）`)
  return readPriceList(await response.json())
}

export function readPriceList(json: unknown): PriceEntry[] {
  const data = (json as { data?: unknown } | undefined)?.data
  if (!Array.isArray(data)) return []
  return data.flatMap(item => {
    const entry = item as { id?: unknown; name?: unknown; created?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }
    if (typeof entry?.id !== 'string' || !entry.id.includes('/') || entry.id.includes(':')) return []
    const input = Number(entry.pricing?.prompt)
    const output = Number(entry.pricing?.completion)
    // -1: the price depends on the model it routes to.
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return []
    return [{
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name : entry.id,
      created: typeof entry.created === 'number' ? entry.created : 0,
      input: perMillion(input),
      output: perMillion(output),
    }]
  })
}

export function matchModelPrice(list: PriceEntry[], modelName: string, baseUrl: string): PriceMatch {
  const name = normalize(modelName)
  if (!name) return { candidates: [] }
  // Through OpenRouter (or SiliconFlow) the name carries its maker.
  if (name.includes('/')) {
    const exact = list.find(entry => normalize(entry.id) === name)
    if (exact) return { exact, candidates: [] }
  }
  const short = name.split('/').pop()!
  const maker = makerFor(baseUrl, short)
  const own = list.filter(entry => !maker || entry.id.startsWith(`${maker}/`))
  const exact = own.find(entry => suffix(entry.id) === short)
  if (exact) return { exact, candidates: [] }
  if (!maker) return { candidates: [] }
  const words = short.split(/[-_\s]+/).filter(word => word && !ALIAS_WORDS.has(word))
  const candidates = own
    .filter(entry => {
      const entryWords = new Set(suffix(entry.id).split('-'))
      if (!words.every(word => entryWords.has(word))) return false
      return !OTHER_KINDS.some(kind => entryWords.has(kind) && !words.includes(kind))
    })
    .sort((left, right) => right.created - left.created)
    .slice(0, MAX_CANDIDATES)
  return { candidates }
}

// The maker's name in the list, from the address or else the model's name.
function makerFor(baseUrl: string, name: string): string | undefined {
  let host = ''
  try {
    host = new URL(baseUrl).hostname
  } catch {
    host = ''
  }
  if (host.endsWith('generativelanguage.googleapis.com')) return 'google'
  if (host === 'api.anthropic.com') return 'anthropic'
  if (host === 'api.openai.com') return 'openai'
  if (host === 'api.deepseek.com') return 'deepseek'
  if (host.startsWith('api.moonshot.')) return 'moonshotai'
  if (host.startsWith('dashscope')) return 'qwen'
  if (host === 'open.bigmodel.cn') return 'z-ai'
  if (host === 'api.x.ai') return 'x-ai'
  if (/^gemini/.test(name)) return 'google'
  if (/^claude/.test(name)) return 'anthropic'
  if (/^(gpt|o\d|chatgpt)/.test(name)) return 'openai'
  if (/^deepseek/.test(name)) return 'deepseek'
  if (/^(kimi|moonshot)/.test(name)) return 'moonshotai'
  if (/^qwen/.test(name)) return 'qwen'
  if (/^glm/.test(name)) return 'z-ai'
  if (/^grok/.test(name)) return 'x-ai'
  return undefined
}

// Lower case, without a models/ prefix, and with versions written with dashes (claude-sonnet-5-5 and
// claude-sonnet-5.5 are one model).
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/^models\//, '').replace(/\./g, '-')
}

function suffix(id: string): string {
  return normalize(id.split('/').pop() ?? id)
}

function perMillion(perToken: number): number {
  return Math.round(perToken * 1_000_000 * 1e6) / 1e6
}
