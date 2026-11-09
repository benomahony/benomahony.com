// The visitor's "AI features" switch: whether it's on, remembered per
// browser, and the explainer it shows before the first download.

const root = document.querySelector(".site-search");
const toggle = root.querySelector(".site-search-switch input");
const explain = root.querySelector(".site-search-explain");
const [confirmOn, notNow] = explain.querySelectorAll(".site-search-explain-actions button");

const SETTING = "ai-features";

export function enabled() {
  try {
    return localStorage.getItem(SETTING) === "on";
  } catch {
    return false;
  }
}

// Where storage is blocked the switch still works, just for this page.
export function remember(on) {
  try {
    if (on) localStorage.setItem(SETTING, "on");
    else localStorage.removeItem(SETTING);
  } catch (error) {
    console.warn("Couldn't remember the AI features setting:", error);
  }
}

// Turning on downloads about 370 MB, so the switch first explains what it does.
export function showExplainer() {
  explain.hidden = false;
  confirmOn.focus();
}

function hideExplainer() {
  if (explain.hidden) return;
  explain.hidden = true;
  toggle.focus();
}

// `turnOn` runs once they agree to the download.
export function onConfirm(turnOn) {
  confirmOn.addEventListener("click", () => {
    explain.hidden = true;
    turnOn();
  });
}

notNow.addEventListener("click", hideExplainer);
explain.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideExplainer();
});
document.addEventListener("pointerdown", (event) => {
  if (
    !explain.hidden &&
    !explain.contains(event.target) &&
    !toggle.parentElement.contains(event.target)
  ) {
    explain.hidden = true;
  }
});
