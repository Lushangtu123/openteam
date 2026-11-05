# Multimodal Attachments

## Goal

Support image and file attachments in group chat while keeping storage, delivery, and privacy behavior predictable.

## What Users Can Attach

The composer has a paperclip button, and accepts pasted and dropped files. Rules live in `src/group/messageUploads.ts` and are checked again by the background, which measures images by their data:

- Up to 4 attachments per message.
- PNG, JPEG, WebP and GIF images, up to 10 MB each.
- Text files (text, Markdown, CSV, JSON, YAML, code, logs, …), up to 1 MB each, read as UTF-8.
- Anything else (PDF, Office files, archives) is refused with a reason.

The tray above the input box shows each pending file with a remove button and the note:

> Attachments are uploaded to the AI site or model only when you send them.

## Storage

- Images: `MessageImageAttachment` with `source: 'user-upload'` on the message; the bytes are stored in IndexedDB (`ImageAttachmentRepository`) by the background when the message is created, keyed by chat and message, so deleting messages or chats removes them, and backups include them.
- Text files: `MessageFileAttachment` on the message, including the text, because the text goes into prompts.
- Captured ChatGPT/Gemini reply images keep working as before (no `source`).

## Delivery

- Text files are written into the prompt after the user's message (`formatAttachedFilesForPrompt`), in a code fence longer than any backtick run inside the file. Earlier messages in the context only name their attachments.
- Images are loaded from IndexedDB when a prompt is delivered, so retries send them again:
  - API models receive them as image parts next to the prompt (AI SDK `messages`); the model has to accept images.
  - AI sites receive them through the content script (`src/content/fileUpload.ts`): it pastes the files into the site's input box, falls back to the site's file input, and only types and sends the prompt once the site visibly shows the attachment. If the site shows its own "upload failed" message, or does not react at all, the delivery fails with that reason instead of sending the prompt without its images.
- Orchestration tasks do not take attachments yet.

## Verified

- Unit tests cover the rules, prompt text, background storage and delivery, the frame and API senders, the composer tray and the site uploader against fake composers.
- In Chrome for Testing (logged-out profile): the tray, sending, an API role behind a mock OpenAI-compatible endpoint (image part identical to the file, file text in the prompt), and ChatGPT as a guest, which takes the pasted image and then refuses the upload; the role reports "Failed to upload".
- Not verified: successful uploads on logged-in AI site accounts.
