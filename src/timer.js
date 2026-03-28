const CIRCUMFERENCE = 691;
const EIGHT_HOURS_SEC = 8 * 3600;

let timerInterval = null;
let els = null;

export function initTimer(elements) {
  els = elements;
}

export function startTimerLoop(getShift) {
  if (timerInterval) clearInterval(timerInterval);
  const tick = () => updateTimer(getShift);
  tick();
  timerInterval = setInterval(tick, 1000);
}

export function stopTimerLoop() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  els.timer.innerText = "00:00:00";
  updateRing(0);
}

function updateTimer(getShift) {
  const shift = getShift();
  if (!shift) return;
  const totalSeconds = Math.floor((Date.now() - shift.in) / 1000);

  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  els.timer.innerText = `${pad(h)}:${pad(m)}:${pad(s)}`;
  updateRing(totalSeconds);
}

function updateRing(totalSeconds) {
  const blueProgress = Math.min(totalSeconds / EIGHT_HOURS_SEC, 1);
  els.ringBlue.style.strokeDashoffset = CIRCUMFERENCE - blueProgress * CIRCUMFERENCE;

  if (totalSeconds > EIGHT_HOURS_SEC) {
    const pinkProgress = Math.min(
      (totalSeconds - EIGHT_HOURS_SEC) / EIGHT_HOURS_SEC,
      1
    );
    els.ringPink.style.strokeDashoffset = CIRCUMFERENCE - pinkProgress * CIRCUMFERENCE;
  } else {
    els.ringPink.style.strokeDashoffset = CIRCUMFERENCE;
  }
}

function pad(n) {
  return n.toString().padStart(2, "0");
}
