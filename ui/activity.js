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
 * Progress of long-running operations, shown in the status bar.
 *
 * An *activity* is one user-visible operation ("Creating project"). It is
 * divided into nested *stages*: stage(from, to, label, fn) runs fn as the part
 * [from, to] of the enclosing stage, and report(fraction) moves the bar within
 * the innermost stage. A helper therefore reports 0..1 for its own work no
 * matter where it is used, and the bar of the whole activity never jumps back.
 *
 *   await runActivity("Creating project", async () => {
 *     await stage(0.0, 0.1, "Tokenizing", () => tokenise(...));
 *     await stage(0.1, 0.7, "Aligning", () => align(...));   // reports 0..1
 *   });
 *
 * Python code reports through window.alignfixProgress (see backend/py/progress.py).
 * Outside of an activity, stage() and report() do nothing.
 */

const log = () => window.AlignFixLog || console;

let current = null;     // the running activity
let lastYield = 0;
let renderScheduled = false;
let clockTimer = null;

export class BusyError extends Error {
  constructor(title) {
    super(`Please wait until "${title}" has finished.`);
    this.name = "BusyError";
  }
}

export function isBusy() {
  return current !== null;
}

export function currentActivityTitle() {
  return current ? current.title : null;
}

// ------------------------------------------------------------------ yielding

/**
 * Let the browser handle events and repaint. Unlike requestAnimationFrame
 * alone, this also continues in background tabs (where animation frames do
 * not run), so long operations do not stall while the tab is hidden.
 */
export function yieldToUI() {
  lastYield = performance.now();
  return new Promise(resolve => {
    if (document.hidden) {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(null);
    } else {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    }
  });
}

/** yieldToUI(), but at most every `intervalMs` (for tight loops). */
export function maybeYield(intervalMs = 50) {
  if (performance.now() - lastYield < intervalMs) return Promise.resolve();
  return yieldToUI();
}

// ------------------------------------------------------------------ activities

/**
 * Run fn as the activity `title`. Throws BusyError if another activity is
 * running (operations share the WASM modules and the database). Rethrows
 * errors of fn after marking the activity as failed.
 *
 * options.done(result) may return the message shown on success.
 */
export async function runActivity(title, fn, options = {}) {
  if (current) throw new BusyError(current.title);

  current = {
    title,
    startedAt: performance.now(),
    stack: [{ from: 0, to: 1, label: title }],
    value: 0,
    detail: "",
  };
  document.body.classList.add("is-busy");
  window.addEventListener("beforeunload", warnBeforeUnload);
  log().info(`▶ ${title}`);
  showRunning();

  try {
    await yieldToUI();
    const result = await fn();
    const seconds = elapsedSeconds();
    const message = (options.done && options.done(result)) || `${title}: done`;
    finish("done", message, seconds);
    log().info(`✔ ${message} (${formatDuration(seconds)})`);
    return result;
  } catch (err) {
    const seconds = elapsedSeconds();
    const reason = errorMessage(err);
    finish("failed", `${title} failed: ${firstLine(reason)}`, seconds);
    log().error(`✖ ${title} failed after ${formatDuration(seconds)}:`, err);
    if (err && typeof err === "object") err.alignfixLogged = true;
    throw err;
  }
}

/** Run fn as the part [from, to] (fractions 0..1) of the current stage. */
export async function stage(from, to, label, fn) {
  const depth = pushStage(from, to, label);
  try {
    return await fn();
  } finally {
    popStage(depth);
  }
}

/** Progress within the current stage: fraction 0..1, optional detail text. */
export function report(fraction, detail) {
  if (!current) return;
  const top = current.stack[current.stack.length - 1];
  if (typeof fraction === "number" && Number.isFinite(fraction)) {
    const clamped = Math.min(1, Math.max(0, fraction));
    advance(top.from + (top.to - top.from) * clamped);
  }
  if (detail !== undefined && detail !== null) current.detail = String(detail);
  scheduleRender();
}

function pushStage(from, to, label) {
  if (!current) return 0;
  const parent = current.stack[current.stack.length - 1];
  const span = parent.to - parent.from;
  const s = {
    from: parent.from + span * Math.min(1, Math.max(0, from)),
    to: parent.from + span * Math.min(1, Math.max(0, to)),
    label: label || "",
  };
  current.stack.push(s);
  current.detail = "";
  advance(s.from);
  if (label) log().debug(`  › ${label}`);
  scheduleRender();
  return current.stack.length;
}

function popStage(depth) {
  if (!current || depth < 2) return;
  const s = current.stack[depth - 1];
  if (current.stack.length >= depth) current.stack.length = depth - 1;
  if (s) advance(s.to);
  current.detail = "";
  scheduleRender();
}

function advance(value) {
  // never move backwards within one activity
  if (value > current.value) current.value = Math.min(1, value);
}

// Bridge for Python (backend/py/progress.py): Python's None arrives as undefined.
window.alignfixProgress = {
  push: (from, to, label) => pushStage(from, to, label),
  pop: (depth) => popStage(depth),
  report: (fraction, detail) => report(fraction, detail),
  yieldToUI: () => yieldToUI(),
};

// ------------------------------------------------------------------ rendering

const $ = (id) => document.getElementById(id);

function setBarState(state) {
  const bar = $("status-bar");
  if (bar) bar.dataset.state = state;
}

function showRunning() {
  setBarState("running");
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = setInterval(render, 1000);
  render();
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

function render() {
  if (!current) return;
  const percent = Math.floor(current.value * 100);
  const labels = current.stack.slice(1).map(s => s.label).filter(Boolean);
  const detail = [...labels, current.detail].filter(Boolean).join(" › ");
  setText("status-title", current.title);
  setText("status-detail", detail);
  setText("status-percent", `${percent}%`);
  setWidth(current.value);

  const seconds = elapsedSeconds();
  let time = formatDuration(seconds);
  // a rough estimate once the progress says something about the speed
  if (seconds >= 5 && current.value >= 0.05 && current.value < 1) {
    const remaining = seconds * (1 - current.value) / current.value;
    time += ` · ~${formatDuration(remaining)} left`;
  }
  setText("status-time", time);

  const progress = $("status-progress");
  if (progress) progress.setAttribute("aria-valuenow", String(percent));
  document.title = `${percent}% · ${current.title} · AlignFix`;
}

function finish(state, message, seconds) {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
  const value = state === "done" ? 1 : current.value;
  current = null;
  document.body.classList.remove("is-busy");
  window.removeEventListener("beforeunload", warnBeforeUnload);

  setBarState(state);
  setText("status-title", message);
  setText("status-detail", "");
  setText("status-percent", state === "done" ? "100%" : `${Math.floor(value * 100)}%`);
  setText("status-time", formatDuration(seconds));
  setWidth(value);
  document.title = "AlignFix";
  if (state === "failed" && window.AlignFixLog) window.AlignFixLog.open();
}

function setText(id, text) {
  const node = $(id);
  if (node && node.textContent !== text) node.textContent = text;
}

function setWidth(value) {
  const fill = $("status-fill");
  if (fill) fill.style.width = `${(value * 100).toFixed(1)}%`;
}

// ------------------------------------------------------------------ helpers

function warnBeforeUnload(event) {
  event.preventDefault();
  event.returnValue = "";   // shows the browser's "leave page?" dialog
}

function elapsedSeconds() {
  return current ? (performance.now() - current.startedAt) / 1000 : 0;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function errorMessage(err) {
  if (!err) return "Unknown error";
  if (err.name === "PythonError" && err.message) {
    // the last line of a traceback is the actual error
    const lines = err.message.trim().split("\n");
    return lines[lines.length - 1];
  }
  return err.message || String(err);
}

function firstLine(text) {
  return String(text).split("\n")[0];
}
