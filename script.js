class TimeTracker {
  constructor() {
    this.data = JSON.parse(localStorage.getItem("tt_data")) || [];
    this.status = localStorage.getItem("tt_status") || "out";
    this.currentShiftId = localStorage.getItem("tt_shiftId") || null;
    this.userName = localStorage.getItem("tt_user") || "";
    // Badge counter (not saved to localstorage, resets on reload)
    this.unreadLogs = 0;

    this.timerInterval = null;
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
    };
    this.init();
  }

  init() {
    this.els.username.value = this.userName;
    this.checkInputState(); // Check initial state of input border

    // Username input handling
    this.els.username.addEventListener("input", (e) => {
      this.userName = e.target.value;
      localStorage.setItem("tt_user", this.userName);
      this.checkInputState();
    });

    this.els.mainBtn.addEventListener("click", () => this.toggleClock());
    document
      .getElementById("history-btn")
      .addEventListener("click", () => this.toggleHistory(true));
    document
      .getElementById("close-history")
      .addEventListener("click", () => this.toggleHistory(false));
    document
      .getElementById("msg-preview")
      .addEventListener("click", () =>
        this.copyToClipboard(this.els.previewText.innerText)
      );
    this.els.quoteBox.addEventListener("click", () => this.hideQuote());
    this.els.periodSelect.addEventListener("change", () => this.renderReport());

    if (this.status === "in") {
      this.startTimerLoop();
      this.showQuote();
    } else {
      this.updateRing(0);
    }
    this.renderUI();
  }

  // --- Validation & Input UI ---

  validateUser() {
    if (!this.userName.trim()) {
      this.triggerError();
      return false;
    }
    return true;
  }

  triggerError() {
    this.els.username.classList.add("input-error");
    this.showToast("Please enter your name first");
    setTimeout(() => this.els.username.classList.remove("input-error"), 300);
  }

  checkInputState() {
    // If name exists, remove border (add filled class)
    if (this.userName.trim().length > 0) {
      this.els.username.classList.add("filled");
    } else {
      this.els.username.classList.remove("filled");
    }
  }

  // --- Core Actions ---

  toggleClock() {
    if (!this.validateUser()) return; // Stop if no name

    const now = new Date();
    const timeStr = this.formatTime(now);
    let msg = "";

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
    }

    this.save();
    this.renderUI();
    this.copyToClipboard(msg);
    this.els.previewText.innerText = msg;
    this.incrementBadge();
  }

  addSpecialDay(type) {
    if (!this.validateUser()) return; // Stop if no name
    const now = new Date();
    const dur = type === "Paid Off" ? 480 : 0;
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

  // --- Timer & Visuals ---
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

  // --- UI Helpers ---
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

  toggleHistory(show) {
    if (show) {
      this.resetBadge(); // Reset badge on open
      this.populatePeriods();
      this.renderHistoryList();
      this.renderReport();
      this.els.historyView.classList.remove("hidden");
    } else {
      this.els.historyView.classList.add("hidden");
    }
  }

  // --- Data & Formatting ---
  save() {
    localStorage.setItem("tt_data", JSON.stringify(this.data));
    localStorage.setItem("tt_status", this.status);
    if (this.currentShiftId)
      localStorage.setItem("tt_shiftId", this.currentShiftId);
    else localStorage.removeItem("tt_shiftId");
  }
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

  // --- Reports ---
  populatePeriods() {
    const select = this.els.periodSelect;
    select.innerHTML = "";
    const today = new Date();
    const currentY = today.getFullYear();
    const currentM = today.getMonth();
    const addOpt = (y, m, isFirst) => {
      const mName = new Date(y, m, 1).toLocaleDateString("en-US", {
        month: "short",
      });
      const val = `${y}-${m}-${isFirst ? "1-15" : "16-31"}`;
      const opt = document.createElement("option");
      opt.value = val;
      opt.innerText = `${mName} ${isFirst ? "1-15" : "16-End"}, ${y}`;
      select.appendChild(opt);
    };
    const isFirst = today.getDate() <= 15;
    addOpt(currentY, currentM, isFirst);
    addOpt(currentY, currentM, !isFirst);
    const prevDate = new Date(currentY, currentM - 1, 1);
    addOpt(prevDate.getFullYear(), prevDate.getMonth(), false);
    addOpt(prevDate.getFullYear(), prevDate.getMonth(), true);
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
      li.innerHTML = `<div class="item-left"><span class="item-date">${this.formatDate(
        new Date(item.dateObj)
      )}</span><span class="item-time">${desc}</span></div><button class="del-btn" onclick="app.deleteItem(${
        item.id
      })">Del</button>`;
      list.appendChild(li);
    });
  }
  renderReport() {
    const val = this.els.periodSelect.value;
    if (!val) return;
    const [y, m, range] = val.split("-");
    const [startD, endD] = range.includes("15") ? [1, 15] : [16, 31];
    const items = this.data
      .filter((i) => {
        const d = new Date(i.dateObj);
        return (
          d.getFullYear() == y &&
          d.getMonth() == m &&
          d.getDate() >= startD &&
          d.getDate() <= endD
        );
      })
      .sort((a, b) => new Date(a.dateObj) - new Date(b.dateObj));
    let total = 0;
    let text = `Timesheet: ${this.userName}\nPeriod: ${
      this.els.periodSelect.options[this.els.periodSelect.selectedIndex].text
    }\n----------------\n`;
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
    document.getElementById("total-hours").innerText = this.minsToHm(total);
    this.reportString =
      text + `----------------\nTotal: ${this.minsToHm(total)}`;
  }
  copyReport() {
    this.copyToClipboard(this.reportString);
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
}
const app = new TimeTracker();
