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

import { initPyodide } from "../pyodide.js";
import { computeAlignments, storeAlignments } from "../backend/js/aligner.js";
import { extractPhrases } from "../backend/js/phrases.js";
import { tokeniseLines, getLinesFromFiles } from "../backend/js/text.js";
import { importBinaryProject, updateProjectStats, deleteProject } from "../backend/js/projects.js";
import { getLinesStats } from "../backend/js/stats.js";
import { bindAsyncButton, escapeHtml, formatCount, parseDbDate } from "./utils.js";
import { runActivity, stage } from "./activity.js";
import { toast, showDeleteConfirm } from "./dialogs.js";
import { profiler } from "./profiler.js";

// Improve responsiveness: make touchstart/touchmove listeners passive by default
// when code calls addEventListener without options (patches third-party libs that don't set passive).
// This mitigates the "Added non-passive event listener" warning.
(function setDefaultPassiveForTouch() {
  if (typeof window === 'undefined' || !EventTarget || !EventTarget.prototype) return;
  try {
    const orig = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      if ((type === 'touchstart' || type === 'touchmove') && (options === undefined || (typeof options === 'object' && options.passive === undefined))) {
        // if options was boolean (useCapture), preserve that but we prefer an options object
        const opts = (typeof options === 'boolean') ? { capture: options, passive: true } : Object.assign({}, options, { passive: true });
        return orig.call(this, type, listener, opts);
      }
      return orig.call(this, type, listener, options);
    };
  } catch (e) {
    // no-op on older environments or if this is not allowed
  }
})();

// Documents loaded with "Load documents", waiting to be processed
let loadedDocuments = null;

// ------------------------------------------------------------------ projects

async function loadProjects(highlightId = null) {
  const container = document.getElementById("projects-table-container");
  if (!container) return;
  container.innerHTML = `
    <div class="d-flex justify-content-center align-items-center py-5 text-muted">
      <div class="spinner-border spinner-border-sm me-2" role="status"></div> Loading projects…
    </div>`;

  const pyodide = await initPyodide();
  const projects = await pyodide.runPythonAsync(`
      from projects import get_projects
      get_projects()
  `);
  const list = projects.toJs();
  projects.destroy();

  const countBadge = document.getElementById('projects-count');
  if (countBadge) countBadge.textContent = list.length;

  if (list.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-folder-open"></i>
        <h6>No projects yet</h6>
        <p class="mb-0">Create a project from two parallel text files above, or import an <code>.algf</code> project file.</p>
      </div>`;
    return;
  }

  container.innerHTML = `
    <div class="table-responsive">
      <table class="table table-hover align-middle mb-0 projects-table">
        <thead>
          <tr>
            <th class="ps-3">Name</th>
            <th>Created</th>
            <th class="text-end">Sentence pairs</th>
            <th class="text-end">Phrase pairs</th>
            <th class="text-end pe-3"><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>`;
  const tbody = container.querySelector('tbody');

  for (const [id, name, createdAt, statsJson] of list) {
    let stats = {};
    try { stats = statsJson ? JSON.parse(statsJson) : {}; } catch (e) { /* ignore broken stats */ }
    const created = parseDbDate(createdAt);
    const displayName = name || `Project ${id}`;

    const row = document.createElement('tr');
    row.className = 'project-row' + (String(id) === String(highlightId) ? ' table-success' : '');
    row.innerHTML = `
      <td class="ps-3">
        <a class="project-link fw-medium" href="#project-${id}">${escapeHtml(displayName)}</a>
        <div class="small text-muted">ID ${id}</div>
      </td>
      <td>
        ${created ? `<div>${created.toLocaleDateString()}</div>
          <div class="small text-muted">${created.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>` : '–'}
      </td>
      <td class="text-end tabular">${formatCount(stats.corpus_size)}</td>
      <td class="text-end tabular">${formatCount(stats.total_phrases_filtered)}</td>
      <td class="text-end pe-3 text-nowrap">
        <a href="#project-${id}" class="btn btn-sm btn-outline-primary">Open</a>
        <button class="btn btn-sm btn-outline-danger delete-project-btn" type="button"
                title="Delete project" aria-label="Delete ${escapeHtml(displayName)}">
          <i class="fas fa-trash"></i>
        </button>
      </td>`;

    row.addEventListener('click', (e) => {
      if (!e.target.closest('a, button')) window.location.hash = `project-${id}`;
    });

    bindAsyncButton(row.querySelector('.delete-project-btn'), async () => {
      const confirmed = await showDeleteConfirm(
        `Delete "${displayName}" with all its sentences, phrases and fixes?\n\nThis cannot be undone.`,
        'Delete project');
      if (!confirmed) return;
      await deleteProject(id);
      toast(`Deleted "${displayName}".`, 'success');
      await loadProjects();
    }, "");

    tbody.appendChild(row);
  }
}

// ------------------------------------------------------------------ new project

function defaultProjectName(srcName, tgtName) {
  const split = (name) => {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? [name.slice(0, dot), name.slice(dot + 1)] : [name, ''];
  };
  const [srcBase, srcExt] = split(srcName);
  const [tgtBase, tgtExt] = split(tgtName);
  // corpus.de + corpus.en → "corpus (de–en)"
  if (srcBase === tgtBase && srcExt && tgtExt) return `${srcBase} (${srcExt}–${tgtExt})`;
  return `${srcName} – ${tgtName}`;
}

function renderPreview(side, fileName, stats, colorClass) {
  return `
    <div class="col-md-6">
      <div class="d-flex align-items-center mb-2">
        <i class="fas fa-file-lines ${colorClass} me-2"></i>
        <strong>${side}</strong>
        <span class="ms-2 text-muted small text-truncate">${escapeHtml(fileName)}</span>
      </div>
      <div class="preview-stats small mb-2">
        <span>Ø ${stats.avg_length} characters</span>
        <span>Ø ${stats.avg_tokens} words</span>
      </div>
      <ol class="preview-sample">
        ${stats.sample.map(line => `<li>${escapeHtml(line)}</li>`).join('')}
      </ol>
    </div>`;
}

async function loadDocuments() {
  const sourceFile = document.getElementById("sourceFile").files[0];
  const targetFile = document.getElementById("targetFile").files[0];
  if (!sourceFile || !targetFile) {
    toast("Please select a source and a target file.", "warning");
    return;
  }

  const { src_lines, tgt_lines, total, skipped, skippedTotal } = await getLinesFromFiles(sourceFile, targetFile);
  if (src_lines.length === 0) {
    toast(total === 0 ? "The files are empty." : "None of the line pairs can be used (see the logs).", "warning");
    return;
  }

  loadedDocuments = { srcLinesRaw: src_lines, tgtLinesRaw: tgt_lines, sourceFileName: sourceFile.name, targetFileName: targetFile.name };

  const srcStats = getLinesStats(src_lines);
  const tgtStats = getLinesStats(tgt_lines);
  console.log(`📂 Loaded ${src_lines.length.toLocaleString()} sentence pairs from ${sourceFile.name} and ${targetFile.name}`);

  const skippedList = Object.values(skipped).filter(r => r.count > 0).map(r =>
    `<li>${formatCount(r.count)} with ${escapeHtml(r.label)} (line ${r.lines.join(', ')}${r.count > r.lines.length ? ', …' : ''})</li>`).join('');

  document.getElementById("stats-content").innerHTML = `
    <p class="mb-3">
      <strong>${formatCount(src_lines.length)}</strong> sentence pairs can be used${skippedTotal ? `,
      <strong>${formatCount(skippedTotal)}</strong> of ${formatCount(total)} line pairs are skipped:` : '.'}
    </p>
    ${skippedTotal ? `<ul class="small text-muted mb-3">${skippedList}</ul>` : ''}
    <div class="row g-3">
      ${renderPreview('Source', sourceFile.name, srcStats, 'text-primary')}
      ${renderPreview('Target', targetFile.name, tgtStats, 'text-success')}
    </div>`;

  const maxLinesInput = document.getElementById('max-lines-input');
  maxLinesInput.max = src_lines.length;
  maxLinesInput.value = src_lines.length;
  document.getElementById('project-name-input').value = defaultProjectName(sourceFile.name, targetFile.name);
  document.getElementById('new-project-step2').hidden = false;
  document.getElementById('new-project-step2').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function setupProject() {
  if (!loadedDocuments) {
    toast("Please load the documents first.", "warning");
    return;
  }
  const { srcLinesRaw, tgtLinesRaw } = loadedDocuments;

  const maxLines = parseInt(document.getElementById('max-lines-input').value, 10);
  if (isNaN(maxLines) || maxLines < 1 || maxLines > srcLinesRaw.length) {
    toast(`Please enter a number of sentence pairs between 1 and ${srcLinesRaw.length.toLocaleString()}.`, "warning");
    return;
  }
  const numCores = parseInt(document.getElementById('num-cores-input').value, 10);
  if (isNaN(numCores) || numCores < 1 || numCores > 32) {
    toast('Please enter a number of CPU cores between 1 and 32.', "warning");
    return;
  }
  const name = document.getElementById('project-name-input').value.trim() || defaultProjectName(
    loadedDocuments.sourceFileName, loadedDocuments.targetFileName);

  const srcLinesRawSliced = srcLinesRaw.slice(0, maxLines);
  const tgtLinesRawSliced = tgtLinesRaw.slice(0, maxLines);
  profiler.clear();

  // shares of the progress bar, roughly by the time each step takes
  const { projectId, extractStats } = await runActivity(`Creating "${name}"`, async () => {
    console.log(`📊 ${maxLines.toLocaleString()} sentence pairs, ${numCores} cores`);
    const srcLines = await stage(0, 0.03, "Tokenizing source",
      () => profiler.measureAsync('tokenize_src', () => tokeniseLines(srcLinesRawSliced)));
    const tgtLines = await stage(0.03, 0.06, "Tokenizing target",
      () => profiler.measureAsync('tokenize_tgt', () => tokeniseLines(tgtLinesRawSliced)));

    const alignments = await stage(0.06, 0.55, "Aligning words",
      () => profiler.measureAsync('compute_alignments', () => computeAlignments(srcLines, tgtLines, numCores)));

    const projectId = await stage(0.55, 0.62, "Saving sentences",
      () => storeAlignments(srcLines, tgtLines, alignments, Array(srcLines.length).fill(1), name));

    const extractStats = await stage(0.62, 0.99, "Extracting phrases",
      () => profiler.measureAsync('extract_phrases', () => extractPhrases(projectId, numCores)));

    await stage(0.99, 1, "Saving statistics", () =>
      updateProjectStats(projectId, { ...profiler.data, ...(extractStats || {}) }));
    return { projectId, extractStats };
  }, {
    done: ({ extractStats }) =>
      `Created "${name}": ${maxLines.toLocaleString()} sentence pairs, ${formatCount(extractStats?.total_phrases_filtered)} phrase pairs`,
  });

  toast(`Project "${name}" is ready (${formatCount(extractStats?.total_phrases_filtered)} phrase pairs).`, "success",
    { action: { label: "Open", href: `#project-${projectId}` }, delay: 10000 });

  // reset the form for the next project
  loadedDocuments = null;
  document.getElementById("load-documents-form").reset();
  document.getElementById('new-project-step2').hidden = true;
  await loadProjects(projectId);
}

async function importProject() {
  const file = document.getElementById('binaryFile').files[0];
  if (!file) return;
  const projectId = await runActivity(`Importing ${file.name}`, () => importBinaryProject(file),
    { done: () => `Imported ${file.name}` });
  document.getElementById('binaryFile').value = '';
  toast(`Imported ${file.name}.`, "success", { action: { label: "Open", href: `#project-${projectId}` } });
  await loadProjects(projectId);
}

// ------------------------------------------------------------------ page

export async function renderHome(container) {
  const cores = Math.min(navigator.hardwareConcurrency || 4, 32);
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Projects</h1>
    </div>

    <section class="card mb-4" aria-labelledby="new-project-title">
      <div class="card-header">
        <h2 class="card-title h6 mb-0" id="new-project-title"><i class="fas fa-plus me-2"></i>New project</h2>
      </div>
      <div class="card-body">
        <form id="load-documents-form">
          <p class="text-muted small">Two plain-text files with one sentence per line: line <em>n</em> of the
            target file is the translation of line <em>n</em> of the source file.</p>
          <div class="row g-3 align-items-end">
            <div class="col-md-5">
              <label class="form-label" for="sourceFile">Source file</label>
              <input type="file" class="form-control" id="sourceFile" accept=".txt,text/plain,*" required />
            </div>
            <div class="col-md-5">
              <label class="form-label" for="targetFile">Target file</label>
              <input type="file" class="form-control" id="targetFile" accept=".txt,text/plain,*" required />
            </div>
            <div class="col-md-2 d-grid">
              <button type="button" id="button-load-documents" class="btn btn-outline-primary">
                <i class="fas fa-eye me-1"></i>Preview
              </button>
            </div>
          </div>
        </form>

        <div id="new-project-step2" hidden>
          <hr>
          <div id="stats-content"></div>
          <hr>
          <div class="row g-3">
            <div class="col-lg-6">
              <label for="project-name-input" class="form-label">Project name</label>
              <input type="text" class="form-control" id="project-name-input" maxlength="200" />
            </div>
            <div class="col-sm-4 col-lg-2">
              <label for="max-lines-input" class="form-label">Sentence pairs</label>
              <input type="number" class="form-control" id="max-lines-input" min="1" step="1" />
              <div class="form-text">Use the first <em>n</em> pairs</div>
            </div>
            <div class="col-sm-4 col-lg-2">
              <label for="limit-num-phrases-input" class="form-label">Max. phrase pairs</label>
              <input type="number" class="form-control" id="limit-num-phrases-input" min="1000" step="100000" value="1000000" />
              <div class="form-text">Rarest are dropped</div>
            </div>
            <div class="col-sm-4 col-lg-2">
              <label for="num-cores-input" class="form-label">CPU cores</label>
              <input type="number" class="form-control" id="num-cores-input" min="1" max="32" step="1" value="${cores}" />
              <div class="form-text">Parallel workers</div>
            </div>
          </div>
          <div class="mt-3 d-flex gap-2 align-items-center">
            <button type="button" id="button-setup-project" class="btn btn-primary">
              <i class="fas fa-play me-2"></i>Create project
            </button>
            <span class="small text-muted">Aligns the words of all sentence pairs and extracts phrase pairs;
              this can take a few minutes for large corpora.</span>
          </div>
        </div>
      </div>
    </section>

    <section class="card" aria-labelledby="projects-title">
      <div class="card-header d-flex justify-content-between align-items-center">
        <h2 class="card-title h6 mb-0" id="projects-title">
          <i class="fas fa-folder-open me-2"></i>Your projects
          <span class="badge text-bg-secondary ms-1" id="projects-count">0</span>
        </h2>
        <div>
          <input type="file" id="binaryFile" accept=".algf" hidden />
          <button type="button" id="import-binary-button" class="btn btn-sm btn-outline-secondary">
            <i class="fas fa-file-import me-1"></i>Import .algf
          </button>
        </div>
      </div>
      <div class="card-body p-0">
        <div id="projects-table-container"></div>
      </div>
      <div class="card-footer small text-muted">
        <i class="fas fa-lock me-1"></i>Projects are stored in this browser only. Export a project
        (Stats → Download Project) to keep a copy or move it to another browser.
      </div>
    </section>
  `;

  const sidebar = document.getElementById('sidebar-content');
  if (sidebar) {
    sidebar.innerHTML = `
      <h4>Welcome to AlignFix</h4>
      <p class="text-muted">AlignFix helps you find and fix errors in bilingual text corpora using word alignments.</p>
      <hr/>
      <h5>How it works</h5>
      <ol class="ps-3">
        <li><strong>Load</strong> a source and a target file and check the preview.</li>
        <li><strong>Create</strong> the project: AlignFix aligns the words and extracts phrase pairs.</li>
        <li><strong>Review</strong> unusual phrase pairs and low-scoring sentences.</li>
        <li><strong>Fix</strong> them across the corpus and download the result.</li>
      </ol>
      <hr/>
      <div class="small">
        <a href="https://github.com/alignfix/alignfix" target="_blank" rel="noopener">
          <i class="fab fa-github me-1"></i>View on GitHub
        </a>
        &nbsp;·&nbsp;
        <a href="#about">About</a>
      </div>
    `;
  }

  bindAsyncButton(document.getElementById("button-load-documents"), loadDocuments, "Loading…");
  bindAsyncButton(document.getElementById("button-setup-project"), setupProject, "Creating…");

  // load the preview as soon as both files are chosen
  for (const id of ["sourceFile", "targetFile"]) {
    document.getElementById(id).addEventListener("change", () => {
      document.getElementById('new-project-step2').hidden = true;
      loadedDocuments = null;
      const src = document.getElementById("sourceFile").files.length;
      const tgt = document.getElementById("targetFile").files.length;
      if (src && tgt) document.getElementById("button-load-documents").click();
    });
  }

  const importInput = document.getElementById('binaryFile');
  document.getElementById('import-binary-button').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', () => {
    if (!importInput.files.length) return;
    importProject().catch(async (err) => {
      const { reportError } = await import("./utils.js");
      reportError(err);
      importInput.value = '';
    });
  });

  await loadProjects();
}
