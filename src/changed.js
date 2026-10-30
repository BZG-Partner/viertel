// One-line change signal for the OneDrive layer. Kept in its own module so
// state.js and auftraege.js can raise it without importing onedrive.js (which
// itself imports state.js — that would be a cycle).
//
// Safe in Node tests: there is no window.dispatchEvent there.
export function signalChange() {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function'
      && typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent('viertel:changed'));
}
