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
 * Review page: sentence pairs and words that look like translation errors
 * (backend/py/review.py, backend/py/issues.py). Summary on top, then either
 * the sentence pairs ranked by severity or the words that most often lack
 * their usual translation, with a detail pane explaining every issue.
 */

import { fetchReviewOverview, fetchWordExamples, downloadPhraseTable, markPairs, markAllPairs,
  downloadReview } from "../backend/js/review.js";
import { addGlossaryPairs, removeGlossaryTerm } from "../backend/js/glossary.js";
import { getProject } from "../backend/js/projects.js";
import { ignorePhrasePair } from "../backend/js/phrases.js";
import { runActivity, isBusy } from "./activity.js";
import { toast, showConfirm } from "./dialogs.js";
import { escapeHtml, reportError, formatCount } from "./utils.js";

const PAGE_SIZE = 20;
const LEVEL_LABELS = { high: "High", medium: "Medium", low: "Low" };

let state = null;   // per render

const pct = (x, digits = 0) => `${(100 * x).toFixed(digits)}%`;
const sideName = (side) => (side === "src" ? "source" : side === "tgt" ? "target" : "");

export async function renderReview(projectId, params = new URLSearchParams()) {
  const app = document.getElementById("app");
  state = {
    projectId,
    view: params.get("view") === "words" ? "words" : "sentences",
    search: params.get("q") || "",
    level: ["high", "medium", "low"].includes(params.get("level")) ? params.get("level") : "medium",
    kind: params.get("kind") || "",
    side: ["src", "tgt"].includes(params.get("side")) ? params.get("side") : "",
    status: ["open", "ok", "all"].includes(params.get("status")) ? params.get("status") : "open",
    start: 0,
    rows: [],
    selected: null,
    summary: null,
    requestId: 0,
  };

  renderSidebar();
  app.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Review</h1>
        <div class="text-muted small">Sentence pairs that look like translation errors: missing or added words,
          wrong numbers, pairs that do not belong together. Synonyms and paraphrases are not flagged.</div>
      </div>
      <div class="d-flex flex-wrap gap-2 align-items-center">
        <div class="btn-group" role="group" aria-label="Show">
          <input type="radio" class="btn-check" name="review-view" id="review-view-sentences" value="sentences" ${state.view === "sentences" ? "checked" : ""}>
          <label class="btn btn-outline-primary" for="review-view-sentences"><i class="fas fa-list me-1"></i>Sentences</label>
          <input type="radio" class="btn-check" name="review-view" id="review-view-words" value="words" ${state.view === "words" ? "checked" : ""}>
          <label class="btn btn-outline-primary" for="review-view-words"><i class="fas fa-font me-1"></i>Words</label>
        </div>
        <div class="dropdown">
          <button class="btn btn-secondary dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false">
            <i class="fas fa-file-export me-1"></i>Export
          </button>
          <ul class="dropdown-menu dropdown-menu-end">
            <li><h6 class="dropdown-header">This list, all pages, with the current filters</h6></li>
            <li><button class="dropdown-item review-export-btn" data-format="csv"><i class="fas fa-file-csv fa-fw me-1"></i>Review list (CSV)</button></li>
            <li><button class="dropdown-item review-export-btn" data-format="json"><i class="fas fa-file-code fa-fw me-1"></i>Review list (JSON)</button></li>
            <li><hr class="dropdown-divider"></li>
            <li><h6 class="dropdown-header">Phrase table: extracted phrase pairs per source phrase,<br>top translation, its share, alternatives</h6></li>
            <li><button class="dropdown-item export-btn" data-format="csv" data-part="all">All phrases (CSV)</button></li>
            <li><button class="dropdown-item export-btn" data-format="json" data-part="all">All phrases (JSON)</button></li>
            <li><hr class="dropdown-divider"></li>
            <li><button class="dropdown-item export-btn" data-format="csv" data-part="sure">Consistent: top share ≥ 75% (CSV)</button></li>
            <li><button class="dropdown-item export-btn" data-format="csv" data-part="dubious">Dubious: top share &lt; 75% (CSV)</button></li>
            <li><button class="dropdown-item export-btn" data-format="json" data-part="sure">Consistent (JSON)</button></li>
            <li><button class="dropdown-item export-btn" data-format="json" data-part="dubious">Dubious (JSON)</button></li>
          </ul>
        </div>
      </div>
    </div>

    <div class="row g-3 mb-3" id="review-summary">
      ${[1, 2, 3, 4].map(() => `<div class="col-6 col-xl-3"><div class="stat-card placeholder-glow"><span class="placeholder col-6"></span></div></div>`).join("")}
    </div>

    <div class="row g-3 mb-3">
      <div class="col-12 col-xl-7">
        <div class="card h-100">
          <div class="card-body">
            <h6 class="card-title mb-1">Issues by type</h6>
            <div class="small text-muted mb-2">Sentence pairs with at least one issue of the type; click a bar to filter</div>
            <div class="chart-box"><canvas id="chart-kinds" aria-label="Sentence pairs per issue type" role="img"></canvas></div>
          </div>
        </div>
      </div>
      <div class="col-12 col-xl-5">
        <div class="card h-100">
          <div class="card-body">
            <h6 class="card-title mb-1">Words most often without their translation</h6>
            <div class="small text-muted mb-2">Weighted by how surprising each case is</div>
            <ol class="top-words list-unstyled mb-0" id="review-top-words"></ol>
          </div>
        </div>
      </div>
    </div>

    <div class="row g-3">
      <div class="col-12 col-lg-7">
        <div class="card">
          <div class="card-header">
            <div class="d-flex flex-wrap gap-2 align-items-center">
              <div class="flex-grow-1" style="min-width: 11rem">
                <div class="input-group input-group-sm">
                  <span class="input-group-text"><i class="fas fa-search"></i></span>
                  <input type="search" class="form-control" id="review-search" placeholder="Word or text" value="${escapeHtml(state.search)}" aria-label="Search">
                </div>
              </div>
              <select class="form-select form-select-sm w-auto sentences-only" id="review-level" aria-label="Severity">
                <option value="high">High only</option>
                <option value="medium">High and medium</option>
                <option value="low">All</option>
              </select>
              <select class="form-select form-select-sm w-auto sentences-only" id="review-kind" aria-label="Issue type">
                <option value="">All types</option>
              </select>
              <select class="form-select form-select-sm w-auto" id="review-status" aria-label="Status">
                <option value="open">To review</option>
                <option value="ok">Marked OK</option>
                <option value="all">All</option>
              </select>
              <select class="form-select form-select-sm w-auto" id="review-side" aria-label="Side">
                <option value="">Both sides</option>
                <option value="src">Source</option>
                <option value="tgt">Target</option>
              </select>
            </div>
          </div>
          <div id="review-list" class="review-list" role="listbox" aria-label="Issues">
            <div class="text-center text-muted py-5"><span class="spinner-border spinner-border-sm me-2"></span>Checking the translations…</div>
          </div>
          <div class="card-footer d-flex flex-wrap gap-2 justify-content-between align-items-center small">
            <span class="text-muted" id="review-info"></span>
            <button class="btn btn-sm btn-outline-secondary ms-auto sentences-only" id="review-mark-all" type="button"
                    title="Mark every pair in this list (all pages) as checked and OK">
              <i class="fas fa-check-double me-1"></i>Mark all OK</button>
            <div class="btn-group btn-group-sm">
              <button class="btn btn-secondary" id="review-prev" aria-label="Previous page"><i class="fas fa-chevron-left"></i></button>
              <button class="btn btn-secondary" id="review-next" aria-label="Next page"><i class="fas fa-chevron-right"></i></button>
            </div>
          </div>
        </div>
      </div>
      <div class="col-12 col-lg-5">
        <div class="card review-detail" id="review-detail">
          <div class="card-body empty-state">
            <i class="fas fa-hand-pointer"></i>
            <p class="mb-0">Select an entry to see why it was flagged.</p>
          </div>
        </div>
      </div>
    </div>`;

  document.getElementById("review-level").value = state.level;
  document.getElementById("review-status").value = state.status;
  document.getElementById("review-side").value = state.side;
  bindControls();
  syncViewControls();
  await load({ first: true });
}

// ------------------------------------------------------------------ data

async function load({ first = false } = {}) {
  const id = ++state.requestId;
  const params = {
    project_id: state.projectId,
    view: state.view,
    start: state.start,
    length: PAGE_SIZE,
    search: state.search,
    min_level: state.level,
    kind: state.kind,
    side: state.side,
    status: state.status,
  };
  let result;
  try {
    // the first analysis of a project reads all sentences: show progress
    result = first && !isBusy()
      ? await runActivity("Checking translations", () => fetchReviewOverview(params),
          { done: r => `${formatCount(r.summary.checked)} sentence pairs checked: ${formatCount(r.summary.high)} high, ${formatCount(r.summary.medium)} medium` })
      : await fetchReviewOverview(params);
  } catch (err) {
    reportError(err);
    const list = document.getElementById("review-list");
    if (list) list.innerHTML = `<div class="text-center text-danger py-5">Could not check the translations (see the logs).</div>`;
    return;
  }
  if (id !== state.requestId || !document.getElementById("review-list")) return;  // outdated or page left

  state.rows = result.rows;
  state.summary = result.summary;
  renderSummary(result.summary);
  renderKinds(result.summary);
  renderTopWords(result.summary);
  renderList(result);
  const same = (a, b) => a && b && (state.view === "words" ? a.word === b.word && a.side === b.side : a.row_id === b.row_id);
  const keep = state.selected && state.rows.find(r => same(r, state.selected));
  const at = Number.isInteger(state.selectIndex) ? state.rows[Math.min(state.selectIndex, state.rows.length - 1)] : null;
  state.selectIndex = null;
  select(keep || at || state.rows[0] || null);
}

// shown filters, for the bridge calls
function currentFilters() {
  return { project_id: state.projectId, view: state.view, search: state.search, min_level: state.level,
           kind: state.kind, side: state.side, status: state.status };
}

/**
 * Mark the selected sentence pair OK (or remove the mark), or add the selected word to
 * the glossary with the given translations (ok = false: remove it); then go on with
 * the next entry.
 */
async function toggleOk(row, ok, translations = null) {
  if (!row) return;
  const index = state.rows.indexOf(row);
  const words = state.view === "words";
  let message;
  try {
    if (words && ok) {
      const tr = (translations || row.expected || []).filter(Boolean);
      if (!tr.length) { toast("Choose or type at least one translation.", "warning"); return; }
      await addGlossaryPairs(state.projectId, tr.map(t => (row.side === "src" ? [row.word, t] : [t, row.word])), "review");
      message = `“${row.word}” ↔ “${tr.join("”, “")}” added to the glossary.`;
      translations = tr;
    } else if (words) {
      await removeGlossaryTerm(state.projectId, row.side, row.word);
      message = `“${row.word}” removed from the glossary.`;
    } else {
      await markPairs(state.projectId, [row.row_id], ok);
      message = ok ? `Line ${formatCount(row.row_id + 1)} marked OK.` : `Line ${formatCount(row.row_id + 1)} is back in the list to review.`;
    }
  } catch (err) {
    reportError(err);
    return;
  }
  toast(message, "success", {
    action: { label: "Undo", onClick: () => toggleOk(row, !ok, translations) },
  });
  // the entry leaves this list unless it shows both: select the one after it
  if (state.status !== "all") {
    state.selected = null;
    state.selectIndex = Math.max(0, index);
  }
  await load();
  document.querySelector(`#review-list [data-index="${state.rows.indexOf(state.selected)}"]`)?.focus();
}

function syncViewControls() {
  document.querySelectorAll(".sentences-only").forEach(el => { el.hidden = state.view !== "sentences"; });
  const status = document.getElementById("review-status");
  if (status) status.options[1].text = state.view === "words" ? "In glossary" : "Marked OK";
  document.getElementById("review-search").placeholder = state.view === "words" ? "Word or translation" : "Word or text";
}

function bindControls() {
  let timer = null;
  const reload = () => { state.start = 0; load(); };
  document.getElementById("review-search").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.search = e.target.value; reload(); }, 250);
  });
  document.getElementById("review-level").addEventListener("change", (e) => { state.level = e.target.value; reload(); });
  document.getElementById("review-kind").addEventListener("change", (e) => { state.kind = e.target.value; reload(); });
  document.getElementById("review-side").addEventListener("change", (e) => { state.side = e.target.value; reload(); });
  document.getElementById("review-status").addEventListener("change", (e) => {
    state.status = e.target.value; state.selected = null; reload();
  });
  document.getElementById("review-mark-all").addEventListener("click", async () => {
    const n = state.status === "ok" ? 0 : state.filteredOpen;
    if (!n) { toast("No pair in this list is left to mark.", "info"); return; }
    const ok = await showConfirm(`Mark all ${formatCount(n)} sentence pairs in this list (all pages) as OK? ` +
      "They leave the list to review until their text changes.", "Mark all OK", { confirmLabel: "Mark all OK" });
    if (!ok) return;
    try {
      const done = await markAllPairs(currentFilters());
      toast(`${formatCount(done)} sentence pairs marked OK.`, "success");
      state.selected = null; state.start = 0;
      await load();
    } catch (err) {
      reportError(err);
    }
  });
  document.querySelectorAll(".review-export-btn").forEach(btn => btn.addEventListener("click", async () => {
    try {
      const project = await getProject(state.projectId).catch(() => null);
      const n = await downloadReview(currentFilters(), btn.dataset.format, project?.name);
      if (n) toast(`Exported ${formatCount(n)} ${state.view === "words" ? "words" : "sentence pairs"}.`, "success");
      else toast("The list is empty, so nothing was exported.", "info");
    } catch (err) {
      reportError(err);
    }
  }));
  document.querySelectorAll('input[name="review-view"]').forEach(input => input.addEventListener("change", (e) => {
    state.view = e.target.value; state.selected = null; syncViewControls(); reload();
  }));
  document.getElementById("review-prev").addEventListener("click", () => {
    state.start = Math.max(0, state.start - PAGE_SIZE); load();
  });
  document.getElementById("review-next").addEventListener("click", () => {
    state.start += PAGE_SIZE; load();
  });
  const list = document.getElementById("review-list");
  list.addEventListener("click", (e) => {
    const item = e.target.closest("[data-index]");
    if (item && !e.target.closest("a")) select(state.rows[Number(item.dataset.index)]);
  });
  list.addEventListener("keydown", (e) => {
    const item = e.target.closest("[data-index]");
    if (!item) return;
    const index = Number(item.dataset.index);
    let next = null;
    if (e.key === "ArrowDown") next = index + 1;
    else if (e.key === "ArrowUp") next = index - 1;
    else if (e.key === "Enter" || e.key === " ") { select(state.rows[index]); e.preventDefault(); return; }
    else if ((e.key === "o" || e.key === "O") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // o: mark OK (or, for an entry marked OK, put it back)
      const row = state.rows[index];
      e.preventDefault();
      toggleOk(row, !row.ok);
      return;
    }
    if (next !== null && state.rows[next]) {
      e.preventDefault();
      select(state.rows[next]);
      list.querySelector(`[data-index="${next}"]`)?.focus();
    }
  });
  document.getElementById("review-top-words").addEventListener("click", (e) => {
    const a = e.target.closest("[data-word]");
    if (!a) return;
    e.preventDefault();
    state.view = "words";
    document.getElementById("review-view-words").checked = true;
    state.search = a.dataset.word;
    state.side = a.dataset.side;
    document.getElementById("review-search").value = state.search;
    document.getElementById("review-side").value = state.side;
    state.selected = { word: a.dataset.word, side: a.dataset.side };
    syncViewControls();
    state.start = 0;
    load();
  });
  document.querySelectorAll(".export-btn").forEach(btn => btn.addEventListener("click", async () => {
    try {
      const n = await downloadPhraseTable(state.projectId, { format: btn.dataset.format, part: btn.dataset.part });
      if (n) toast(`Phrase table exported: ${formatCount(n)} source phrases.`, "success");
      else toast("No source phrase matches, so nothing was exported.", "info");
    } catch (err) {
      reportError(err);
    }
  }));
  document.getElementById("review-detail").addEventListener("click", onDetailClick);
  document.getElementById("review-detail").addEventListener("submit", onDetailSubmit);
}

// ------------------------------------------------------------------ rendering

function statCard(label, value, note, tone = "") {
  return `
    <div class="col-6 col-xl-3">
      <div class="stat-card ${tone}">
        <div class="stat-label">${escapeHtml(label)}</div>
        <div class="stat-value tabular">${escapeHtml(value)}</div>
        <div class="stat-note">${escapeHtml(note)}</div>
      </div>
    </div>`;
}

function renderSummary(s) {
  const share = (n) => (s.checked ? ` (${pct(n / s.checked, 1)})` : "");
  document.getElementById("review-summary").innerHTML = [
    statCard("High", formatCount(s.high), `likely errors${share(s.high)}`, s.high ? "stat-warning" : "stat-ok"),
    statCard("Medium", formatCount(s.medium), `worth a look${share(s.medium)}`),
    statCard("Checked", formatCount(s.checked), `sentence pairs; ${formatCount(s.low)} more with minor issues` +
      (s.ok ? `; ${formatCount(s.ok)} marked OK` : "")),
    statCard("Words", formatCount(s.words), "words that sometimes lack their usual translation" +
      (s.glossary_terms ? `; ${formatCount(s.glossary_terms)} in the glossary` : "")),
  ].join("");
}

let kindsChart = null;

function renderKinds(s) {
  const select = document.getElementById("review-kind");
  if (select && select.options.length === 1) {
    for (const [kind, label] of s.kinds) select.add(new Option(label[0].toUpperCase() + label.slice(1), kind));
    select.value = state.kind;
  }
  if (typeof Chart === "undefined") return;
  kindsChart?.destroy();
  const canvas = document.getElementById("chart-kinds");
  if (!canvas) return;
  const kinds = s.kinds;
  kindsChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: kinds.map(k => k[1]),
      datasets: [
        { label: "High", data: kinds.map(k => k[2]), backgroundColor: "#d9534f", borderRadius: 3 },
        { label: "Medium", data: kinds.map(k => k[3]), backgroundColor: "#f0a020", borderRadius: 3 },
      ],
    },
    options: {
      indexAxis: "y",
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 12 } },
        tooltip: { mode: "index", intersect: false },
      },
      scales: {
        x: { stacked: true, beginAtZero: true, title: { display: true, text: "Sentence pairs" }, ticks: { precision: 0 } },
        y: { stacked: true, grid: { display: false } },
      },
      onClick: (_, elements) => {
        if (!elements.length) return;
        state.kind = kinds[elements[0].index][0];
        document.getElementById("review-kind").value = state.kind;
        if (state.view !== "sentences") {
          state.view = "sentences";
          document.getElementById("review-view-sentences").checked = true;
          syncViewControls();
        }
        state.start = 0;
        load();
      },
    },
  });
}

function renderTopWords(s) {
  const list = document.getElementById("review-top-words");
  if (!list) return;
  if (!s.top_words.length) {
    list.innerHTML = `<li class="text-muted small">No word stands out.</li>`;
    return;
  }
  list.innerHTML = s.top_words.map(([side, word, count]) => `
    <li>
      <a href="#" data-side="${side}" data-word="${escapeHtml(word)}" class="d-flex justify-content-between align-items-center">
        <span><span class="side-badge side-${side}">${side === "src" ? "SRC" : "TGT"}</span> ${escapeHtml(word)}</span>
        <span class="text-muted tabular small">${formatCount(count)}×</span>
      </a>
    </li>`).join("");
}

function segmentsHtml(segments) {
  return segments.map(([text, flagged]) =>
    flagged ? `<mark class="issue-mark">${escapeHtml(text)}</mark>` : escapeHtml(text)).join("");
}

function levelBadge(level) {
  return `<span class="level-badge level-${level}">${LEVEL_LABELS[level] || ""}</span>`;
}

function renderList(result) {
  const list = document.getElementById("review-list");
  if (!result.rows.length) {
    const hint = state.status === "ok"
      ? (state.view === "words" ? " The glossary is empty, or nothing in it matches." : " Nothing is marked OK with these filters.")
      : state.view === "sentences" && state.level !== "low" ? " Choose “All” to include minor issues." : "";
    list.innerHTML = `<div class="empty-state"><i class="fas fa-circle-check"></i><p class="mb-0">Nothing found.${escapeHtml(hint)}</p></div>`;
  } else if (state.view === "sentences") {
    list.innerHTML = result.rows.map((r, i) => {
      const labels = [...new Set(r.issues.map(f => f.label))];
      return `
      <div class="review-item" data-index="${i}" tabindex="0" role="option">
        <div class="d-flex justify-content-between align-items-center mb-1">
          <span>${levelBadge(r.level)}${r.ok ? ` <span class="level-badge level-ok"><i class="fas fa-check me-1"></i>OK</span>` : ""}
            <span class="text-muted small ms-1">line ${formatCount(r.row_id + 1)}</span></span>
          <span class="text-muted small tabular" title="issue score">${r.score.toFixed(1)}</span>
        </div>
        <div class="review-text"><span class="side-badge side-src">SRC</span> ${segmentsHtml(r.src)}</div>
        <div class="review-text"><span class="side-badge side-tgt">TGT</span> ${segmentsHtml(r.tgt)}</div>
        <div class="review-chips">
          ${r.mismatch ? `<span class="chip chip-strong">sides may not belong together</span>` : ""}
          ${labels.map(l => `<span class="chip">${escapeHtml(l)}</span>`).join("")}
        </div>
      </div>`;
    }).join("");
  } else {
    list.innerHTML = `
      <table class="table table-hover align-middle mb-0 review-table">
        <thead><tr>
          <th scope="col">Word</th>
          <th scope="col" class="text-end" title="sentence pairs where none of its usual translations appears">Without translation</th>
          <th scope="col" class="text-end" title="share of its sentences where a usual translation appears">Usually translated</th>
          <th scope="col">Usual translations</th>
        </tr></thead>
        <tbody>${result.rows.map((w, i) => `
          <tr data-index="${i}" tabindex="0">
            <td class="fw-semibold"><span class="side-badge side-${w.side}">${w.side === "src" ? "SRC" : "TGT"}</span> ${escapeHtml(w.word)}${w.ok ? ` <span class="level-badge level-ok ms-1" title="in the glossary"><i class="fas fa-book me-1"></i>glossary</span>` : ""}</td>
            <td class="text-end tabular">${w.ok ? "–" : `${formatCount(w.flagged)} <span class="text-muted small">/ ${formatCount(w.sentences)}</span>`}</td>
            <td class="text-end tabular">${w.rate === null ? "–" : pct(w.rate)}</td>
            <td class="text-truncate" style="max-width: 14rem">${escapeHtml(w.expected.join(", "))}</td>
          </tr>`).join("")}</tbody>
      </table>`;
  }
  state.filteredOpen = state.view === "sentences" && state.status !== "ok" ? result.filtered : 0;
  const markAll = document.getElementById("review-mark-all");
  if (markAll) markAll.disabled = !state.filteredOpen;
  const end = Math.min(result.filtered, state.start + result.rows.length);
  const what = state.view === "words" ? "words" : "sentence pairs";
  document.getElementById("review-info").textContent = result.filtered
    ? `${formatCount(state.start + 1)}–${formatCount(end)} of ${formatCount(result.filtered)} ${what}`
    : `0 ${what}`;
  document.getElementById("review-prev").disabled = state.start === 0;
  document.getElementById("review-next").disabled = end >= result.filtered;
}

function phrasesLink(side, word) {
  const p = new URLSearchParams();
  p.set(side === "tgt" ? "tgt" : "src", word);
  return `#project-${state.projectId}?${p.toString()}`;
}

function markSelected(index) {
  document.querySelectorAll("#review-list [data-index]").forEach(el =>
    el.classList.toggle("active", Number(el.dataset.index) === index));
}

function select(row) {
  state.selected = row;
  const index = row ? state.rows.indexOf(row) : -1;
  markSelected(index);
  const pane = document.getElementById("review-detail");
  if (!pane) return;
  if (!row) {
    pane.innerHTML = `<div class="card-body empty-state"><i class="fas fa-hand-pointer"></i><p class="mb-0">Select an entry to see why it was flagged.</p></div>`;
    return;
  }
  if (state.view === "words") showWord(row, pane);
  else showSentence(row, pane);
}

function issueList(issues) {
  return `<ul class="list-unstyled issue-list mb-0">${issues.map(f => `
    <li>
      <i class="fas fa-circle-exclamation ${f.anomaly >= 2 ? "text-danger" : "text-warning"}"></i>
      <div>
        <div>${escapeHtml(f.text)}</div>
        ${f.word && (f.kind === "missing" || f.kind === "unexplained") ? `
          <a class="small" href="${escapeHtml(phrasesLink(f.side, f.word))}"><i class="fas fa-search me-1"></i>Sentences with “${escapeHtml(f.word)}”</a>` : ""}
      </div>
    </li>`).join("")}</ul>`;
}

function showSentence(row, pane) {
  pane.innerHTML = `
    <div class="card-header d-flex justify-content-between align-items-center">
      <h5 class="card-title mb-0">Line ${formatCount(row.row_id + 1)}</h5>
      <span>${row.ok ? `<span class="level-badge level-ok me-1"><i class="fas fa-check me-1"></i>OK</span>` : ""}${levelBadge(row.level)}</span>
    </div>
    <div class="card-body">
      ${okButtons(row, "pair")}
      <div class="panel-label">Source</div>
      <p class="review-text mb-3">${segmentsHtml(row.src)}</p>
      <div class="panel-label">Target</div>
      <p class="review-text mb-3">${segmentsHtml(row.tgt)}</p>
      ${row.mismatch ? `<div class="alert alert-warning small py-2"><i class="fas fa-link-slash me-2"></i>Most words have no counterpart:
        the two sides may not belong together, or one is a different text.</div>` : ""}
      <div class="panel-label">Why it was flagged</div>
      ${issueList(row.issues)}
    </div>`;
}

function okButtons(row, what) {
  if (what === "word") {
    return row.ok
      ? `<div class="ok-bar ok-bar-done mb-3"><span><i class="fas fa-book me-1"></i>In the glossary with <strong>${escapeHtml(row.expected.join(", "))}</strong>.</span>
           <button class="btn btn-sm btn-secondary ok-btn" data-ok="0" title="Remove it from the glossary (o)">
             <i class="fas fa-trash-can me-1"></i>Remove</button></div>`
      : `<form class="glossary-add mb-3" id="glossary-add">
           <div class="panel-label mb-1">Add to the glossary</div>
           <div class="small text-muted mb-2">Confirm the translations that are right. The word then leaves this list;
             a pair with “${escapeHtml(row.word)}” but none of them is flagged.</div>
           <div class="d-flex flex-wrap gap-2 mb-2">
             ${row.expected.map((t, i) => `
               <input type="checkbox" class="btn-check" id="gl-tr-${i}" value="${escapeHtml(t)}" checked autocomplete="off">
               <label class="btn btn-sm btn-outline-primary" for="gl-tr-${i}">${escapeHtml(t)}</label>`).join("")}
           </div>
           <div class="input-group input-group-sm">
             <input type="text" class="form-control" id="gl-tr-other" placeholder="Another translation (optional)"
                    aria-label="Another translation">
             <button class="btn btn-success" type="submit" title="Add the chosen translations to the glossary (o: all usual ones)">
               <i class="fas fa-book me-1"></i>Add to glossary</button>
           </div>
         </form>`;
  }
  return row.ok
    ? `<div class="ok-bar ok-bar-done mb-3"><span><i class="fas fa-circle-check me-1"></i>Marked OK: not in the list to review.</span>
         <button class="btn btn-sm btn-secondary ok-btn" data-ok="0" title="Put it back in the list to review (o)">
           <i class="fas fa-rotate-left me-1"></i>Undo</button></div>`
    : `<div class="ok-bar mb-3"><span class="small text-muted">${what === "pair" ? "Checked and the translation is fine?" : "Is this word fine as it is translated?"}</span>
         <button class="btn btn-sm btn-success ok-btn" data-ok="1" title="Remove it from the list to review (o)">
           <i class="fas fa-check me-1"></i>Mark OK</button></div>`;
}

async function showWord(row, pane) {
  const other = row.side === "src" ? "target" : "source";
  if (row.ok) {
    pane.innerHTML = `
      <div class="card-header d-flex justify-content-between align-items-center">
        <h5 class="card-title mb-0 text-break"><span class="side-badge side-${row.side}">${row.side === "src" ? "SRC" : "TGT"}</span> ${escapeHtml(row.word)}</h5>
        <span class="level-badge level-ok"><i class="fas fa-book me-1"></i>glossary</span>
      </div>
      <div class="card-body">
        ${okButtons(row, "word")}
        <p class="small mb-0">A confirmed translation counts as a usual translation, and a sentence pair with
          “${escapeHtml(row.word)}” but none of its confirmed translations on the other side is flagged.
          The whole glossary is on the <a href="#project-${state.projectId}">Phrases</a> page.</p>
      </div>`;
    return;
  }
  pane.innerHTML = `
    <div class="card-header d-flex justify-content-between align-items-center">
      <h5 class="card-title mb-0 text-break"><span class="side-badge side-${row.side}">${row.side === "src" ? "SRC" : "TGT"}</span> ${escapeHtml(row.word)}</h5>
      <span class="text-muted small tabular">${formatCount(row.flagged)} of ${formatCount(row.sentences)}</span>
    </div>
    <div class="card-body">
      ${okButtons(row, "word")}
      <p class="small mb-3">Usually ${row.expected.length ? `translated as <strong>${escapeHtml(row.expected.join(", "))}</strong>` : "translated"}:
        a usual translation appears on the ${other} side in <strong>${pct(row.rate)}</strong> of its sentence pairs.
        In the pairs below, none does: the word may be untranslated, mistranslated${row.side === "tgt" ? " or added" : ""}.</p>
      <div class="d-flex flex-wrap gap-2 mb-3">
        <a class="btn btn-primary btn-sm" href="${escapeHtml(phrasesLink(row.side, row.word))}"><i class="fas fa-search me-1"></i>All sentences</a>
        <button class="btn btn-secondary btn-sm hide-word-btn" title="Hide this word in the phrase table and in this review">
          <i class="fas fa-eye-slash me-1"></i>Hide word</button>
      </div>
      <div class="panel-label">Most severe cases</div>
      <div id="word-examples"><div class="text-muted small"><span class="spinner-border spinner-border-sm me-2"></span>Loading…</div></div>
    </div>`;
  try {
    const result = await fetchWordExamples(state.projectId, row.side, row.word);
    const box = document.getElementById("word-examples");
    if (!box || state.selected !== row) return;
    box.innerHTML = result.rows.length ? result.rows.map(r => `
      <div class="word-example">
        <div class="d-flex justify-content-between small text-muted mb-1">
          <span>${levelBadge(r.level)} line ${formatCount(r.row_id + 1)}</span>
          <span class="tabular">${r.score.toFixed(1)}</span>
        </div>
        <div class="review-text"><span class="side-badge side-src">SRC</span> ${segmentsHtml(r.src)}</div>
        <div class="review-text"><span class="side-badge side-tgt">TGT</span> ${segmentsHtml(r.tgt)}</div>
      </div>`).join("") : `<div class="text-muted small">No cases.</div>`;
  } catch (err) {
    reportError(err);
  }
}

function onDetailSubmit(e) {
  if (e.target.id !== "glossary-add") return;
  e.preventDefault();
  const chosen = [...e.target.querySelectorAll(".btn-check:checked")].map(el => el.value);
  const other = document.getElementById("gl-tr-other").value.trim();
  if (other) chosen.push(other);
  e.target.querySelector('button[type="submit"]').disabled = true;
  toggleOk(state.selected, true, chosen);
}

async function onDetailClick(e) {
  const row = state.selected;
  const okBtn = e.target.closest(".ok-btn");
  if (row && okBtn) {
    okBtn.disabled = true;
    await toggleOk(row, okBtn.dataset.ok === "1");
    return;
  }
  const btn = e.target.closest(".hide-word-btn");
  if (!row || !btn) return;
  btn.disabled = true;
  try {
    const [src, tgt] = row.side === "src" ? [row.word, ""] : ["", row.word];
    const added = await ignorePhrasePair(state.projectId, src, tgt);
    toast(added ? `“${row.word}” is hidden in the phrase table and the review.` : `“${row.word}” was already hidden.`, "success",
      { action: { label: "Phrases", href: `#project-${state.projectId}` } });
    state.selected = null;
    await load();
  } catch (err) {
    reportError(err);
  } finally {
    btn.disabled = false;
  }
}

function renderSidebar() {
  const sidebar = document.getElementById("sidebar-content");
  if (!sidebar) return;
  sidebar.innerHTML = `
    <h5><i class="fas fa-magnifying-glass-chart text-primary me-2"></i>Review</h5>
    <p>AlignFix learns from the alignments which translations each word usually has, and how often at
      least one of them appears on the other side. A pair is flagged when a word lacks all of them
      although it nearly always has one: that points to an omission, a mistranslation or an addition.</p>
    <p>Words translated in several valid ways are <strong>not</strong> flagged: synonyms count as usual
      translations, and words that are often paraphrased are expected to lack them.</p>
    <h6>Also checked</h6>
    <ul>
      <li>numbers on one side only,</li>
      <li>repetitions in the target,</li>
      <li>unusual length ratios,</li>
      <li>untranslated copies.</li>
    </ul>
    <h6>Severity</h6>
    <p><strong>High</strong> pairs are likely errors, <strong>medium</strong> ones worth a look. Fix them
      on the Phrases page (<em>Sentences with …</em> opens it with the word searched).</p>
    <p><strong>Words</strong> lists the words that most often lack their translation, with
      their worst cases. <strong>Hide word</strong> excludes a word here and in the phrase table.</p>
    <h6>Marking OK and the glossary</h6>
    <p><strong>Mark OK</strong> (or the <kbd>o</kbd> key in the list) takes a pair you checked out of the list
      to review; it comes back if its text changes. <em>Marked OK</em> in the status filter lists them.</p>
    <p>In <strong>Words</strong>, <strong>Add to glossary</strong> confirms a word with the translations you choose
      (<kbd>o</kbd>: all usual ones). It leaves the list, and from then on a pair with the word but none of its
      confirmed translations is flagged. Phrase pairs confirmed on the Phrases page are checked the same way.</p>
    <p class="mb-0"><strong>Export</strong> saves the list with the current filters, all pages, as CSV or JSON.</p>`;
}
