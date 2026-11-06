function hashStr(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (Math.imul(31, hash) + value.charCodeAt(index)) | 0
  }
  return hash >>> 0
}

function replyKey(conversationId: string, text: string): string {
  return String(hashStr(`${conversationId}:${text.trim()}`))
}

export function createReplyTracker() {
  const seenReplyHashes = new Set<string>()
  const globallySeenReplyHashes = new Set<string>()
  const consumedMessageIds = new Set<string>()

  return {
    seed(conversationId: string, replies: string[]): void {
      for (const reply of replies) {
        const trimmed = reply.trim()
        if (trimmed) seenReplyHashes.add(replyKey(conversationId, trimmed))
      }
    },

    // Whether this text is a reply already seen on the page or stored from before, without
    // consuming anything.
    isKnown(conversationId: string, reply: string): boolean {
      const trimmed = reply.trim()
      if (!trimmed) return false
      return globallySeenReplyHashes.has(String(hashStr(trimmed))) || seenReplyHashes.has(replyKey(conversationId, trimmed))
    },

    seedGlobal(replies: string[]): void {
      for (const reply of replies) {
        const trimmed = reply.trim()
        if (trimmed) globallySeenReplyHashes.add(String(hashStr(trimmed)))
      }
    },

    /**
     * Check if a reply is new and consume it.
     *
     * Bug 2 fix: messageId-based deduplication takes priority over per-conversation text hash.
     * When a messageId is provided, we first check if this messageId has already
     * been consumed. If the messageId is new, the reply is accepted even if the
     * per-conversation text hash was seen before (e.g., AI gives "好的" in multiple rounds).
     *
     * However, globallySeenReplyHashes still acts as a hard barrier — texts seeded
     * via seedGlobal are considered "old/known from prior sessions" and are always
     * blocked regardless of messageId. This preserves the iframe-reload protection.
     *
     * Priority order:
     * 1. messageId dedup (if provided) — takes precedence over per-conversation hash
     * 2. globallySeenReplyHashes — always blocks (cross-session history)
     * 3. per-conversation seenReplyHashes — skipped when messageId is new
     */
    consumeIfNew(conversationId: string, reply: string, messageId?: string): boolean {
      const trimmed = reply.trim()
      if (!trimmed) return false

      // Hard barrier: globally seeded replies are always blocked
      // (e.g., replies from prior sessions after iframe reload)
      if (globallySeenReplyHashes.has(String(hashStr(trimmed)))) return false

      // Priority 1: If messageId is provided and already consumed, reject
      if (messageId && consumedMessageIds.has(messageId)) return false

      // Priority 2: If messageId is provided and is new, accept
      // (even if per-conversation text hash was seen — Bug 2 fix)
      if (messageId && !consumedMessageIds.has(messageId)) {
        consumedMessageIds.add(messageId)
        const key = replyKey(conversationId, trimmed)
        seenReplyHashes.add(key)
        return true
      }

      // Fallback: No messageId, use per-conversation text hash deduplication
      const key = replyKey(conversationId, trimmed)
      if (seenReplyHashes.has(key)) return false

      seenReplyHashes.add(key)
      return true
    },

    consumeIfNewForMessage(conversationId: string, reply: string, messageId: string | undefined): boolean {
      if (!messageId) return false
      if (consumedMessageIds.has(messageId)) return false
      if (!this.consumeIfNew(conversationId, reply, messageId)) return false

      return true
    },
  }
}
