# AI Page Health Status

## Goal

Show a clear per-role health status so users know whether an AI page is loaded, connected, ready to send, waiting for a reply, blocked, or failed.

## Status Model

The team page shows one live state per web role (`RolePageHealthStatus` in `src/teamPage/roleHealth.ts`). API roles are not tracked.

| State | Meaning | Comes from |
| --- | --- | --- |
| `closed` | No iframe for the role on this page. | Iframe host |
| `opening` | The iframe was created, recovered or loaded a new document, and has not completed the handshake yet. | Iframe host |
| `unresponsive` | Still no handshake 20 s after opening. A page that redirects to a sign-in domain (accounts.google.com, auth.openai.com, …) ends up here, because the content script only runs on the AI sites. | Iframe host + timer |
| `checking` | Handshake done, no report from the page yet. | Iframe host |
| `loading` | The page has no input box yet (first 20 s). | Content script |
| `ready` | The input box is there. Reason `guest` when the page also shows sign-in controls (usable without logging in). | Content script |
| `generating` | The site is writing a reply. | Content script |
| `login-required` | The site's login page, or only sign-in controls after the page has loaded. | Content script |
| `blocked` | Reason `verification` (Cloudflare interstitial or Turnstile), `http-error` (403/5xx error page, title in `detail`) or `overlay` (a dialog over the page). | Content script |
| `error` | Reason `no-editor` (no input box after 20 s) or `site-error` (the site's error message in `detail`). | Content script |

`unresponsive`, `login-required`, `blocked` and `error` count as problems: the role card explains what happened and offers "Open site" (a new tab, to log in or verify) and "Reload" (recreate the iframe), and the composer warns when a message targets such a role.

## Data Flow

1. Each adapter's `checkStatus(context)` runs the shared `checkSiteHealth` (`src/content/sites/siteHealth.ts`) with its own input-box selector, login-page path and error selector. Interstitial and error-title checks only apply when there is no input box, so a conversation titled "Error handling…" stays `ready`.
2. The content script reports `TEAM_SITE_STATUS_UPDATE` with `chatId`, `roleId`, `status`, `reason` and `detail` right after its frame is assigned a role, and then whenever the result changes (checked every 3 s). Before an assignment there is nobody to report for, so nothing is sent.
3. The message reaches both the background, which keeps the last state on the role as `siteHealth`, and the team page, which accepts reports only from frames in its own tab.
4. The iframe host reports the lifecycle: `role-created`/`role-recovered`/`role-navigated` (opening), `role-ready` (connected), `role-disposed` (closed). A load event in an already connected frame means a new document, so the frame is assigned again.

## Anti-Flicker Rules

- A repeated handshake for the same document keeps the last report.
- Only a new document (a load event) resets the state to `opening`.
- Sign-in controls without an input box count as `loading`, not `login-required`, during the first 20 s, because guest pages (Gemini, Grok) render their sign-in button first.
