// Images and files on messages: taken from uploads, copied with a message, and removed when they are
// no longer used.
import type { MessageUpload } from '../group/messageUploads'
import type { MessageAttachment } from '../group/types'
import { mutateStore } from './storeAccess'
import type { MessageHandlersDependencies } from './messageHandlerDeps'
import { readOptionalString } from './messageInput'

// Copies of the files attached to another of the user's messages in the chat, for a message that
// should carry them too (each invitation of a team carries the task's files).
export async function uploadsCopiedFrom(deps: MessageHandlersDependencies, chatId: string, sourceId: unknown): Promise<unknown[]> {
  const id = readOptionalString(sourceId)
  if (!id) return []
  const { result: attachments } = await mutateStore(store => {
    const source = store.messagesById[id]
    if (!source || source.chatId !== chatId || source.type !== 'user') throw new Error('找不到要附带的资料，可能已被删除')
    return source.attachments ?? []
  })
  const imageIds = attachments.filter(attachment => attachment.type === 'image' && attachment.status === 'ready' && attachment.source === 'user-upload').map(attachment => attachment.id)
  if (imageIds.length > 0 && !deps.imageAttachments?.loadUploads) throw new Error('当前环境不支持附带图片')
  const images = new Map((imageIds.length > 0 ? await deps.imageAttachments!.loadUploads!(imageIds) : []).map((upload, index) => [imageIds[index], upload]))
  return attachments.flatMap((attachment): unknown[] => {
    if (attachment.type === 'file') return [{ kind: 'text', fileName: attachment.fileName, mimeType: attachment.mimeType, text: attachment.text }]
    const image = images.get(attachment.id)
    return image ? [{ kind: 'image', fileName: image.fileName, mimeType: image.mimeType, data: image.data }] : []
  })
}

export function requireImageAttachmentService(deps: MessageHandlersDependencies): NonNullable<MessageHandlersDependencies['imageAttachments']> {
  if (!deps.imageAttachments) throw new Error('图片存储尚未初始化')
  return deps.imageAttachments
}

export function uploadAttachment(id: string, upload: MessageUpload): MessageAttachment {
  return upload.kind === 'image'
    ? { id, type: 'image', status: 'ready', source: 'user-upload', mimeType: upload.mimeType, size: upload.size, fileName: upload.fileName }
    : { id, type: 'file', status: 'ready', fileName: upload.fileName, mimeType: upload.mimeType, size: upload.size, text: upload.text }
}

// Ids of the stored image blobs behind these attachments (text files have none).
export function readyAttachmentIds(attachments: MessageAttachment[] | undefined): string[] {
  return (attachments ?? []).filter(attachment => attachment.type === 'image' && attachment.status === 'ready').map(attachment => attachment.id)
}

export async function deleteReadyAttachmentsBestEffort(
  deps: MessageHandlersDependencies,
  attachments: MessageAttachment[] | undefined,
  event: string,
): Promise<void> {
  await deleteAttachmentIdsBestEffort(deps, readyAttachmentIds(attachments), event)
}

export async function deleteAttachmentIdsBestEffort(
  deps: MessageHandlersDependencies,
  ids: string[],
  event: string,
): Promise<void> {
  if (ids.length === 0 || !deps.imageAttachments) return
  try {
    await deps.imageAttachments.deleteByIds(ids)
  } catch (error) {
    deps.log.warn(event, {
      attachmentCount: ids.length,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
