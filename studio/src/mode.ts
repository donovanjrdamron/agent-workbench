/**
 * Review mode: the board opened from the phone (over Tailscale, so not 127.0.0.1). Look around and leave comments,
 * nothing else. `?review` forces it on this Mac too (handy for trying it in a narrow window).
 */
export const REVIEW = typeof location !== 'undefined' &&
  (!['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) || new URLSearchParams(location.search).has('review'))
