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
 * Review page: how consistently each word is translated (backend/py/review.py).
 * Summary and charts on top, then a word table with a detail pane listing the
 * suspicious criteria and the variants, with links to the sentences and
 * buttons to hide a word or a pair.
 */

import { fetchWordOverview, downloadPhraseTable } from "../backend/js/review.js";
import { ignorePhrasePair } from "../backend/js/phrases.js";
import { runActivity, isBusy } from "./activity.js";
import { toast } from "./dialogs.js";
import { escapeHtml, reportError, formatCount } from "./utils.js";

const PAGE_SIZE = 25;
const charts = {};

let state = null;   // per render

const pct = (x, digits = 0) => `${(100 * x).toFixed(digits)}%`;

export async function renderReview(projectId, params = new URLSearchParams()) {
  const app = document.getElementById("app");
  state = {
    projectId,
    side: params.get("side") === "tgt" ? "tgt" : "src",
    sort: "suspicious",
    search: params.get("q") || "",
    suspiciousOnly: params.get("all") !== "1",
    minTotal: 1,
    start: 0,
    rows: [],
    selected: null,
    thresholds: null,
    requestId: 0,
  };

  renderSidebar();
  app.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Review</h1>
        <div class="text-muted small">How consistently each word is translated: words with many different
          or missing translations are worth a look.</div>
      </div>
      <div class="d-flex flex-wrap gap-2 align-items-center">
        <div class="btn-group" role="group" aria-label="Words of">
          <input type="radio" class="btn-check" name="review-side" id="review-side-src" value="src" ${state.side === "src" ? "checked" : ""}>
          <label class="btn btn-outline-primary" for="review-side-src">Source words</label>
          <input type="radio" class="btn-check" name="review-side" id="review-side-tgt" value="tgt" ${state.side === "tgt" ? "checked" : ""}>
          <label class="btn btn-outline-primary" for="review-side-tgt">Target words</label>
        </div>
        <div class="dropdown">
          <button class="btn btn-outline-secondary dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false">
            <i class="fas fa-file-export me-1"></i>Export phrase table
          </button>
          <ul class="dropdown-menu dropdown-menu-end">
            <li><h6 class="dropdown-header">Extracted phrase pairs per source phrase:<br>top translation, its share, alternatives</h6></li>
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
      <div class="col-12 col-xl-6">
        <div class="card h-100">
          <div class="card-body">
            <h6 class="card-title mb-1">Consistency of frequent words</h6>
            <div class="small text-muted mb-2" id="chart-consistency-note">Words with at least 10 occurrences</div>
            <div class="chart-box"><canvas id="chart-consistency" aria-label="Words per consistency range" role="img"></canvas></div>
          </div>
        </div>
      </div>
      <div class="col-12 col-xl-6">
        <div class="card h-100">
          <div class="card-body">
            <h6 class="card-title mb-1">Word frequency</h6>
            <div class="small text-muted mb-2">Words per number of occurrences</div>
            <div class="chart-box"><canvas id="chart-frequency" aria-label="Words per frequency range" role="img"></canvas></div>
          </div>
        </div>
      </div>
    </div>

    <div class="row g-3">
      <div class="col-12 col-lg-7">
        <div class="card">
          <div class="card-header">
            <div class="d-flex flex-wrap gap-2 align-items-center">
              <div class="flex-grow-1" style="min-width: 12rem">
                <div class="input-group input-group-sm">
                  <span class="input-group-text"><i class="fas fa-search"></i></span>
                  <input type="search" class="form-control" id="review-search" placeholder="Word or translation" value="${escapeHtml(state.search)}" aria-label="Search words">
                </div>
              </div>
              <div>
                <select class="form-select form-select-sm" id="review-sort" aria-label="Sort" style="width: auto">
                  <option value="suspicious">Most suspicious first</option>
                  <option value="consistency">Worst consistency first</option>
                  <option value="frequency">Most frequent first</option>
                  <option value="alpha">Alphabetical</option>
                </select>
              </div>
              <div>
                <div class="form-check form-switch mb-0 text-nowrap">
                  <input class="form-check-input" type="checkbox" role="switch" id="review-suspicious-only" ${state.suspiciousOnly ? "checked" : ""}>
                  <label class="form-check-label small" for="review-suspicious-only">Suspicious only</label>
                </div>
              </div>
            </div>
          </div>
          <div class="table-responsive">
            <table class="table table-hover align-middle mb-0 review-table">
              <thead>
                <tr>
                  <th scope="col">Word</th>
                  <th scope="col" class="text-end">Occ.</th>
                  <th scope="col" style="width: 28%">Consistency</th>
                  <th scope="col">Top translation</th>
                  <th scope="col" class="text-end" title="aligned variants">Var.</th>
                </tr>
              </thead>
              <tbody id="review-rows">
                <tr><td colspan="5" class="text-center text-muted py-4"><span class="spinner-border spinner-border-sm me-2"></span>Analysing the alignments…</td></tr>
              </tbody>
            </table>
          </div>
          <div class="card-footer d-flex justify-content-between align-items-center small">
            <span class="text-muted" id="review-info"></span>
            <div class="btn-group btn-group-sm">
              <button class="btn btn-outline-secondary" id="review-prev" aria-label="Previous page"><i class="fas fa-chevron-left"></i></button>
              <button class="btn btn-outline-secondary" id="review-next" aria-label="Next page"><i class="fas fa-chevron-right"></i></button>
            </div>
          </div>
        </div>
      </div>
      <div class="col-12 col-lg-5">
        <div class="card review-detail" id="review-detail">
          <div class="card-body empty-state">
            <i class="fas fa-hand-pointer"></i>
            <p class="mb-0">Select a word to see its translations.</p>
          </div>
        </div>
      </div>
    </div>`;

  document.getElementById("review-sort").value = state.sort;
  bindControls();
  await load({ first: true });
}

// ------------------------------------------------------------------ data

async function load({ first = false } = {}) {
  const id = ++state.requestId;
  const params = {
    project_id: state.projectId,
    side: state.side,
    start: state.start,
    length: PAGE_SIZE,
    search: state.search,
    sort: state.sort,
    suspicious_only: state.suspiciousOnly,
    min_total: state.minTotal,
  };
  let result;
  try {
    // the first analysis of a project reads all sentences: show progress
    result = first && !isBusy()
      ? await runActivity("Analysing word consistency", () => fetchWordOverview(params),
          { done: r => `${formatCount(r.summary.words)} words analysed, ${formatCount(r.summary.suspicious)} suspicious` })
      : await fetchWordOverview(params);
  } catch (err) {
    reportError(err);
    const body = document.getElementById("review-rows");
    if (body) body.innerHTML = `<tr><td colspan="5" class="text-center text-danger py-4">Could not analyse the words (see the logs).</td></tr>`;
    return;
  }
  if (id !== state.requestId || !document.getElementById("review-rows")) return;  // outdated or page left

  state.rows = result.rows;
  state.thresholds = result.summary.thresholds;
  renderSummary(result.summary);
  renderCharts(result.charts);
  renderRows(result);
  const keep = state.selected && state.rows.find(r => r.word === state.selected.word);
  selectWord(keep || state.rows[0] || null);
}

function bindControls() {
  let timer = null;
  document.getElementById("review-search").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.search = e.target.value; state.start = 0; load(); }, 250);
  });
  document.getElementById("review-sort").addEventListener("change", (e) => {
    state.sort = e.target.value; state.start = 0; load();
  });
  document.getElementById("review-suspicious-only").addEventListener("change", (e) => {
    state.suspiciousOnly = e.target.checked; state.start = 0; load();
  });
  document.querySelectorAll('input[name="review-side"]').forEach(input => input.addEventListener("change", (e) => {
    state.side = e.target.value; state.start = 0; state.selected = null; load({ first: true });
  }));
  document.getElementById("review-prev").addEventListener("click", () => {
    state.start = Math.max(0, state.start - PAGE_SIZE); load();
  });
  document.getElementById("review-next").addEventListener("click", () => {
    state.start += PAGE_SIZE; load();
  });
  document.getElementById("review-rows").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-index]");
    if (tr) selectWord(state.rows[Number(tr.dataset.index)]);
  });
  document.getElementById("review-rows").addEventListener("keydown", (e) => {
    const tr = e.target.closest("tr[data-index]");
    if (!tr) return;
    const index = Number(tr.dataset.index);
    let next = null;
    if (e.key === "ArrowDown") next = index + 1;
    else if (e.key === "ArrowUp") next = index - 1;
    else if (e.key === "Enter" || e.key === " ") { selectWord(state.rows[index]); e.preventDefault(); return; }
    if (next !== null && state.rows[next]) {
      e.preventDefault();
      selectWord(state.rows[next]);
      document.querySelector(`#review-rows tr[data-index="${next}"]`)?.focus();
    }
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
  const t = s.thresholds;
  const sideName = state.side === "src" ? "source" : "target";
  const reasons = Object.entries(s.reasons).map(([r, n]) => `${formatCount(n)} ${r}`).join(", ") || "none";
  document.getElementById("review-summary").innerHTML = [
    statCard(`Distinct ${sideName} words`, formatCount(s.words),
      `${formatCount(s.frequent)} occur ${t.min_total}+ times` + (s.hidden ? `, ${formatCount(s.hidden)} hidden` : "")),
    statCard("Suspicious", formatCount(s.suspicious),
      s.frequent ? `${pct(s.suspicious / s.frequent)} of frequent words: ${reasons}` : "no frequent words",
      s.suspicious ? "stat-warning" : "stat-ok"),
    statCard("Consistency", s.consistency == null ? "–" : pct(s.consistency, 1),
      "average share of the top translation (frequent words, by occurrences)"),
    statCard("Unaligned", s.occurrences ? pct(s.unaligned / s.occurrences, 1) : "–",
      `${formatCount(s.unaligned)} of ${formatCount(s.occurrences)} word occurrences`),
  ].join("");
}

function renderCharts(data) {
  if (typeof Chart === "undefined") return;
  const draw = (key, rows, xTitle) => {
    charts[key]?.destroy();
    const canvas = document.getElementById(`chart-${key}`);
    if (!canvas) return;
    charts[key] = new Chart(canvas, {
      type: "bar",
      data: {
        labels: rows.map(r => r[0]),
        datasets: [
          { label: "Suspicious", data: rows.map(r => r[2]), backgroundColor: "#f0a020", borderRadius: 3 },
          { label: "Other", data: rows.map(r => r[1] - r[2]), backgroundColor: "#8fb3e0", borderRadius: 3 },
        ],
      },
      options: {
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 12 } },
          tooltip: { mode: "index", intersect: false },
        },
        scales: {
          x: { stacked: true, title: { display: true, text: xTitle }, grid: { display: false } },
          y: { stacked: true, beginAtZero: true, title: { display: true, text: "Words" }, ticks: { precision: 0 } },
        },
      },
    });
  };
  draw("consistency", data.consistency, "Share of the top translation");
  draw("frequency", data.frequency, "Occurrences");
}

function consistencyBar(row) {
  const tone = row.consistency < state.thresholds.low_consistency ? "bg-warning" : "bg-success";
  return `
    <div class="d-flex align-items-center gap-2">
      <div class="progress flex-grow-1" style="height: 6px" aria-hidden="true">
        <div class="progress-bar ${tone}" style="width: ${(100 * row.consistency).toFixed(1)}%"></div>
      </div>
      <span class="tabular small" style="min-width: 3em">${pct(row.consistency)}</span>
    </div>`;
}

function variantLabel(v) {
  return v ? escapeHtml(v) : '<span class="text-muted fst-italic">unaligned</span>';
}

function renderRows(result) {
  const body = document.getElementById("review-rows");
  if (!result.rows.length) {
    const hint = state.suspiciousOnly ? " Switch off “Suspicious only” to see all words." : "";
    body.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-4">No words match.${escapeHtml(hint)}</td></tr>`;
  } else {
    body.innerHTML = result.rows.map((r, i) => `
      <tr data-index="${i}" tabindex="0" class="${state.selected?.word === r.word ? "table-active" : ""}">
        <td class="fw-semibold">${escapeHtml(r.word)}
          ${r.suspicious ? `<i class="fas fa-flag text-warning ms-1" title="${escapeHtml(r.reasons.join(", "))}"></i>` : ""}</td>
        <td class="text-end tabular">${formatCount(r.total)}</td>
        <td>${consistencyBar(r)}</td>
        <td class="text-truncate" style="max-width: 12rem">${variantLabel(r.top)}</td>
        <td class="text-end tabular">${r.num_variants}</td>
      </tr>`).join("");
  }
  const end = Math.min(result.filtered, state.start + result.rows.length);
  document.getElementById("review-info").textContent = result.filtered
    ? `${formatCount(state.start + 1)}–${formatCount(end)} of ${formatCount(result.filtered)} words` +
      (result.filtered !== result.total ? ` (${formatCount(result.total)} in total)` : "")
    : `0 of ${formatCount(result.total)} words`;
  document.getElementById("review-prev").disabled = state.start === 0;
  document.getElementById("review-next").disabled = end >= result.filtered;
}

function sentencesLink(word, variant) {
  const p = new URLSearchParams();
  if (state.side === "src") { p.set("src", word); if (variant) p.set("tgt", variant); }
  else { p.set("tgt", word); if (variant) p.set("src", variant); }
  return `#project-${state.projectId}?${p.toString()}`;
}

function selectWord(row) {
  state.selected = row;
  document.querySelectorAll("#review-rows tr[data-index]").forEach(tr =>
    tr.classList.toggle("table-active", row && state.rows[Number(tr.dataset.index)]?.word === row.word));
  const pane = document.getElementById("review-detail");
  if (!pane) return;
  if (!row) {
    pane.innerHTML = `<div class="card-body empty-state"><i class="fas fa-hand-pointer"></i><p class="mb-0">Select a word to see its translations.</p></div>`;
    return;
  }
  const t = state.thresholds;
  const frequent = row.total >= t.min_total;
  const criteria = [
    [row.consistency < t.low_consistency, `Consistency below ${pct(t.low_consistency)}`, pct(row.consistency, 1)],
    [row.num_variants >= t.many_variants, `${t.many_variants} or more aligned variants`, String(row.num_variants)],
    [row.unaligned_share >= t.high_unaligned, `${pct(t.high_unaligned)} or more unaligned`, pct(row.unaligned_share, 1)],
  ];
  const otherSide = state.side === "src" ? "target" : "source";
  const variants = row.variants.map(([v, c]) => `
    <li class="variant">
      <div class="d-flex justify-content-between align-items-baseline gap-2">
        <span class="text-break">${variantLabel(v)}</span>
        <span class="text-nowrap small tabular text-muted">${formatCount(c)} · ${pct(c / row.total, 1)}</span>
      </div>
      <div class="progress my-1" style="height: 4px" aria-hidden="true">
        <div class="progress-bar ${v ? "" : "bg-secondary"}" style="width: ${(100 * c / row.total).toFixed(1)}%"></div>
      </div>
      <div class="variant-actions">
        <a class="btn btn-link btn-sm p-0 me-3" href="${escapeHtml(sentencesLink(row.word, v))}"><i class="fas fa-search me-1"></i>Sentences</a>
        ${v ? `<button class="btn btn-link btn-sm p-0 text-secondary hide-pair-btn" data-variant="${escapeHtml(v)}"><i class="fas fa-eye-slash me-1"></i>Hide pair</button>` : ""}
      </div>
    </li>`).join("");

  pane.innerHTML = `
    <div class="card-header d-flex justify-content-between align-items-center">
      <h5 class="mb-0 text-break">${escapeHtml(row.word)}</h5>
      ${row.suspicious ? '<span class="badge text-bg-warning"><i class="fas fa-flag me-1"></i>suspicious</span>'
        : '<span class="badge text-bg-success">consistent</span>'}
    </div>
    <div class="card-body">
      <div class="d-flex flex-wrap gap-3 small text-muted mb-3">
        <span><strong class="text-body tabular">${formatCount(row.total)}</strong> occurrences</span>
        <span><strong class="text-body tabular">${pct(row.consistency, 1)}</strong> consistency</span>
        <span><strong class="text-body tabular">${row.entropy.toFixed(2)}</strong> bits entropy</span>
      </div>
      <h6 class="small text-uppercase text-muted">Suspicious criteria</h6>
      ${frequent ? `<ul class="list-unstyled criteria mb-3">${criteria.map(([met, label, value]) => `
        <li class="${met ? "met" : ""}"><i class="fas ${met ? "fa-circle-exclamation text-warning" : "fa-circle-check text-success"} me-2"></i>${escapeHtml(label)}
          <span class="text-muted">(${escapeHtml(value)})</span></li>`).join("")}</ul>`
        : `<p class="small text-muted">Too rare to judge (fewer than ${t.min_total} occurrences).</p>`}
      <h6 class="small text-uppercase text-muted">Aligned ${otherSide} words${row.variants.length < row.num_variants + (row.unaligned ? 1 : 0) ? ` (top ${row.variants.length})` : ""}</h6>
      <ul class="list-unstyled variants mb-3">${variants}</ul>
      <div class="d-flex flex-wrap gap-2">
        <a class="btn btn-primary btn-sm" href="${escapeHtml(sentencesLink(row.word, ""))}"><i class="fas fa-search me-1"></i>All sentences</a>
        <button class="btn btn-outline-secondary btn-sm hide-word-btn" title="Hide this word in the phrase table, whatever its translation">
          <i class="fas fa-eye-slash me-1"></i>Hide word</button>
      </div>
    </div>`;
}

async function onDetailClick(e) {
  const row = state.selected;
  if (!row) return;
  const pairBtn = e.target.closest(".hide-pair-btn");
  const wordBtn = e.target.closest(".hide-word-btn");
  if (!pairBtn && !wordBtn) return;
  const btn = pairBtn || wordBtn;
  btn.disabled = true;
  try {
    const variant = pairBtn ? pairBtn.dataset.variant : "";
    const [src, tgt] = state.side === "src" ? [row.word, variant] : [variant, row.word];
    const added = await ignorePhrasePair(state.projectId, src, tgt);
    const what = pairBtn ? `“${src} ↔ ${tgt}”` : `“${row.word}”`;
    toast(added ? `${what} is hidden in the phrase table.` : `${what} was already hidden.`, "success",
      { action: { label: "Phrases", href: `#project-${state.projectId}` } });
    if (wordBtn) { state.selected = null; await load(); }
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
    <div class="p-3">
      <h5 class="mb-3"><i class="fas fa-magnifying-glass-chart text-primary me-2"></i>Word review</h5>
      <p class="small">For every word, AlignFix looks at what each of its occurrences is aligned to.
        <strong>Consistency</strong> is the share of the most common translation among all occurrences
        (unaligned occurrences included).</p>
      <p class="small mb-1">A word with at least 10 occurrences is <strong>suspicious</strong> if</p>
      <ul class="small">
        <li>its consistency is below 75%,</li>
        <li>it has 4 or more different aligned translations, or</li>
        <li>20% or more of its occurrences are unaligned.</li>
      </ul>
      <p class="small">Inconsistent words can be legitimately ambiguous, but often point to wrong or
        missing translations. Use <em>Sentences</em> to inspect them and fix them on the Phrases page.</p>
      <p class="small mb-0"><strong>Hide</strong> removes a word (any translation) or a pair from the phrase
        table; the hidden list on the Phrases page can undo it.</p>
    </div>`;
}
