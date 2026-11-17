const SERVER_TEXT_CHARS = 300

// The message in a refusal's body: OpenAI's {error: {message}}, Gemini's [{error: {message}}], a
// plain {message} or {error: "…"}; otherwise the start of the body as it is.
export function serverErrorText(body: unknown): string {
  if (typeof body !== 'string' || !body.trim()) return ''
  try {
    let parsed = JSON.parse(body)
    if (Array.isArray(parsed)) parsed = parsed[0]
    const message = parsed?.error?.message ?? (typeof parsed?.error === 'string' ? parsed.error : undefined) ?? parsed?.message
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, SERVER_TEXT_CHARS)
  } catch {
    // Not JSON: its start is shown as it is.
  }
  return body.replace(/\s+/g, ' ').trim().slice(0, SERVER_TEXT_CHARS)
}
