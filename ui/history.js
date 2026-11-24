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

import { getFixes } from "../backend/js/fixes.js";
import { escapeHtml, parseDbDate, formatCount } from "./utils.js";
import { downloadBlob, safeFilename } from "../backend/js/utils.js";
import { getProject } from "../backend/js/projects.js";

const TYPES = {
  fix: { label: "Fix", badge: "text-bg-primary", icon: "fa-pen" },
  augment: { label: "Augment", badge: "text-bg-success", icon: "fa-clone" },
  delete: { label: "Delete", badge: "text-bg-danger", icon: "fa-trash" },
};

const DIRECTION = { "0": "↔", "1": "→", "-1": "←" };

/** History page: the edits applied to a project, newest first. */
export async function renderHistory(projectId) {
  const app = document.getElementById('app') || document.body;
  renderSidebar();
  app.innerHTML = `<div class="text-center text-muted py-5"><span class="spinner-border spinner-border-sm me-2"></span>Loading…</div>`;

  let fixesHistory;
  try {
    fixesHistory = await getFixes(projectId);
  } catch (e) {
    app.innerHTML = `<div class="alert alert-danger">Failed to load history: ${escapeHtml(e.message)}</div>`;
    return;
  }
  const entries = [...fixesHistory].reverse();   // newest first
  const counts = entries.reduce((acc, e) => { const t = e.type || "fix"; acc[t] = (acc[t] || 0) + 1; return acc; }, {});

  app.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">History</h1>
        <div class="text-muted small">${entries.length
          ? Object.entries(counts).map(([t, n]) => `${formatCount(n)} ${(TYPES[t]?.label || t).toLowerCase()}${n === 1 ? "" : "s"}`).join(" · ")
          : "No edits applied yet"}</div>
      </div>
      ${entries.length ? `
      <div class="d-flex gap-2">
        <div class="input-group" style="width: 16rem">
          <span class="input-group-text"><i class="fas fa-search"></i></span>
          <input type="search" class="form-control" id="history-search" placeholder="Filter by phrase" aria-label="Filter by phrase">
        </div>
        <button class="btn btn-outline-secondary text-nowrap" id="history-download" title="The edits as JSON; it can be imported as pending edits on the Phrases page of another project">
          <i class="fas fa-download me-1"></i>Download</button>
      </div>` : ""}
    </div>
    ${entries.length ? `
    <div class="card">
      <div class="table-responsive">
        <table class="table align-middle mb-0 history-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Edit</th>
              <th scope="col">Original</th>
              <th scope="col">Changed to</th>
              <th scope="col" class="text-end">Sentences</th>
              <th scope="col" class="text-end">When</th>
            </tr>
          </thead>
          <tbody id="history-rows">${entries.map((e, i) => row(e, entries.length - i)).join("")}</tbody>
        </table>
      </div>
      <div class="card-footer small text-muted" id="history-info">${editCount(entries.length)}</div>
    </div>` : `
    <div class="card"><div class="card-body empty-state">
      <i class="fas fa-history"></i>
      <h5>Nothing applied yet</h5>
      <p class="mb-0">Edits added on the <a href="#project-${encodeURIComponent(projectId)}">Phrases</a> page are listed here once applied.</p>
    </div></div>`}
  `;

  if (!entries.length) return;

  document.getElementById("history-search").addEventListener("input", (ev) => {
    const needle = ev.target.value.trim().toLowerCase();
    let shown = 0;
    document.querySelectorAll("#history-rows tr").forEach(tr => {
      const match = !needle || tr.dataset.text.includes(needle);
      tr.hidden = !match;
      if (match) shown++;
    });
    document.getElementById("history-info").textContent = needle
      ? `${formatCount(shown)} of ${editCount(entries.length)}` : editCount(entries.length);
  });

  document.getElementById("history-download").addEventListener("click", async () => {
    const project = await getProject(projectId).catch(() => null);
    const data = fixesHistory.map(({ src_phrase, src_fix, tgt_phrase, tgt_fix, direction, percentage, type }) =>
      ({ src_phrase, src_fix, tgt_phrase, tgt_fix, direction, percentage, type }));
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      `${safeFilename(project?.name, `project_${projectId}`)}_edits.json`);
  });
}

const editCount = (n) => `${formatCount(n)} edit${n === 1 ? "" : "s"}`;

function pair(a, b, direction, cls = "") {
  return `<span class="phrase ${cls}">${escapeHtml(a || "")}</span>
    <span class="text-muted mx-1">${DIRECTION[String(direction)] || "↔"}</span>
    <span class="phrase ${cls}">${escapeHtml(b || "")}</span>`;
}

function row(entry, number) {
  const type = entry.type || "fix";
  const t = TYPES[type] || { label: type, badge: "text-bg-secondary", icon: "fa-pen" };
  const fix1 = entry.src_fix || entry.src_phrase;
  const fix2 = entry.tgt_fix || entry.tgt_phrase;
  const when = parseDbDate(entry.created_at);
  const changed = type === "delete"
    ? '<span class="text-muted fst-italic">sentences deleted</span>'
    : pair(fix1, fix2, entry.direction, "phrase-new");
  const share = type !== "delete" && entry.percentage != null && Number(entry.percentage) < 100
    ? ` <span class="badge text-bg-light" title="share of the occurrences changed">${escapeHtml(String(entry.percentage))}%</span>` : "";
  const text = [entry.src_phrase, entry.tgt_phrase, fix1, fix2].join(" ").toLowerCase();
  return `
    <tr data-text="${escapeHtml(text)}">
      <td class="text-muted tabular">${number}</td>
      <td><span class="badge ${t.badge}"><i class="fas ${t.icon} me-1"></i>${escapeHtml(t.label)}</span>${share}</td>
      <td>${pair(entry.src_phrase, entry.tgt_phrase, entry.direction)}</td>
      <td>${changed}</td>
      <td class="text-end tabular">${formatCount(entry.num_occurrences || 0)}</td>
      <td class="text-end small text-muted text-nowrap" title="${escapeHtml(when ? when.toLocaleString() : "")}">${escapeHtml(when ? when.toLocaleDateString() + " " + when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "–")}</td>
    </tr>`;
}

function renderSidebar() {
  const sidebar = document.getElementById("sidebar-content");
  if (!sidebar) return;
  sidebar.innerHTML = `
    <div class="p-3">
      <h5 class="mb-3"><i class="fas fa-history text-primary me-2"></i>History</h5>
      <p class="small">Every edit applied to this project, newest first:</p>
      <ul class="small">
        <li><strong>Fix</strong> replaces a phrase pair in the sentences that contain it
          (in the share of them given in %).</li>
        <li><strong>Augment</strong> adds copies of those sentences with the phrase pair replaced.</li>
        <li><strong>Delete</strong> removes the sentences containing the pair.</li>
      </ul>
      <p class="small mb-0"><strong>Download</strong> saves the edits as JSON. Importing that file on the
        Phrases page of another project queues the same edits there.</p>
    </div>`;
}
