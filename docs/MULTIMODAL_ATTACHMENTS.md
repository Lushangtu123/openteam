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
- Reply images with an https address are downloaded by the background. ChatGPT now shows its generated images through `blob:` addresses that only its page can open, so the content script reads those inside the page (`src/content/replyImages.ts`) and sends the bytes with the reply. The background stores them only when they come from the bound ChatGPT/Gemini frame, the source is that site's own `blob:` address, the bytes are a real PNG/JPEG/WebP/GIF/AVIF (checked from the bytes, not the declared type) and at most 25 MB.

## Delivery

- Text files are written into the prompt after the user's message (`formatAttachedFilesForPrompt`), in a code fence longer than any backtick run inside the file. Earlier messages in the context only name their attachments.
- Images are loaded from IndexedDB when a prompt is delivered, so retries send them again:
  - API models receive them as image parts next to the prompt (AI SDK `messages`); the model has to accept images.
  - AI sites receive them through the content script (`src/content/fileUpload.ts`): it pastes the files into the site's input box, falls back to the site's file input, and only types and sends the prompt once the site visibly shows the attachment. If the site shows its own "upload failed" message, or does not react at all, the delivery fails with that reason instead of sending the prompt without its images.
  - The file input chosen is the one that fits best: one made for images (`image/*`, `.png`, …) before one for any file, one that takes several files when there are several. An input only for documents is never used.
  - Gemini ignores pasted files and adds its file inputs only while its "+" ("Upload & tools" / 「上传和工具」) menu is open. Its adapter (`revealFileInputs`) opens that menu, the files go into its image input, and the menu is closed again. Its "Upload files" item is not clicked, so no file chooser opens.
  - Attachments are recognized anywhere in the composer's `form`, or the `fieldset` Gemini uses instead.
- Orchestration tasks do not take attachments yet.

## Verified

- Unit tests cover the rules, prompt text, background storage and delivery, the frame and API senders, the composer tray and the site uploader against fake composers.
- In Chrome for Testing (logged-out profile): the tray, sending, an API role behind a mock OpenAI-compatible endpoint (image part identical to the file, file text in the prompt), and ChatGPT as a guest, which takes the pasted image and then refuses the upload; the role reports "Failed to upload".
- In Chrome for Testing, logged out (November 2026):
  - Gemini: OpenTeam opens the "+" menu and the image reaches the input box (upload to `push.clients6.google.com` succeeds). Gemini then never sends a signed-out prompt that has an image, in a frame or in its own tab, so a reply cannot be checked without signing in. Image generation needs signing in ("您登录了吗？…无法为您创建任何图片").
  - Kimi takes a pasted image. Grok and Qwen take the paste; Qwen asks to log in. ChatGPT shows a Cloudflare check to the headless browser.
- In the user's Chrome, signed in to ChatGPT (November 2026), on chatgpt.com itself rather than in the OpenTeam frame, with the steps OpenTeam takes:
  - A pasted image is taken (preview, no upload error), and ChatGPT answers about it ("图片中有一个红色的圆，旁边写着数字42。"). The reply is found by the transcript selector; the older `data-message-author-role` turns are gone from the page.
  - An image request produces a reply with no text: `[data-chatgpt-search-message-ids]` holding `[data-testid="generated-image-gallery"]` with `button[data-testid="generated-image-preview"] > img`, whose source is a `blob:https://chatgpt.com/…` PNG (1254×1254, 2.4 MB). The adapter now finds that block, and reading the blob inside the page works.
  - ChatGPT keeps text typed by a script in the new-chat box as a draft even after sending it; OpenTeam replaces the box's contents before typing, so this does no harm.
- Not verified: the whole round trip inside the OpenTeam frame on a signed-in account, and Gemini replies to images or generated images on a signed-in account.
