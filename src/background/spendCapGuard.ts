// 花费上限 (src/group/spendCap.ts), kept where every API call passes: replies, summaries, project
// tasks, team formation and a web member's backup alike. A model at its cap is refused before the
// request goes out; every call's tokens are added to its spend today, and the user is told (a
// desktop notification) when it passes 80% of the cap and when it reaches it.
import { capBlocks, capNotice, capReachedReason, modelSpendToday, recordModelSpend, SPEND_CAP_CODE } from '../group/spendCap'
import type { ExternalModelConfig, OpenTeamStore } from '../group/types'
import { normalizeLanguage } from '../shared/i18n'
import { ExternalModelError, type ExternalModelClient, type ExternalModelCompletionInput, type ExternalModelUsage } from './externalModelClient'
import type { StoreMutationResult } from './storeAccess'

export interface SpendCapGuardDependencies {
  loadStore(): Promise<OpenTeamStore>
  mutateStore<T>(mutator: (store: OpenTeamStore) => T | Promise<T>): Promise<StoreMutationResult<T>>
  broadcastStoreUpdated(store: OpenTeamStore): Promise<void> | void
  now(): number
  // A desktop notification; replaced by the next one for the same model.
  notify?(id: string, title: string, message: string): void
  log?: { warn(event: string, details?: Record<string, unknown>): void }
}

export function guardSpendCaps(client: ExternalModelClient, deps: SpendCapGuardDependencies): ExternalModelClient {
  // The model as it is set now: its cap or price may have changed since the request was made.
  async function check(input: ExternalModelCompletionInput): Promise<ExternalModelConfig | undefined> {
    if (input.model.format === 'local-agent') return undefined
    const store = await deps.loadStore()
    const model = store.settings.externalModelsById[input.model.id] ?? input.model
    if (!model.pricing) return undefined
    if (capBlocks(store, model, deps.now())) {
      const english = normalizeLanguage(store.settings.language) === 'en'
      throw new ExternalModelError(capReachedReason(model, modelSpendToday(store, model.id, deps.now()), english), undefined, SPEND_CAP_CODE)
    }
    return model
  }

  async function record(model: ExternalModelConfig, usage: ExternalModelUsage): Promise<void> {
    try {
      const { store, result: notice } = await deps.mutateStore(store => recordModelSpend(store, store.settings.externalModelsById[model.id] ?? model, usage, deps.now()))
      await deps.broadcastStoreUpdated(store)
      if (!notice || !deps.notify) return
      const current = store.settings.externalModelsById[model.id] ?? model
      const text = capNotice(current, modelSpendToday(store, model.id, deps.now()), notice, normalizeLanguage(store.settings.language) === 'en')
      deps.notify(`openteam-spend-cap-${model.id}`, text.title, text.message)
    } catch (error) {
      deps.log?.warn('spend-cap:record-failed', { modelId: model.id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  // The caller is told the tokens as before; the spend is recorded before the call is over.
  function counting(input: ExternalModelCompletionInput, model: ExternalModelConfig | undefined, pending: Array<Promise<void>>): ExternalModelCompletionInput {
    if (!model) return input
    return {
      ...input,
      onUsage(usage) {
        input.onUsage?.(usage)
        pending.push(record(model, usage))
      },
    }
  }

  return {
    stream(input) {
      return (async function* () {
        const model = await check(input)
        const pending: Array<Promise<void>> = []
        const counted = counting(input, model, pending)
        try {
          if (client.stream) yield* client.stream(counted)
          else yield (await client.complete(counted)).content
        } finally {
          await Promise.all(pending)
        }
      })()
    },
    async complete(input) {
      const model = await check(input)
      const pending: Array<Promise<void>> = []
      try {
        return await client.complete(counting(input, model, pending))
      } finally {
        await Promise.all(pending)
      }
    },
  }
}
