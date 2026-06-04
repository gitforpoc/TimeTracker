/**
 * Detects when a new service-worker version is installed and waiting to activate,
 * and notifies the UI via `onUpdateReady` (called exactly once per page load).
 *
 * vite-plugin-pwa is in `autoUpdate` mode, so the new SW activates on next full reload
 * anyway. This layer's job is to TELL the UI so the user knows to reload at a convenient
 * moment (worker may keep the PWA open for days).
 *
 * No-op when SW isn't available (older browsers, dev without SW, etc).
 */

let fired = false;
const POLL_INTERVAL_MS = 30 * 60 * 1000; // every 30 min while page is alive

export async function watchForUpdates(onUpdateReady) {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

  let reg;
  try {
    reg = await navigator.serviceWorker.getRegistration();
  } catch (e) {
    console.warn("[updateChecker] getRegistration failed:", e);
    return;
  }
  if (!reg) return;

  const trigger = () => {
    if (fired) return;
    fired = true;
    try { onUpdateReady(); } catch (e) { console.error("[updateChecker] callback threw:", e); }
  };

  // Case A: we missed `updatefound` because a worker was already waiting when we loaded.
  if (reg.waiting && navigator.serviceWorker.controller) {
    trigger();
  }

  // Case B: an update arrives later (background check found a new SW).
  reg.addEventListener("updatefound", () => {
    const installing = reg.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      // `installed` + existing controller = new version waiting to activate.
      // No controller = this is the very first install (fresh PWA), nothing to notify.
      if (installing.state === "installed" && navigator.serviceWorker.controller) {
        trigger();
      }
    });
  });

  // Periodic poll. The browser doesn't push update notifications, we have to ask.
  setInterval(() => { reg.update().catch(() => {}); }, POLL_INTERVAL_MS);

  // Also check whenever the user comes back to the tab — long-PWA-open scenario.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      reg.update().catch(() => {});
    }
  });
}
