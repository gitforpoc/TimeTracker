import { COMPLIANCE_MODE, STORAGE_KEYS } from "./constants.js";
import { safeSetItem } from "./utils.js";

/**
 * Show GPS consent dialog before enabling location tracking.
 * Returns true if user agreed, false if declined.
 * When COMPLIANCE_MODE is off, returns true immediately.
 */
export async function requireGpsConsent() {
  if (!COMPLIANCE_MODE) return true;

  // Already consented this device
  if (localStorage.getItem(STORAGE_KEYS.GPS_CONSENT)) return true;

  return new Promise((resolve) => {
    const overlay = document.getElementById("gps-consent-overlay");
    if (!overlay) { resolve(true); return; }

    overlay.classList.remove("hidden");

    const accept = document.getElementById("gps-consent-accept");
    const decline = document.getElementById("gps-consent-decline");

    const cleanup = () => {
      overlay.classList.add("hidden");
      accept.onclick = null;
      decline.onclick = null;
    };

    accept.onclick = () => {
      const record = JSON.stringify({
        agreed: true,
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent,
      });
      // safeSetItem: if the write fails the dialog still closes (no stuck UI);
      // with no stored record the consent dialog simply re-shows next time.
      safeSetItem(STORAGE_KEYS.GPS_CONSENT, record);
      cleanup();
      resolve(true);
    };

    decline.onclick = () => {
      cleanup();
      resolve(false);
    };
  });
}

/**
 * Show 1099 contractor disclaimer on first app load.
 * Only shows when COMPLIANCE_MODE is on and user's employment_type is "1099".
 * employmentType is fetched from tt_employee_settings externally.
 */
export async function showContractorDisclaimer(employmentType) {
  if (!COMPLIANCE_MODE) return;
  if (employmentType !== "1099") return;
  if (localStorage.getItem(STORAGE_KEYS.DISCLAIMER_SEEN)) return;

  return new Promise((resolve) => {
    const overlay = document.getElementById("disclaimer-overlay");
    if (!overlay) { resolve(); return; }

    overlay.classList.remove("hidden");

    const accept = document.getElementById("disclaimer-accept");

    accept.onclick = () => {
      localStorage.setItem(STORAGE_KEYS.DISCLAIMER_SEEN, new Date().toISOString());
      overlay.classList.add("hidden");
      accept.onclick = null;
      resolve();
    };
  });
}

/**
 * Show or hide the privacy policy footer link based on COMPLIANCE_MODE.
 */
export function initComplianceUI() {
  const footerLink = document.getElementById("privacy-link");
  if (footerLink) {
    footerLink.classList.remove("hidden");
  }
}
