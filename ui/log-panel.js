/**
 * Copyright 2025 Samuel Frontull and Simon Haller-Seeber, University of Innsbruck
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * Log panel: collects console output, WASM/Python output and uncaught errors
 * and shows them in the collapsible panel below the status bar.
 *
 * Loaded as a classic script before all other scripts, so that it also sees
 * the messages written while the page starts. Exposes window.AlignFixLog.
 */
(function () {
  "use strict";

  const MAX_ENTRIES = 5000;      // older entries are dropped
  const MAX_TEXT = 20000;        // characters per entry
  const LEVELS = ["debug", "info", "warn", "error"];

  const entries = [];            // { time: Date, level, text }
  const counts = { warn: 0, error: 0 };
  let filter = "info";           // minimum level shown
  let pending = [];              // entries not yet rendered
  let flushScheduled = false;
  let isOpen = false;
  const listeners = [];

  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  // ---------------------------------------------------------------- formatting

  function formatArg(arg) {
    if (typeof arg === "string") return arg;
    if (arg === undefined) return "undefined";
    if (arg === null) return "null";
    if (arg instanceof Error) {
      // PythonError messages already contain the traceback
      if (arg.name === "PythonError" || !arg.stack) return `${arg.name}: ${arg.message}`;
      return arg.stack.includes(arg.message) ? arg.stack : `${arg.name}: ${arg.message}\n${arg.stack}`;
    }
    if (typeof arg === "object") {
      try {
        const json = JSON.stringify(arg);
        if (json !== undefined) return json;
      } catch (e) { /* circular or not serialisable */ }
    }
    return String(arg);
  }

  function formatArgs(args) {
    let text = Array.from(args, formatArg).join(" ");
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + " … (truncated)";
    return text;
  }

  function timeLabel(date) {
    return date.toLocaleTimeString([], { hour12: false });
  }

  // ------------------------------------------------------------------ storing

  function add(level, text) {
    if (text === "") return;
    const entry = { time: new Date(), level, text };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    if (level === "warn" || level === "error") counts[level]++;
    if (isOpen && shown(entry)) {
      pending.push(entry);
      scheduleFlush();
    }
    updateCounts();
    for (const listener of listeners) {
      try { listener(entry); } catch (e) { /* ignore listener errors */ }
    }
  }

  function shown(entry) {
    return LEVELS.indexOf(entry.level) >= LEVELS.indexOf(filter);
  }

  // ---------------------------------------------------------------- rendering

  function el(id) { return document.getElementById(id); }

  function renderEntry(entry) {
    const row = document.createElement("div");
    row.className = `log-entry log-${entry.level}`;
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = timeLabel(entry.time);
    const text = document.createElement("span");
    text.className = "log-text";
    text.textContent = entry.text;   // never interpreted as HTML
    row.append(time, text);
    return row;
  }

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    // requestAnimationFrame does not run in background tabs; the panel is not
    // visible there anyway, and the entries are rendered when the tab returns.
    requestAnimationFrame(flush);
  }

  function flush() {
    flushScheduled = false;
    const container = el("log-messages");
    if (!container || pending.length === 0) { pending = []; return; }
    const scroller = el("log-scroll");
    const atBottom = !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;

    const fragment = document.createDocumentFragment();
    for (const entry of pending.slice(-MAX_ENTRIES)) fragment.appendChild(renderEntry(entry));
    pending = [];
    container.appendChild(fragment);
    while (container.childElementCount > MAX_ENTRIES) container.firstElementChild.remove();
    const empty = el("log-empty");
    if (empty) empty.hidden = container.childElementCount > 0;

    if (scroller && atBottom) scroller.scrollTop = scroller.scrollHeight;
  }

  function rerender() {
    const container = el("log-messages");
    if (!container) return;
    container.textContent = "";
    pending = entries.filter(shown);
    if (pending.length === 0) {
      const empty = el("log-empty");
      if (empty) empty.hidden = false;
      return;
    }
    flush();
    const scroller = el("log-scroll");
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  function updateCounts() {
    const warn = el("log-warn-count");
    const error = el("log-error-count");
    if (warn) {
      warn.textContent = counts.warn;
      warn.hidden = counts.warn === 0;
      warn.title = `${counts.warn} warning(s)`;
    }
    if (error) {
      error.textContent = counts.error;
      error.hidden = counts.error === 0;
      error.title = `${counts.error} error(s)`;
    }
  }

  // ------------------------------------------------------------- open / close

  function setOpen(open) {
    isOpen = open;
    const panel = el("log-panel");
    const toggle = el("status-toggle");
    if (panel) panel.hidden = !open;
    if (toggle) toggle.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("log-open", open);
    if (open) rerender();
  }

  // ------------------------------------------------------------------ exports

  function asText(list) {
    return list.map(e => `[${e.time.toISOString()}] ${e.level.toUpperCase().padEnd(5)} ${e.text}`).join("\n");
  }

  function download() {
    const blob = new Blob([asText(entries) + "\n"], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `alignfix-log-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copy(button) {
    const text = asText(entries.filter(shown));
    try {
      await navigator.clipboard.writeText(text);
      flashButton(button, "fa-check");
    } catch (e) {
      flashButton(button, "fa-xmark");
    }
  }

  function flashButton(button, icon) {
    if (!button) return;
    const old = button.innerHTML;
    button.innerHTML = `<i class="fas ${icon}"></i>`;
    setTimeout(() => { button.innerHTML = old; }, 1200);
  }

  function clear() {
    entries.length = 0;
    pending = [];
    counts.warn = 0;
    counts.error = 0;
    updateCounts();
    rerender();
  }

  // ------------------------------------------------------- console capturing

  function capture(method, level) {
    console[method] = function (...args) {
      original[method](...args);
      try { add(level, formatArgs(args)); } catch (e) { /* never break console */ }
    };
  }
  capture("log", "info");
  capture("info", "info");
  capture("debug", "debug");
  capture("warn", "warn");
  capture("error", "error");

  window.addEventListener("error", (event) => {
    const where = event.filename ? ` (${event.filename.split("/").pop()}:${event.lineno})` : "";
    add("error", `Uncaught ${event.error ? formatArg(event.error) : event.message}${where}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    add("error", `Unhandled rejection: ${formatArg(event.reason)}`);
  });

  // ------------------------------------------------------------- wiring

  function init() {
    const toggle = el("status-toggle");
    if (toggle) toggle.addEventListener("click", () => setOpen(!isOpen));

    const level = el("log-level");
    if (level) {
      level.value = filter;
      level.addEventListener("change", () => { filter = level.value; rerender(); });
    }
    const copyBtn = el("log-copy");
    if (copyBtn) copyBtn.addEventListener("click", () => copy(copyBtn));
    const downloadBtn = el("log-download");
    if (downloadBtn) downloadBtn.addEventListener("click", download);
    const clearBtn = el("log-clear");
    if (clearBtn) clearBtn.addEventListener("click", clear);

    updateCounts();
    setOpen(false);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.AlignFixLog = {
    debug: (...args) => { original.debug(...args); add("debug", formatArgs(args)); },
    info: (...args) => { original.log(...args); add("info", formatArgs(args)); },
    warn: (...args) => { original.warn(...args); add("warn", formatArgs(args)); },
    error: (...args) => { original.error(...args); add("error", formatArgs(args)); },
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!isOpen),
    isOpen: () => isOpen,
    entries: () => entries.slice(),
    onEntry: (listener) => listeners.push(listener),
    download,
    clear,
  };
})();
