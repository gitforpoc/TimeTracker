export function formatTime(d) {
  return d
    .toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
    .toLowerCase()
    .replace(/\s/g, "");
}

export function formatDate(d) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function minsToHm(m) {
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function copyToClipboard(text) {
  navigator.clipboard
    .writeText(text)
    .then(() => showToast("Copied to clipboard!"))
    .catch(() => {
      // Silently swallow: caller may not have user-activation (e.g. after a
      // dialog await). Prevents unhandled-rejection noise; the text is still
      // visible in the preview area for manual copy.
    });
}

export async function shareText(text) {
  if (navigator.share) {
    try {
      await navigator.share({ text });
    } catch {
      // User cancelled or error, ignore
    }
  }
}

export function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function showToast(msg) {
  const t = document.getElementById("toast");
  t.innerText = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2000);
}

// Best-effort localStorage write. If the browser refuses the write (quota
// exceeded, Safari private mode), surface a visible warning instead of letting
// clock data vanish silently — the worst failure mode for a time clock. Returns
// true on success, false if the write was rejected.
export function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.error("localStorage write failed:", key, e);
    try {
      showToast("⚠️ Storage full — data may not be saved. Tell your supervisor.");
    } catch {
      /* no DOM (e.g. unit tests) — the console.error above is enough */
    }
    return false;
  }
}
