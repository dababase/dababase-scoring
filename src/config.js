// Optional prefill for the event-code field only — never a restriction.
// The app resolves whatever code the judge actually types against the
// events table at sign-in, so this deployment serves every event at once.
export const EVENT_CODE = ''

// Judging guide pages shown from the "Judging guide" button on the scoring
// screen (images in /public/guide). Empty = the button is hidden.
// PLACEHOLDER: Mothership Meltdown pack pages 2-5, for testing the viewer only.
export const GUIDE_PAGES = ['/guide/page-1.webp', '/guide/page-2.webp', '/guide/page-3.webp', '/guide/page-4.webp']
