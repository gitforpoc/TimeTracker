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
    .then(() => showToast("Copied to clipboard!"));
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

export function showToast(msg) {
  const t = document.getElementById("toast");
  t.innerText = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2000);
}
