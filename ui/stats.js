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

import { getProject } from "../backend/js/projects.js";
import { countFixes } from "../backend/js/fixes.js";
import { downloadBinaryProject } from "../backend/js/projects.js";
import { bindAsyncButton, escapeHtml, parseDbDate } from "./utils.js";
import { downloadBlob, safeFilename } from "../backend/js/utils.js";

const isNum = (n) => n !== null && n !== undefined && n !== "" && Number.isFinite(Number(n));
const fmtCount = (n) => (isNum(n) ? Number(n).toLocaleString() : "–");
const fmtNumber = (n, digits = 1) => (isNum(n)
  ? Number(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "–");
const fmtSeconds = (s) => {
  if (!isNum(s)) return "–";
  s = Number(s);
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
};
const fmtMB = (bytes, signed = false) => {
  if (!isNum(bytes)) return "–";
  const mb = Number(bytes) / 1024 / 1024;
  return `${signed && mb > 0 ? "+" : ""}${mb.toFixed(1)} MB`;
};

// steps of the last run, in order
const STEPS = [
  ["tokenize_src", "Tokenizing the source"],
  ["tokenize_tgt", "Tokenizing the target"],
  ["compute_alignments", "Aligning words"],
  ["extract_phrases", "Extracting phrase pairs"],
];

function parseStats(raw) {
  if (raw && typeof raw === "string") {
    try { return JSON.parse(raw); } catch (e) { console.error("Failed to parse project stats JSON:", e); }
    return {};
  }
  return raw || {};
}

function statCard(label, value, note, extra = "") {
  return `
    <div class="col-6 col-xl-3">
      <div class="stat-card ${extra}">
        <div class="stat-label">${label}</div>
        <div class="stat-value">${escapeHtml(value)}</div>
        <div class="stat-note">${note}</div>
      </div>
    </div>`;
}

function corpusTable(src, tgt) {
  const rows = [
    ["Average length", "words", src.avg_tokens, tgt.avg_tokens, 1, true],
    ["Longest sentence", "words", src.max_tokens, tgt.max_tokens, 0, false],
    ["Average length", "characters", src.avg_length, tgt.avg_length, 1, true],
    ["Longest sentence", "characters", src.longest, tgt.longest, 0, false],
    ["Shortest sentence", "characters", src.shortest, tgt.shortest, 0, false],
  ];
  return `
    <table class="table table-sm align-middle mb-0 corpus-table">
      <thead>
        <tr>
          <th></th>
          <th class="text-end"><span class="side-badge side-src">SRC</span> Source</th>
          <th class="text-end"><span class="side-badge side-tgt">TGT</span> Target</th>
          <th class="text-end" title="Target divided by source">Ratio</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(([label, unit, a, b, digits, ratio]) => `
          <tr>
            <td>${label} <span class="text-muted small">${unit}</span></td>
            <td class="text-end tabular">${fmtNumber(a, digits)}</td>
            <td class="text-end tabular">${fmtNumber(b, digits)}</td>
            <td class="text-end tabular text-muted">${ratio && isNum(a) && isNum(b) && Number(a) > 0 ? (Number(b) / Number(a)).toFixed(2) : ""}</td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

function settingsList(project, stats) {
  const range = (a, b) => (isNum(a) && isNum(b) ? `${fmtCount(a)}–${fmtCount(b)}` : "–");
  const items = [
    ["Phrase length", `${range(project.min_phrase_len, project.max_phrase_len)} words`],
    ["Occurrences", range(project.min_count, project.max_count)],
    ["Score threshold", isNum(project.threshold) ? String(project.threshold) : "–"],
    ["Max. phrase pairs", fmtCount(project.max_phrases)],
    ["Phrase pairs extracted", fmtCount(stats.total_phrases_extracted)],
    ["Extraction took", fmtSeconds(stats.extraction_duration_seconds)],
  ];
  return `
    <dl class="settings-list mb-0">
      ${items.map(([k, v]) => `<div><dt>${k}</dt><dd class="tabular">${escapeHtml(v)}</dd></div>`).join("")}
    </dl>`;
}

function performanceTable(stats) {
  const steps = STEPS.map(([key, label]) => {
    const e = stats[key] && stats[key][0];
    return e ? { label, seconds: Number(e.cpu_ms || 0) / 1000, mem: e.mem_bytes, heap: e.endMemUsed }
             : { label, seconds: null };
  });
  if (isNum(stats.db_delete_duration_seconds)) steps.push({ label: "Deleting old phrase pairs", seconds: Number(stats.db_delete_duration_seconds) });
  if (isNum(stats.db_insert_duration_seconds)) steps.push({ label: "Saving phrase pairs", seconds: Number(stats.db_insert_duration_seconds) });

  const measured = steps.filter(s => s.seconds !== null);
  if (!measured.length) {
    return `<div class="empty-state py-4"><i class="fas fa-gauge-high"></i>No measurements yet. They are taken when the
      project is created and when phrases are extracted again.</div>`;
  }
  const total = measured.reduce((t, s) => t + s.seconds, 0);
  const longest = Math.max(...measured.map(s => s.seconds)) || 1;
  const memTotal = measured.reduce((t, s) => t + (isNum(s.mem) ? Number(s.mem) : 0), 0);

  return `
    <div class="table-responsive">
      <table class="table table-sm align-middle mb-0 perf-table">
        <thead>
          <tr>
            <th>Step</th>
            <th class="text-end">Time</th>
            <th class="perf-bar-col"><span class="visually-hidden">Share of the time</span></th>
            <th class="text-end" title="Change of the WebAssembly memory during the step">Memory Δ</th>
            <th class="text-end" title="Memory in use after the step">Memory after</th>
          </tr>
        </thead>
        <tbody>
          ${steps.map(s => s.seconds === null ? `
            <tr class="text-muted">
              <td>${s.label}</td>
              <td colspan="4" class="small">not measured</td>
            </tr>` : `
            <tr>
              <td>${s.label}</td>
              <td class="text-end tabular">${fmtSeconds(s.seconds)}</td>
              <td class="perf-bar-col">
                <div class="perf-bar" title="${Math.round(100 * s.seconds / (total || 1))}% of the time">
                  <span style="width: ${(100 * s.seconds / longest).toFixed(1)}%"></span>
                </div>
              </td>
              <td class="text-end tabular">${fmtMB(s.mem, true)}</td>
              <td class="text-end tabular">${fmtMB(s.heap)}</td>
            </tr>`).join("")}
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <td class="text-end tabular">${fmtSeconds(total)}</td>
            <td class="perf-bar-col"></td>
            <td class="text-end tabular">${fmtMB(memTotal, true)}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>`;
}

export async function renderStats(projectId) {
  const app = document.getElementById('app') || document.body;
  app.innerHTML = `<div class="empty-state"><span class="spinner-border spinner-border-sm me-2"></span>Loading…</div>`;

  let project;
  let numFixes;
  try {
    project = await getProject(projectId);
    numFixes = await countFixes(projectId);
  } catch (e) {
    app.innerHTML = `<div class="alert alert-danger">Failed to load stats: ${escapeHtml(e.message)}</div>`;
    return;
  }

  const stats = parseStats(project.stats);
  const src = stats.src_stats && typeof stats.src_stats === "object" ? stats.src_stats : {};
  const tgt = stats.tgt_stats && typeof stats.tgt_stats === "object" ? stats.tgt_stats : {};
  const name = project.name || `Project ${projectId}`;
  const createdDate = parseDbDate(project.created_at || stats.created_at);
  const created = createdDate ? createdDate.toLocaleString() : '–';
  const shownShare = isNum(stats.total_phrases_extracted) && Number(stats.total_phrases_extracted) > 0 && isNum(stats.total_phrases_filtered)
    ? ` (${Math.round(100 * stats.total_phrases_filtered / stats.total_phrases_extracted)}%)` : "";

  app.innerHTML = `
    <div class="stats-page">
      <div class="page-header">
        <div>
          <h1 class="page-title">Stats</h1>
          <div class="text-muted small">Created ${escapeHtml(created)}</div>
        </div>
        <div class="d-flex flex-wrap gap-2">
          <button id="download-binary" class="btn btn-primary" title="Export the whole project as an .algf file (can be imported again)">
            <i class="fas fa-file-archive me-1"></i> Download project</button>
          <button id="download-stats" class="btn btn-outline-secondary" title="These statistics as JSON">
            <i class="fas fa-chart-line me-1"></i> Download statistics</button>
        </div>
      </div>

      <div class="row g-3 mb-3">
        ${statCard("Sentence pairs", fmtCount(stats.corpus_size), "when the phrases were last extracted")}
        ${statCard("Phrase pairs", fmtCount(stats.total_phrases_filtered), `shown, of ${fmtCount(stats.total_phrases_extracted)} extracted${shownShare}`)}
        ${statCard("Hidden phrase pairs", fmtCount(stats.total_ignored_phrases), "by you or the hide list")}
        ${statCard("Edits applied", fmtCount(numFixes), `<a href="#history-${encodeURIComponent(projectId)}">see History</a>`)}
      </div>

      <div class="row g-3 mb-3">
        <div class="col-12 col-lg-7">
          <div class="card h-100">
            <div class="card-header"><h5 class="card-title mb-0"><i class="fas fa-align-left me-2"></i>Corpus</h5></div>
            <div class="card-body">${corpusTable(src, tgt)}</div>
          </div>
        </div>
        <div class="col-12 col-lg-5">
          <div class="card h-100">
            <div class="card-header"><h5 class="card-title mb-0"><i class="fas fa-sliders me-2"></i>Phrase extraction</h5></div>
            <div class="card-body">${settingsList(project, stats)}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><h5 class="card-title mb-0"><i class="fas fa-gauge-high me-2"></i>Performance of the last run</h5></div>
        <div class="card-body">
          ${performanceTable(stats)}
          <p class="form-text mb-0 mt-3"><i class="fas fa-circle-info me-1"></i>Measured in this browser when the project
            was created or the phrases were extracted again.</p>
        </div>
      </div>
    </div>
  `;

  const sidebar = document.getElementById('sidebar-content');
  if (sidebar) {
    sidebar.innerHTML = `
      <h5><i class="fas fa-chart-simple text-primary me-2"></i>Stats</h5>
      <p>An overview of <strong>${escapeHtml(name)}</strong>: its size, the phrase extraction settings, and how long
        each processing step took.</p>
      <h6>Corpus</h6>
      <p>Sentence lengths of both sides. The <em>ratio</em> is target divided by source: values far from what is
        usual for the language pair point to untranslated or truncated text.</p>
      <h6>Phrase pairs</h6>
      <p>Pairs outside the length and occurrence limits are dropped; hidden pairs stay out of the phrase table.
        Change the limits on the <a href="#project-${encodeURIComponent(projectId)}">Phrases</a> page.</p>
      <h6>Downloads</h6>
      <p><strong>Download project</strong> saves everything as an <code>.algf</code> file you can import again;
        <strong>Download statistics</strong> saves these numbers as JSON.</p>
    `;
  }

  bindAsyncButton(
    document.getElementById('download-binary'),
    async () => { await downloadBinaryProject(projectId); },
    'Preparing download...'
  );

  document.getElementById('download-stats').addEventListener('click', () => {
    const dataStr = JSON.stringify({ id: projectId, name, stats, created_at: created, edits_applied: numFixes }, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    downloadBlob(blob, `${safeFilename(name, 'project_' + projectId)}_stats.json`);
  });
}
