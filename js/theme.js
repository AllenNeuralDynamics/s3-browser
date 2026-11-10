// Light / dark / system theme switch. The saved choice is applied before first
// paint by an inline script in index.html; this module wires up the control.

const KEY = "s3-browser:theme";
const root = document.documentElement;

function current() {
  return root.dataset.theme === "light" || root.dataset.theme === "dark" ? root.dataset.theme : "system";
}

function apply(choice) {
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* storage unavailable: the choice lasts for this page view */
  }
  sync();
}

function sync() {
  const choice = current();
  for (const b of document.querySelectorAll("[data-theme-choice]")) {
    b.setAttribute("aria-pressed", String(b.dataset.themeChoice === choice));
  }
}

for (const b of document.querySelectorAll("[data-theme-choice]")) {
  b.addEventListener("click", () => apply(b.dataset.themeChoice));
}
sync();
