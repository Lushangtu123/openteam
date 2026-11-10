// An API model is called only when the user has allowed OpenTeam to reach its address (see
// ../shared/hostAccess). Without that the request would fail as a vague network error, and be
// retried; this says what is missing and where to allow it, at once.
import { hasHostAccess, hostAccessLabel } from '../shared/hostAccess'
import { ExternalModelError, type ExternalModelClient, type ExternalModelCompletionInput } from './externalModelClient'

export const HOST_ACCESS_ERROR_CODE = 'host_access'

export function requireApiModelAccess(client: ExternalModelClient, hasAccess: (baseUrl: string) => Promise<boolean> = hasHostAccess): ExternalModelClient {
  async function check(input: ExternalModelCompletionInput): Promise<void> {
    if (input.model.format === 'local-agent') return
    if (await hasAccess(input.model.baseUrl)) return
    // A 4xx status: not retried.
    throw new ExternalModelError(
      `OpenTeam 还没有被允许访问 ${hostAccessLabel(input.model.baseUrl)}。请在设置里打开「管理模型」，在「${input.model.name}」上点「允许访问」。`,
      403,
      HOST_ACCESS_ERROR_CODE,
    )
  }

  return {
    ...(client.stream ? {
      stream(input) {
        const stream = client.stream!
        return (async function* () {
          await check(input)
          yield* stream(input)
        })()
      },
    } : {}),
    async complete(input) {
      await check(input)
      return client.complete(input)
    },
  }
}
