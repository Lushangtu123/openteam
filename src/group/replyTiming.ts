// How long a member may be silent while a reply is on its way, in one place: the member's page,
// the background and the team page all go by it.

// The member's page gives a sign of the reply at least this often: text as it arrives, and when
// none has come for this long, either that the site is still generating or that the reply failed.
export const REPLY_SIGNAL_INTERVAL_MS = 120_000

// A page out of view may run its timers up to a minute late.
const LATE_SIGNAL_ALLOWANCE_MS = 60_000

// A member with no sign of its reply for this long counts as stuck: the team page stops showing it
// as replying, and it may be sent to again. Longer than the signal interval, so that a reply still
// being written is not taken for a stuck one just before its next sign arrives.
export const REPLY_STUCK_AFTER_MS = REPLY_SIGNAL_INTERVAL_MS + LATE_SIGNAL_ALLOWANCE_MS
