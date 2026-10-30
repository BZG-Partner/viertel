// Notification layer — the user-feedback primitives extracted from main.js.
//
// WHAT LIVES HERE: the three "tell the user something happened" channels that
// the rest of the app fires and forgets:
//   * toast(msg)   — the transient in-app aria-live snackbar (#toast).
//   * notify(n)    — a best-effort OS Notification for the ping/catch-up nudge.
//   * beep()       — the WebAudio two-tone ping sound.
// Each owns its small module-local state (the toast dismiss timer, the lazily
// created AudioContext) which used to sit at module scope in main.js.
//
// SHARING CONTRACT (how this stays decoupled and cycle-free):
//   * It imports ONLY `state` (to read settings.notifyOn) from state.js and the
//     `$` shorthand from ui/dom.js — the two lowest layers. It imports nothing
//     UI-higher (no dialogs.js / calendar.js), so it can be safely imported by
//     those modules without forming a cycle. dialogs.js imports `toast` from
//     here directly (no DI shim needed); main.js imports all three.
//
// Behaviour is identical to the inline originals — this is a pure move.

import { state } from '../state.js';
import { $ } from './dom.js';

/* ---------- toast ---------- */
let toastT = null;
// toast(msg) — plain transient snackbar.
// toast(msg, {action, onAction}) — adds an inline action button (e.g. Undo) and
// keeps the toast up longer so the user can actually hit it. Clicking the action
// runs onAction and dismisses; the toast also auto-dismisses after the timeout.
export function toast(m, opts) {
  const t = $('toast'); t.innerHTML = ''; t.onclick = null; t.style.cursor = '';
  const msg = document.createElement('span'); msg.textContent = m; t.appendChild(msg);
  const actionable = opts && opts.action && typeof opts.onAction === 'function';
  if (actionable) {
    const btn = document.createElement('button');
    btn.className = 'toast-act'; btn.type = 'button'; btn.textContent = opts.action;
    btn.onclick = (e) => {
      e.stopPropagation();
      clearTimeout(toastT); t.classList.remove('show');
      opts.onAction();
    };
    t.appendChild(btn);
  }
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), actionable ? 6000 : 2400);
}

/* ---------- notification ---------- */
export function notify(n) {
  if (!state.settings.notifyOn || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const note = new Notification('Viertel — Ping', {
      body: n > 1 ? (n + ' Einträge nachzutragen') : 'Woran arbeitest du gerade?',
      tag: 'timelog-ping', renotify: true, requireInteraction: true,
    });
    note.onclick = () => { window.focus(); note.close(); };
  } catch (e) { /* notifications are best-effort */ }
}

/** Fire one notification right away (and the ping sound), so the user sees
    whether reminders actually reach the desktop — in a remote-desktop session
    Windows or browser policies may swallow them silently. */
export function notifyTest() {
  if (state.settings.soundOn) beep();
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification('Viertel — Test', { body: 'So sieht der Ping aus. Kommt diese Meldung an, funktionieren die Erinnerungen.', tag: 'timelog-test' });
  } catch (e) { toast('Benachrichtigung wurde vom System blockiert'); }
}

/* ---------- window title as a fallback signal ----------
   When OS notifications are unavailable (Viertel opened as a file, or a
   remote-desktop policy blocks them), the ping still needs to reach a user who
   is in another window. The page title shows in the Windows taskbar and on the
   Edge tab, so it switches to a question at once and keeps blinking (the
   browser throttles background timers, so the first switch matters most)
   until the user comes back to Viertel. */
const ATTN = '⏰ Woran arbeitest du? · Viertel';
let blinkT = null, baseTitle = null;
export function attention() {
  if (blinkT || document.hasFocus()) return;   // looking at Viertel: the dialog is enough
  baseTitle = document.title;
  document.title = ATTN;
  let on = true;
  blinkT = setInterval(() => { on = !on; document.title = on ? ATTN : baseTitle; }, 1000);
  const stop = () => {
    if (document.hidden) return;
    clearInterval(blinkT); blinkT = null; document.title = baseTitle;
    document.removeEventListener('visibilitychange', stop); window.removeEventListener('focus', stop);
  };
  document.addEventListener('visibilitychange', stop); window.addEventListener('focus', stop);
}

/** 'granted' | 'denied' | 'default' | 'unsupported'. */
export function notifyPermission() {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}
/** True when OS notifications cannot be had: refused, or Viertel opened as a
    file — Edge then answers "not decided" forever without ever asking. */
export function notifyBlocked() {
  const p = notifyPermission();
  return p === 'denied' || (location.protocol === 'file:' && p !== 'granted');
}

/* ---------- sound ---------- */
let actx = null;
export function beep() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const t = actx.currentTime;
    [880, 1320].forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      o.connect(g); g.connect(actx.destination);
      const s = t + i * 0.18; g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(0.18, s + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.16);
      o.start(s); o.stop(s + 0.17);
    });
  } catch (e) { /* WebAudio unavailable → silent */ }
}
