// Light and dark theme. Loaded in <head>, before the page is drawn, so a dark
// page never flashes white. Without a saved choice the system setting is used.
(function () {
  const KEY = "alignfix-theme";
  const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function saved() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  function preferred() {
    const s = saved();
    if (s === "light" || s === "dark") return s;
    return media && media.matches ? "dark" : "light";
  }

  // Chart.js reads its colours when a chart is drawn: set them, then redraw.
  function styleCharts() {
    if (!window.Chart) return;
    const css = getComputedStyle(document.documentElement);
    const text = css.getPropertyValue("--text-muted").trim();
    const grid = css.getPropertyValue("--divider").trim();
    Chart.defaults.color = text;
    Chart.defaults.borderColor = grid;
    Object.values(Chart.instances || {}).forEach(chart => {
      Object.values(chart.options.scales || {}).forEach(scale => {
        if (scale.ticks) scale.ticks.color = text;
        if (scale.grid) scale.grid.color = grid;
        if (scale.title) scale.title.color = text;
      });
      const legend = chart.options.plugins && chart.options.plugins.legend;
      if (legend && legend.labels) legend.labels.color = text;
      chart.update("none");
    });
  }

  function updateButtons(theme) {
    document.querySelectorAll(".theme-toggle").forEach(btn => {
      const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
      btn.title = label;
      btn.setAttribute("aria-label", label);
    });
  }

  function apply(theme) {
    document.documentElement.setAttribute("data-bs-theme", theme);
    updateButtons(theme);
    styleCharts();
  }

  function toggle() {
    const next = document.documentElement.getAttribute("data-bs-theme") === "dark" ? "light" : "dark";
    try { localStorage.setItem(KEY, next); } catch (e) { /* private mode */ }
    apply(next);
  }

  apply(preferred());

  if (media) {
    const follow = () => { if (!saved()) apply(preferred()); };
    if (media.addEventListener) media.addEventListener("change", follow);
    else if (media.addListener) media.addListener(follow);
  }

  document.addEventListener("click", e => {
    if (e.target.closest(".theme-toggle")) toggle();
  });
  document.addEventListener("DOMContentLoaded", () => updateButtons(preferred()));
  // Chart.js loads at the end of <body>
  window.addEventListener("load", styleCharts);

  window.AlignFixTheme = { apply, toggle, styleCharts, current: () => document.documentElement.getAttribute("data-bs-theme") };
})();
