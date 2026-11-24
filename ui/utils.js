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

/** Escape text for use in HTML content and attribute values. */
export function escapeHtml(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * Run an async handler on click: the button is disabled and shows a spinner
 * (with `text`, if not empty) until the handler finishes. Errors are shown as
 * a notification instead of being lost in the console.
 */
export function bindAsyncButton(btn, handler, text = "Processing...") {
  if (!btn) return;
  btn.addEventListener("click", async (e) => {
    if (btn.disabled) return;
    const oldHtml = btn.innerHTML;
    const width = btn.offsetWidth;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.innerHTML = `<span class="spinner-border spinner-border-sm" aria-hidden="true"></span>${text ? ` ${escapeHtml(text)}` : ""}`;
    if (!text && width) btn.style.minWidth = `${width}px`;  // keep the size of icon buttons
    try {
      // let the button repaint before the handler starts working
      await nextFrame();
      await handler(e);
    } catch (err) {
      await reportError(err);
    } finally {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      btn.innerHTML = oldHtml;
      btn.style.minWidth = "";
    }
  });
}

/** Show an error to the user (and log it unless the activity already did). */
export async function reportError(err) {
  const { toast } = await import("./dialogs.js");
  const { errorMessage } = await import("./activity.js");
  if (err && err.name === "BusyError") {
    toast(err.message, "warning");
    return;
  }
  if (!(err && err.alignfixLogged)) console.error(err);
  toast(errorMessage(err), "danger");
}

/**
 * Give the browser a chance to repaint before continuing. Also continues in
 * background tabs, where requestAnimationFrame does not run.
 */
export function nextFrame() {
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

/** Date of an SQLite CURRENT_TIMESTAMP value ("YYYY-MM-DD HH:MM:SS", UTC). */
export function parseDbDate(value) {
  if (!value) return null;
  const text = String(value);
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text) ? text.replace(" ", "T") + "Z" : text;
  const date = new Date(iso);
  return isNaN(date.getTime()) ? null : date;
}

/** "12,345" for numbers, "–" otherwise. */
export function formatCount(value) {
  const n = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(n) ? "–" : n.toLocaleString();
}
