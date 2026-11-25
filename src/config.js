// The event this deployment serves. Judges never type a code: the app loads
// this event straight onto the sign-in screen (Google or email link).
// Per-event forks set their own code here. A link with ?event=CODE
// overrides it, which is handy for testing another event on this site.
export const EVENT_CODE = 'TEST26'
