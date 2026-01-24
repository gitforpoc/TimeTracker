class TimeTracker {
  constructor() {
    this.data = [];
    try {
      const savedData = localStorage.getItem("tt_data");
      if (savedData) {
        this.data = JSON.parse(savedData);
      }
    } catch (e) {
      console.error("Failed to parse local data:", e);
    }
    this.status = localStorage.getItem("tt_status") || "out";
    this.currentShiftId = localStorage.getItem("tt_shiftId") || null;
    this.userName = localStorage.getItem("tt_user") || "";
    this.autoShare = localStorage.getItem("tt_autoShare") === "true"; // Load setting
    this.unreadLogs = 0;
    this.timerInterval = null;
    this.lastClickTime = 0; // For debounce
    this.syncTimeouts = new Map(); // Store timeouts for delayed cloud sync
    this.resumeSeconds = 0;
    this.resumeInterval = null;

    // Quotes for motivation
    this.quotes = [
      "Precision in every move.",
      "Calm is a superpower.",
      "Be the solution.",
      "Make it look easy.",
      "Quality over speed.",
      "Safety first, speed second.",
      "Focus on the details.",
      "Stay professional.",
    ];

    // UI Elements Cache
    this.els = {
      mainBtn: document.getElementById("main-action-btn"),
      timer: document.getElementById("main-timer"),
      status: document.getElementById("status-label"),
      ringBlue: document.querySelector(".ring-progress-blue"),
      ringPink: document.querySelector(".ring-progress-pink"),
      quoteBox: document.getElementById("quote-box"),
      quoteText: document.getElementById("quote-text"),
      username: document.getElementById("username"),
      historyView: document.getElementById("history-view"),
      periodSelect: document.getElementById("period-select"),
      previewText: document.getElementById("msg-text"),
      badge: document.getElementById("history-badge"),
      // New elements for Custom Range (will be in HTML part)
      customRangeBox: document.getElementById("custom-range-box"),
      dateStart: document.getElementById("date-start"),
      dateEnd: document.getElementById("date-end"),
      autoShareToggle: document.getElementById("auto-share-toggle"),
    };

    this.init();
  }

  init() {
    // Restore user name
    this.els.username.value = this.userName;
    this.checkInputState();

    // Restore Auto-Share setting
    this.els.autoShareToggle.checked = this.autoShare;
    this.els.autoShareToggle.addEventListener("change", (e) => {
      this.autoShare = e.target.checked;
      localStorage.setItem("tt_autoShare", this.autoShare);
    });

    // Listeners for Username
    this.els.username.addEventListener("input", () => this.checkInputState());
    this.els.username.addEventListener("change", async (e) => {
      const newName = e.target.value.trim();
      const oldName = this.userName;

      if (oldName && newName && oldName !== newName) {
        const confirmed = await this.showDialog(
          `Change name to "${newName}"?`,
          false
        );
        if (confirmed) {
          this.userName = newName;
          localStorage.setItem("tt_user", this.userName);
        } else {
          this.els.username.value = oldName;
        }
      } else {
        this.userName = newName;
        localStorage.setItem("tt_user", this.userName);
      }
      this.checkInputState();
    });

    this.els.mainBtn.addEventListener("click", () => this.toggleClock());

    // Navigation & History
    document
      .getElementById("history-btn")
      .addEventListener("click", () => this.openHistory());
    document
      .getElementById("close-history")
      .addEventListener("click", () => this.closeHistory());

    // Handle physical "Back" button on phone
    window.addEventListener("popstate", (event) => {
      if (event.state && event.state.modal === "history") {
        this.els.historyView.classList.remove("hidden");
      } else {
        this.els.historyView.classList.add("hidden");
      }
    });

    // Copy actions
    document
      .getElementById("msg-preview")
      .addEventListener("click", () =>
        this.copyToClipboard(this.els.previewText.innerText)
      );
    this.els.quoteBox.addEventListener("click", () => this.hideQuote());

    // Report Logic
    this.els.periodSelect.addEventListener("change", () =>
      this.handlePeriodChange()
    );
    this.els.dateStart.addEventListener("change", () => this.renderReport());
    this.els.dateEnd.addEventListener("change", () => this.renderReport());

    // Resume state
    if (this.status === "in") {
      this.startTimerLoop();
      this.showQuote();
    } else if (this.status === "pending") {
      this.finalizeClockOut(); // Safety: if reloaded during pending, just finish the shift
    } else {
      this.updateRing(0);
    }
    this.renderUI();
  }

  // --- Validation ---
  validateUser() {
    if (!this.userName.trim()) {
      this.els.username.classList.add("input-error");
      this.showToast("Please enter your name first");
      setTimeout(() => this.els.username.classList.remove("input-error"), 400);
      return false;
    }
    return true;
  }

  checkInputState() {
    if (this.userName.trim().length > 0)
      this.els.username.classList.add("filled");
    else this.els.username.classList.remove("filled");
  }

  // --- Core Actions ---
  toggleClock() {
    if (!this.validateUser()) return;

    // Prevent double clicks (2s debounce)
    const nowTime = Date.now();
    if (nowTime - this.lastClickTime < 2000) return;
    this.lastClickTime = nowTime;

    const now = new Date();
    const timeStr = this.formatTime(now);
    let msg = "";
    let actionType = "";

    if (this.status === "pending") {
      // RESUME logic: Cancel the pending clock-out
      this.cancelClockOut();
      return;
    }

    if (this.status === "out") {
      // Clock IN
      const newShift = {
        id: Date.now(),
        dateObj: now.toISOString(),
        type: "work",
        in: now.getTime(),
        out: null,
        duration: 0,
      };
      this.data.unshift(newShift);
      this.currentShiftId = newShift.id;
      this.status = "in";
      this.showQuote();
      msg = `${timeStr} ${this.userName} - clock in`;
      actionType = "Clock In";
      this.startTimerLoop();

      this.save();
      this.renderUI();
      this.copyToClipboard(msg);
      this.els.previewText.innerText = msg;
      this.incrementBadge();

      // Try to share if enabled
      if (this.autoShare) this.shareText(msg);

      this.scheduleCloudSync(newShift.id, {
        name: this.userName,
        action: actionType,
        timestamp: now.toISOString(),
        localTime: timeStr,
      });
    } else {
      // Start PENDING Clock OUT
      const shift = this.data.find((s) => s.id == this.currentShiftId);
      if (shift) {
        shift.out = now.getTime();
        shift.duration = Math.floor((shift.out - shift.in) / 60000);
        this.status = "pending";

        // IMMEDIATE ACTION: Generate text & Copy
        const timeStr = this.formatTime(now);
        const msg = `${timeStr} ${this.userName} - clock out`;
        this.copyToClipboard(msg);
        this.els.previewText.innerText = msg;

        // Try to share if enabled
        if (this.autoShare) this.shareText(msg);

        this.updateTimer(); // Update one last time to show final duration
        this.stopTimerLoop(); // Stop main loop to prevent ring flickering
        this.startResumeTimer();
      }
      this.renderUI();
    }
  }

  startResumeTimer() {
    this.resumeSeconds = 10;
    if (this.resumeInterval) clearInterval(this.resumeInterval);

    this.resumeInterval = setInterval(() => {
      this.resumeSeconds--;
      this.renderUI();
      this.updateRingPending(this.resumeSeconds);

      if (this.resumeSeconds <= 0) {
        this.finalizeClockOut();
      }
    }, 1000);
  }

  cancelClockOut() {
    clearInterval(this.resumeInterval);
    const shift = this.data.find((s) => s.id == this.currentShiftId);
    if (shift) {
      shift.out = null;
      shift.duration = 0;
    }
    this.status = "in";
    this.startTimerLoop(); // Restart main loop
    this.save();
    this.renderUI();
  }

  finalizeClockOut() {
    clearInterval(this.resumeInterval);
    const shift = this.data.find((s) => s.id == this.currentShiftId);

    if (shift && shift.out - shift.in < 60000) {
      // If it was an accidental short shift and they didn't resume, just delete it
      this.data = this.data.filter((s) => s.id !== this.currentShiftId);
      this.showToast("Short shift discarded");
    } else {
      const now = new Date(shift.out);
      const timeStr = this.formatTime(now);
      const msg = `${timeStr} ${this.userName} - clock out`; // Re-generate just for sync payload

      // Note: We already copied to clipboard in toggleClock
      this.els.previewText.innerText = msg;
      this.incrementBadge();
      this.showToast("Shift saved");

      this.scheduleCloudSync(shift.id + "_out", {
        name: this.userName,
        action: "Clock Out",
        timestamp: now.toISOString(),
        localTime: timeStr,
      });
    }

    this.status = "out";
    this.currentShiftId = null;
    this.stopTimerLoop();
    this.hideQuote();
    this.save();
    this.renderUI();
  }

  async addSpecialDay(type) {
    if (!this.validateUser()) return;

    // Use custom dialog instead of prompt
    const dateInput = await this.showDialog(`Select date for ${type}`, true);
    if (!dateInput) return;

    const selectedDate = new Date(dateInput);
    if (isNaN(selectedDate.getTime())) {
      this.showToast("Invalid date format");
      return;
    }

    // Logic checks
    const isToday = selectedDate.toDateString() === new Date().toDateString();
    if (this.status === "in" && isToday) {
      const confirmToday = await this.showDialog(
        "You are currently ON SHIFT. Add a day off for today anyway?",
        false
      );
      if (!confirmToday) return;
    }

    const hasConflict = this.data.some(
      (i) => new Date(i.dateObj).toDateString() === selectedDate.toDateString()
    );
    if (hasConflict) {
      const confirmConflict = await this.showDialog(
        "You already have an entry for this date. Add another one?",
        false
      );
      if (!confirmConflict) return;
    }

    const dur = type === "Paid Off" ? 480 : 0; // 8 hours in mins
    const entryId = Date.now();
    this.data.unshift({
      id: entryId,
      dateObj: selectedDate.toISOString(),
      type: type,
      in: null,
      out: null,
      duration: dur,
    });
    this.save();

    const msg = `${this.formatDate(selectedDate)} ${this.userName} - ${type}`;
    this.copyToClipboard(msg);
    this.els.previewText.innerText = msg;
    this.showToast(`${type} added`);
    this.incrementBadge();

    // Try to share if enabled
    if (this.autoShare) this.shareText(msg);

    this.scheduleCloudSync(entryId, {
      name: this.userName,
      action: type,
      timestamp: selectedDate.toISOString(),
      localTime: "N/A",
    });
  }

  // Helper for custom pretty dialogs
  showDialog(title, showDateInput = false) {
    return new Promise((resolve) => {
      const dialog = document.getElementById("custom-dialog");
      const titleEl = document.getElementById("dialog-title");
      const dateInput = document.getElementById("dialog-date-input");
      const confirmBtn = document.getElementById("dialog-confirm");
      const cancelBtn = document.getElementById("dialog-cancel");

      titleEl.innerText = title;
      dateInput.style.display = showDateInput ? "block" : "none";
      if (showDateInput)
        dateInput.value = new Date().toISOString().split("T")[0];

      dialog.classList.remove("hidden");

      const close = (result) => {
        dialog.classList.add("hidden");
        confirmBtn.onclick = null;
        cancelBtn.onclick = null;
        resolve(result);
      };

      confirmBtn.onclick = () => close(showDateInput ? dateInput.value : true);
      cancelBtn.onclick = () => close(false);
    });
  }

  scheduleCloudSync(id, payload) {
    // If there's an existing timeout for this ID, clear it
    if (this.syncTimeouts.has(id)) clearTimeout(this.syncTimeouts.get(id));

    const timeout = setTimeout(() => {
      this.sendToCloud(payload);
      this.syncTimeouts.delete(id);
    }, 60000); // 1 minute delay

    this.syncTimeouts.set(id, timeout);
  }

  async sendToCloud(payload) {
    if (!navigator.onLine) return;

    try {
      const response = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || response.statusText);
      }
    } catch (error) {
      this.showToast("⚠️ Cloud Sync Error: " + error.message);
    }
  }

  // --- Badge Logic ---
  incrementBadge() {
    this.unreadLogs++;
    this.updateBadgeUI();
  }
  resetBadge() {
    this.unreadLogs = 0;
    this.updateBadgeUI();
  }
  updateBadgeUI() {
    if (this.unreadLogs > 0) {
      this.els.badge.innerText = this.unreadLogs > 9 ? "9+" : this.unreadLogs;
      this.els.badge.classList.remove("hidden");
    } else {
      this.els.badge.classList.add("hidden");
    }
  }

  // --- Navigation ---
  openHistory() {
    this.resetBadge();
    this.populatePeriods(); // Refresh list
    this.renderHistoryList();
    this.renderReport(); // Initial render

    this.els.historyView.classList.remove("hidden");
    // Push state to browser history for "Back" button support
    window.history.pushState({ modal: "history" }, "History", "#history");
  }

  closeHistory() {
    this.els.historyView.classList.add("hidden");
    // Remove the state we just pushed if user clicks "X"
    if (window.history.state && window.history.state.modal === "history") {
      window.history.back();
    }
  }

  // --- Timer Engine ---
  startTimerLoop() {
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.updateTimer();
    this.timerInterval = setInterval(() => this.updateTimer(), 1000);
  }
  stopTimerLoop() {
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.els.timer.innerText = "00:00:00";
    this.updateRing(0);
  }
  updateTimer() {
    const shift = this.data.find((s) => s.id == this.currentShiftId);
    if (!shift) return;
    const totalSeconds = Math.floor((new Date().getTime() - shift.in) / 1000);

    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;

    this.els.timer.innerText = `${h.toString().padStart(2, "0")}:${m
      .toString()
      .padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    this.updateRing(totalSeconds);
  }

  updateRingPending(seconds) {
    const C = 691;
    let progress = seconds / 10;
    this.els.ringPink.style.strokeDashoffset = C - progress * C;
  }

  updateRing(totalSeconds) {
    const C = 691;
    const eightHoursSec = 8 * 3600;
    let blueProgress = Math.min(totalSeconds / eightHoursSec, 1);
    this.els.ringBlue.style.strokeDashoffset = C - blueProgress * C;

    if (totalSeconds > eightHoursSec) {
      let pinkProgress = Math.min(
        (totalSeconds - eightHoursSec) / eightHoursSec,
        1
      );
      this.els.ringPink.style.strokeDashoffset = C - pinkProgress * C;
    } else {
      this.els.ringPink.style.strokeDashoffset = C;
    }
  }

  // --- Reports & Custom Range ---
  populatePeriods() {
    const select = this.els.periodSelect;
    select.innerHTML = "";

    const today = new Date();
    const currentY = today.getFullYear();
    const currentM = today.getMonth();

    // Standard Periods (Last 3 months)
    const addOpt = (y, m, isFirst) => {
      const mName = new Date(y, m, 1).toLocaleDateString("en-US", {
        month: "short",
      });
      const val = `${y}-${m}-${isFirst ? "1-15" : "16-31"}`;
      const label = `${mName} ${isFirst ? "1-15" : "16-End"}, ${y}`;
      const opt = document.createElement("option");
      opt.value = val;
      opt.innerText = label;
      select.appendChild(opt);
    };

    const isFirst = today.getDate() <= 15;
    addOpt(currentY, currentM, isFirst); // Current
    addOpt(currentY, currentM, !isFirst); // Other half
    const prevDate = new Date(currentY, currentM - 1, 1);
    addOpt(prevDate.getFullYear(), prevDate.getMonth(), false);
    addOpt(prevDate.getFullYear(), prevDate.getMonth(), true);

    // Add Custom Option at the end
    const customOpt = document.createElement("option");
    customOpt.value = "custom";
    customOpt.innerText = "⚙️ Custom Range...";
    select.appendChild(customOpt);
  }

  handlePeriodChange() {
    if (this.els.periodSelect.value === "custom") {
      this.els.customRangeBox.classList.remove("hidden");
    } else {
      this.els.customRangeBox.classList.add("hidden");
    }
    this.renderReport();
  }

  getReportItems() {
    const val = this.els.periodSelect.value;
    if (!val) return [];

    let startDate, endDate;

    if (val === "custom") {
      // Read from date inputs
      if (!this.els.dateStart.value || !this.els.dateEnd.value) return [];
      startDate = new Date(this.els.dateStart.value);
      endDate = new Date(this.els.dateEnd.value);
      // Set end date to end of day
      endDate.setHours(23, 59, 59, 999);
    } else {
      // Parse standard value "2026-0-1-15"
      const [y, m, range] = val.split("-");
      const [startD, endD] = range.includes("15") ? [1, 15] : [16, 31];
      startDate = new Date(y, m, startD);
      endDate = new Date(y, m, endD);
      endDate.setHours(23, 59, 59, 999);
    }

    return this.data
      .filter((i) => {
        const d = new Date(i.dateObj);
        return d >= startDate && d <= endDate;
      })
      .sort((a, b) => new Date(a.dateObj) - new Date(b.dateObj));
  }

  renderReport() {
    const items = this.getReportItems();
    let total = 0;
    let text = `Timesheet: ${this.userName}\n`;

    // Header
    if (this.els.periodSelect.value === "custom") {
      text += `Period: ${this.els.dateStart.value} to ${this.els.dateEnd.value}\n`;
    } else {
      text += `Period: ${
        this.els.periodSelect.options[this.els.periodSelect.selectedIndex].text
      }\n`;
    }
    text += `----------------\n`;

    items.forEach((i) => {
      const dStr = this.formatDate(new Date(i.dateObj));
      if (i.type === "work" && i.out) {
        total += i.duration;
        text += `${dStr} ${this.formatTime(new Date(i.in))} - ${this.formatTime(
          new Date(i.out)
        )} (${this.minsToHm(i.duration)})\n`;
      } else if (i.type.includes("Off")) {
        total += i.duration;
        text += `${dStr} ${i.type} (${this.minsToHm(i.duration)})\n`;
      }
    });

    const totalString = this.minsToHm(total);
    document.getElementById("total-hours").innerText = totalString;
    text += `----------------\nTotal: ${totalString}`;

    this.currentReportText = text; // Store for copying
  }

  renderHistoryList() {
    const list = document.getElementById("history-list");
    list.innerHTML = "";
    this.data.slice(0, 15).forEach((item) => {
      const li = document.createElement("li");
      li.className = "history-item";

      let desc =
        item.type === "work"
          ? `${this.formatTime(new Date(item.in))} - ${
              item.out ? this.formatTime(new Date(item.out)) : "Active"
            }`
          : item.type;

      if (item.duration > 0) desc += ` (${this.minsToHm(item.duration)})`;

      li.innerHTML = `
                <div class="item-left">
                    <span class="item-date">${this.formatDate(
                      new Date(item.dateObj)
                    )}</span>
                    <span class="item-time">${desc}</span>
                </div>
                <button class="del-btn" onclick="app.deleteItem(${
                  item.id
                })">Del</button>
            `;
      list.appendChild(li);
    });
  }

  // --- Utilities ---
  copyReport() {
    if (this.currentReportText) {
      this.copyToClipboard(this.currentReportText);
    } else {
      this.showToast("Report is empty or loading...");
    }
  }

  async deleteItem(id) {
    if (await this.showDialog("Delete entry?", false)) {
      this.data = this.data.filter((i) => i.id !== id);
      if (this.currentShiftId === id) {
        this.status = "out";
        this.currentShiftId = null;
        this.stopTimerLoop();
        this.renderUI();
      }
      this.save();
      this.renderHistoryList();
      this.renderReport();
    }
  }

  async clearData() {
    if (await this.showDialog("Delete ALL history?", false)) {
      localStorage.clear();
      location.reload();
    }
  }

  exportData() {
    const a = document.createElement("a");
    a.href =
      "data:text/json;charset=utf-8," +
      encodeURIComponent(JSON.stringify(this.data));
    a.download = "timetracker_backup.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  save() {
    localStorage.setItem("tt_data", JSON.stringify(this.data));
    localStorage.setItem("tt_status", this.status);
    if (this.currentShiftId)
      localStorage.setItem("tt_shiftId", this.currentShiftId);
    else localStorage.removeItem("tt_shiftId");
  }

  // Helpers
  formatTime(d) {
    return d
      .toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      })
      .toLowerCase()
      .replace(/\s/g, "");
  }
  formatDate(d) {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  minsToHm(m) {
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  copyToClipboard(text) {
    navigator.clipboard
      .writeText(text)
      .then(() => this.showToast("Copied to clipboard!"));
  }

  async shareText(text) {
    if (navigator.share) {
      try {
        await navigator.share({ text: text });
      } catch (err) {
        // User cancelled share or error, ignore
      }
    }
  }

  showToast(msg) {
    const t = document.getElementById("toast");
    t.innerText = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 2000);
  }

  // UI Logic
  renderUI() {
    if (this.status === "pending") {
      this.els.mainBtn.innerText = `RESUME (${this.resumeSeconds}s)`;
      this.els.mainBtn.classList.add("clock-out");
      this.els.mainBtn.classList.add("pending");
      this.els.status.innerText = "ENDING SHIFT...";
      this.els.status.style.color = "var(--pink)";
    } else if (this.status === "in") {
      this.els.mainBtn.innerText = "CLOCK OUT";
      this.els.mainBtn.classList.add("clock-out");
      this.els.mainBtn.classList.remove("pending");
      this.els.status.innerText = "ON SHIFT";
      this.els.status.style.color = "var(--pink)";
    } else if (this.status === "out") {
      this.els.mainBtn.innerText = "CLOCK IN";
      this.els.mainBtn.classList.remove("clock-out");
      this.els.mainBtn.classList.remove("pending");
      this.els.status.innerText = "OFF DUTY";
      this.els.status.style.color = "var(--gray)";
    }
  }
  showQuote() {
    this.els.quoteText.innerText =
      this.quotes[Math.floor(Math.random() * this.quotes.length)];
    this.els.quoteBox.classList.remove("hidden");
  }
  hideQuote() {
    this.els.quoteBox.classList.add("hidden");
  }
}

const app = new TimeTracker();
