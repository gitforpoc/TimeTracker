// Manual device/sync diagnostics ("Send Diagnostics" button).
//
// Goal: when a worker reports "it just says syncing", they tap one button and a
// snapshot of their auth + queue + device + a live connectivity test lands in
// tt_diagnostics for us to analyse — no download, no copy-paste (works on iOS).
//
// Delivery is via /api/diag, which is UNAUTHENTICATED on purpose so the report
// arrives even when the user's session is dead. If even that POST fails (truly
// offline), we hand back a text blob the user can paste into WhatsApp.
//
// Pure helpers (no I/O) are exported separately so they can be unit-tested.
// sync/store/auth are imported dynamically inside runDiagnostics() so this
// module's pure exports don't drag browser-only globals into the test env.

const TWELVE_H_MS = 12 * 60 * 60 * 1000;

/**
 * Decode a JWT's `exp` claim into epoch ms. Returns null if not decodable.
 * Pure, no validation of signature — we only want the expiry for display.
 */
export function decodeJwtExp(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(json));
    if (typeof payload.exp !== "number") return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

/** Build the queue section of the report. Pure given sync-like state + now. */
export function buildQueueSection(syncState, nowMs) {
  const queue = Array.isArray(syncState.queue) ? syncState.queue : [];
  let oldest = 0;
  for (const it of queue) {
    if (typeof it?.enqueued_at === "number") {
      const age = nowMs - it.enqueued_at;
      if (age > oldest) oldest = age;
    }
  }
  let head = null;
  if (queue.length > 0) {
    const h = queue[0];
    const ts = h?.payload?.timestamp ? new Date(h.payload.timestamp).getTime() : NaN;
    head = {
      action: h?.payload?.action ?? null,
      timestamp: h?.payload?.timestamp ?? null,
      ageMin: Number.isFinite(ts) ? Math.round((nowMs - ts) / 60000) : null,
      olderThan12h: Number.isFinite(ts) ? nowMs - ts > TWELVE_H_MS : null,
    };
  }
  return {
    pending: queue.length,
    failed: typeof syncState.failedCount === "number" ? syncState.failedCount : 0,
    authBroken: typeof syncState.authBroken === "boolean" ? syncState.authBroken : null,
    tokenGetterWired: !!syncState.tokenGetterWired,
    oldestPendingAgeMin: Math.round(oldest / 60000),
    head,
  };
}

/**
 * Compute device clock skew vs server in seconds, correcting for round-trip.
 * Positive = device clock is AHEAD of server. Pure.
 */
export function computeClockSkewSec(clientSentMs, serverTimeMs, rttMs) {
  if (!Number.isFinite(serverTimeMs) || !Number.isFinite(clientSentMs)) return null;
  const oneWay = Number.isFinite(rttMs) ? rttMs / 2 : 0;
  // At the moment the server stamped serverTimeMs, the device clock read
  // approximately clientSentMs + oneWay. Skew = device − server.
  return Math.round((clientSentMs + oneWay - serverTimeMs) / 1000);
}

/** Human-readable text for the WhatsApp/clipboard fallback. Pure. */
export function formatReportText(report) {
  const a = report.auth || {};
  const q = report.queue || {};
  const c = report.connectivity || {};
  const d = report.device || {};
  const lines = [
    `TimeTracker diagnostics`,
    `user: ${report.userName || "?"}`,
    `time: ${report.clientTime || "?"}`,
    `--- auth ---`,
    `session: ${a.hasSession} | token: ${a.tokenPresent} | expired: ${a.tokenExpired}`,
    `tokenValid(server): ${report.tokenValidServer}`,
    `refreshTest: ${a.refreshTest} | authBroken: ${q.authBroken}`,
    `--- queue ---`,
    `pending: ${q.pending} | failed: ${q.failed} | oldestMin: ${q.oldestPendingAgeMin}`,
    q.head
      ? `head: ${q.head.action} @ ${q.head.timestamp} (ageMin ${q.head.ageMin}, >12h ${q.head.olderThan12h})`
      : `head: none`,
    `--- connectivity ---`,
    `diagPost: ${c.diagPostStatus} | rttMs: ${c.roundTripMs} | clockSkewSec: ${c.clockSkewSec}`,
    `--- device ---`,
    `online: ${d.online} | standalone: ${d.standalone} | tz: ${d.tz}`,
    `ua: ${d.ua}`,
  ];
  return lines.join("\n");
}

/**
 * Gather everything and ship it. Async (does I/O). Returns:
 *   { delivered: boolean, status: number|null, report: object, text: string }
 */
export async function runDiagnostics() {
  const nowMs = Date.now();
  const [{ sync }, { store }, { getSupabaseClient }] = await Promise.all([
    import("./sync.js"),
    import("./store.js"),
    import("./auth.js"),
  ]);
  const client = getSupabaseClient();

  // --- auth snapshot ---
  let hasSession = false;
  let token = null;
  let refreshTest = "skipped";
  if (client) {
    try {
      const { data } = await client.auth.getSession();
      hasSession = !!data?.session;
      token = data?.session?.access_token || null;
    } catch {
      /* leave defaults */
    }
    // Live refresh test — tells us if the refresh token still works. Safe: a
    // failed refresh does NOT sign the user out, it just returns an error.
    try {
      const { data, error } = await client.auth.refreshSession();
      refreshTest = !error && data?.session ? "ok" : "failed";
    } catch {
      refreshTest = "failed";
    }
  }
  const tokenExpMs = decodeJwtExp(token);

  // --- device snapshot ---
  const standalone =
    (typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(display-mode: standalone)").matches) ||
    (typeof navigator !== "undefined" && navigator.standalone === true) ||
    false;
  let storageUsedKB = null;
  let storageQuotaKB = null;
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      if (est) {
        storageUsedKB = est.usage != null ? Math.round(est.usage / 1024) : null;
        storageQuotaKB = est.quota != null ? Math.round(est.quota / 1024) : null;
      }
    }
  } catch {
    /* ignore */
  }

  const report = {
    app: "timetracker",
    userName: store.userName || null,
    clientTime: new Date(nowMs).toISOString(),
    auth: {
      hasSession,
      tokenPresent: !!token,
      tokenExpiresAt: tokenExpMs ? new Date(tokenExpMs).toISOString() : null,
      tokenExpired: tokenExpMs ? tokenExpMs < nowMs : null,
      refreshTest,
    },
    queue: buildQueueSection(
      {
        queue: sync.queue,
        failedCount: sync.failedCount,
        authBroken: sync.isAuthBroken(),
        tokenGetterWired: !!sync._getToken,
      },
      nowMs
    ),
    device: {
      ua: typeof navigator !== "undefined" ? navigator.userAgent : null,
      platform: typeof navigator !== "undefined" ? navigator.platform : null,
      language: typeof navigator !== "undefined" ? navigator.language : null,
      online: typeof navigator !== "undefined" ? navigator.onLine : null,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      standalone,
      swController:
        typeof navigator !== "undefined" && navigator.serviceWorker
          ? !!navigator.serviceWorker.controller
          : null,
      storageUsedKB,
      storageQuotaKB,
    },
    connectivity: {
      diagPostStatus: null,
      roundTripMs: null,
      serverTime: null,
      clockSkewSec: null,
    },
  };

  // --- live connectivity test (the POST itself) ---
  const sentMs = Date.now();
  let delivered = false;
  let status = null;
  try {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const resp = await fetch("/api/diag", {
      method: "POST",
      headers,
      keepalive: true,
      body: JSON.stringify({ report }),
    });
    const rtt = Date.now() - sentMs;
    status = resp.status;
    report.connectivity.diagPostStatus = resp.status;
    report.connectivity.roundTripMs = rtt;
    if (resp.ok) {
      delivered = true;
      try {
        const json = await resp.json();
        if (json?.serverTime) {
          report.connectivity.serverTime = new Date(json.serverTime).toISOString();
          report.connectivity.clockSkewSec = computeClockSkewSec(
            sentMs,
            json.serverTime,
            rtt
          );
        }
        if (typeof json?.tokenValid === "boolean" || json?.tokenValid === null) {
          report.tokenValidServer = json.tokenValid;
        }
      } catch {
        /* response not JSON — still delivered */
      }
    }
  } catch (e) {
    report.connectivity.diagPostStatus = 0; // network failure
    console.warn("[diag] POST failed:", e?.message || e);
  }

  return { delivered, status, report, text: formatReportText(report) };
}
