class TimeTracker {
  constructor() {
    this.data = JSON.parse(localStorage.getItem("tt_data")) || [];
    this.status = localStorage.getItem("tt_status") || "out";
    this.currentShiftId = localStorage.getItem("tt_shiftId") || null;
    this.userName = localStorage.getItem("tt_user") || "";
    this.unreadLogs = 0;
    this.timerInterval = null;

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
    };

    this.init();
  }

  init() {
    // Restore user name
    this.els.username.value = this.userName;
    this.checkInputState();

    // Listeners
    this.els.username.addEventListener("input", (e) => {
      this.userName = e.target.value;
      localStorage.setItem("tt_user", this.userName);
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

    const now = new Date();
    const timeStr = this.formatTime(now);
    let msg = "";
    let actionType = "";

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
    } else {
      // Clock OUT
      const shift = this.data.find((s) => s.id == this.currentShiftId);
      if (shift) {
        shift.out = now.getTime();
        shift.duration = Math.floor((shift.out - shift.in) / 60000);
      }
      this.status = "out";
      this.currentShiftId = null;
      this.stopTimerLoop();
      this.hideQuote();
      msg = `${timeStr} ${this.userName} - clock out`;
      actionType = "Clock Out";
    }

    this.save();
    this.renderUI();
    this.copyToClipboard(msg);
    this.els.previewText.innerText = msg;
    this.incrementBadge();

    // Send to Cloud (Vercel -> Google)
    this.sendToCloud({
      name: this.userName,
      action: actionType,
      timestamp: now.toISOString(),
      localTime: timeStr,
    });
  }

  addSpecialDay(type) {
    if (!this.validateUser()) return;
    const now = new Date();
    const dur = type === "Paid Off" ? 480 : 0; // 8 hours in mins

    this.data.unshift({
      id: Date.now(),
      dateObj: now.toISOString(),
      type: type,
      in: null,
      out: null,
      duration: dur,
    });
    this.save();

    const msg = `${this.formatDate(now)} ${this.userName} - ${type}`;
    this.copyToClipboard(msg);
    this.els.previewText.innerText = msg;
    this.showToast(`${type} added`);
    this.incrementBadge();

    this.sendToCloud({
      name: this.userName,
      action: type,
      timestamp: now.toISOString(),
      localTime: "N/A",
    });
  }

  // --- Server Side (Vercel) ---
  async sendToCloud(payload) {
    if (!navigator.onLine) return; // Save traffic if offline

    try {
      // Sending to YOUR Vercel API route (we will create this in Part 3)
      await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      console.log("Data sent to cloud");
    } catch (error) {
      console.error("Cloud sync failed:", error);
      // Silent fail is okay for MVP, data is safe locally
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

  deleteItem(id) {
    if (confirm("Delete entry?")) {
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

  clearData() {
    if (confirm("Delete ALL history?")) {
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

  showToast(msg) {
    const t = document.getElementById("toast");
    t.innerText = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 2000);
  }

  // UI Logic
  renderUI() {
    if (this.status === "in") {
      this.els.mainBtn.innerText = "CLOCK OUT";
      this.els.mainBtn.classList.add("clock-out");
      this.els.status.innerText = "ON SHIFT";
      this.els.status.style.color = "var(--pink)";
    } else {
      this.els.mainBtn.innerText = "CLOCK IN";
      this.els.mainBtn.classList.remove("clock-out");
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
