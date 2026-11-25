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

import { extractPhrases, fetchPhrases, fetchIgnoredPhrases, setIgnorePhrase, importIgnoredFromFile, downloadIgnoredPhrases, downloadPhrases, deleteAllIgnoredPhrases } from "../backend/js/phrases.js";
import { fetchTranslations, storeTranslation, deleteTranslation, deleteTranslationsByPhrasePair } from "../backend/js/alignments.js";
import { applyFixes } from "../backend/js/fixes.js";
import { getProject, saveProject, downloadProject, mergeProjectStats } from "../backend/js/projects.js";
import { recomputeAlignments } from "../backend/js/aligner.js";
import { fetchGlossary, addPhraseToGlossary, addGlossaryPairs, removeGlossaryEntry, clearGlossary,
  importGlossaryFile, downloadGlossary } from "../backend/js/glossary.js";
import { bindAsyncButton, escapeHtml, reportError, formatCount } from "./utils.js";
import { profiler } from "./profiler.js";
import { runActivity, stage } from "./activity.js";
import { showAlert, showDeleteConfirm, toast } from "./dialogs.js";

// Pending (not yet applied) fixes of the open project. They are kept while
// switching between the pages of a project and dropped when another project
// is opened, so they can never be applied to the wrong project.
let fixes = [];
let fixesProjectId = null;

function getDirectionSymbol(direction) {
  switch (String(direction)) {
    case '1':
      return '→';
    case '-1':
      return '←';
    default:
      return '↔';
  }
}

function escapeForHtmlAttr(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '\\n');
}

const TEXT_SIZE_KEY = 'alignfix-text-size';

function getTextSize() {
  let pct = 100;
  try { pct = Number(localStorage.getItem(TEXT_SIZE_KEY)) || 100; } catch (e) { /* private mode */ }
  return Math.min(200, Math.max(80, pct));
}

/** Ask for the sizes of dev and test, then download the corpus with the split. */
async function openSplitDialog(id) {
  const project = await getProject(id).catch(() => null);
  let pairs = 0;
  try { pairs = Number((typeof project.stats === "string" ? JSON.parse(project.stats) : project.stats)?.corpus_size) || 0; } catch (e) { /* unknown */ }
  const suggested = pairs ? Math.max(1, Math.min(2000, Math.round(pairs * 0.05))) : 1000;
  document.getElementById("split-modal")?.remove();
  document.body.insertAdjacentHTML("beforeend", `
    <div class="modal fade" id="split-modal" tabindex="-1" aria-labelledby="split-modal-title" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered">
        <form class="modal-content" id="split-form" novalidate>
          <div class="modal-header">
            <h5 class="modal-title" id="split-modal-title"><i class="fas fa-scissors me-2 text-primary"></i>Download with a split</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body">
            <p class="small text-muted">The zip gets <code>split/train</code>, <code>dev</code> and <code>test</code> files besides the
              usual ones. Pairs that share a source or a target sentence always go to the same part, so no sentence
              is in two parts (case, spacing and punctuation are ignored when comparing).</p>
            <div class="row g-3">
              <div class="col-4">
                <label class="form-label" for="split-dev">Dev pairs</label>
                <input type="number" class="form-control" id="split-dev" min="0" step="1" value="${suggested}" required>
              </div>
              <div class="col-4">
                <label class="form-label" for="split-test">Test pairs</label>
                <input type="number" class="form-control" id="split-test" min="0" step="1" value="${suggested}" required>
              </div>
              <div class="col-4">
                <label class="form-label" for="split-seed">Seed</label>
                <input type="number" class="form-control" id="split-seed" min="1" step="1" value="1" required>
              </div>
            </div>
            <div class="form-text mt-2">The same seed gives the same split. The rest of the pairs is train${pairs ? ` (about ${pairs.toLocaleString()} pairs in all)` : ""}.</div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
            <button type="submit" class="btn btn-primary" id="split-download"><i class="fas fa-download me-1"></i>Download</button>
          </div>
        </form>
      </div>
    </div>`);
  const el = document.getElementById("split-modal");
  const modal = new bootstrap.Modal(el);
  el.addEventListener("hidden.bs.modal", () => { modal.dispose(); el.remove(); });
  document.getElementById("split-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const dev = parseInt(document.getElementById("split-dev").value, 10);
    const test = parseInt(document.getElementById("split-test").value, 10);
    const seed = parseInt(document.getElementById("split-seed").value, 10);
    if (!(dev >= 0) || !(test >= 0) || !(seed >= 1) || dev + test === 0) {
      e.target.classList.add("was-validated");
      toast("Give the number of dev and test pairs (at least one of them above 0) and a seed of 1 or more.", "warning");
      return;
    }
    const btn = document.getElementById("split-download");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>Preparing…`;
    try {
      const summary = await downloadProject(id, { devSize: dev, testSize: test, seed });
      const s = summary.split || {};
      toast(`Downloaded: train ${formatCount(s.train || 0)}, dev ${formatCount(s.dev || 0)}, test ${formatCount(s.test || 0)} pairs.`, "success");
      modal.hide();
    } catch (err) {
      reportError(err);
      btn.disabled = false;
      btn.innerHTML = `<i class="fas fa-download me-1"></i>Download`;
    }
  });
  modal.show();
}

export async function renderProject(id, params = new URLSearchParams()) {
  const app = document.getElementById("app");

  if (fixesProjectId !== String(id)) {
    fixes = [];
    fixesProjectId = String(id);
  }

  const project = await getProject(id);
  const numCores = navigator.hardwareConcurrency || 1;

  app.innerHTML = `
  <div class="page-header project-header">
    <div class="input-group project-name-group">
      <label class="input-group-text" for="document_name" title="Project name"><i class="fas fa-pen"></i></label>
      <input type="text" class="form-control" id="document_name" placeholder="Project name"
             value="${escapeHtml(project.name)}" maxlength="200" aria-label="Project name">
      <button id="store-btn" class="btn btn-outline-primary" type="button" title="Save the project name">
        <i class="fas fa-save"></i> Save
      </button>
    </div>
    <div class="d-flex flex-wrap align-items-center gap-2">
      <label class="text-size-control" title="Text size of phrases and sentences">
        <i class="fas fa-font text-size-small" aria-hidden="true"></i>
        <input type="range" class="form-range" id="text-size-range" min="80" max="200" step="10"
               aria-label="Text size of phrases and sentences">
        <i class="fas fa-font text-size-large" aria-hidden="true"></i>
        <span id="text-size-value" class="text-size-value tabular"></span>
      </label>
      <button id="apply-fixes-btn" class="btn btn-success" type="button" title="Apply the pending edits to the corpus">
        <i class="fas fa-check-double"></i> Apply edits
      </button>
      <div class="btn-group">
        <button id="download-btn" class="btn btn-outline-secondary" type="button"
                title="Download the corpus as .zip: sentences, alignments, change report and line origins">
          <i class="fas fa-download"></i> Download
        </button>
        <button type="button" class="btn btn-outline-secondary dropdown-toggle dropdown-toggle-split"
                data-bs-toggle="dropdown" aria-expanded="false" aria-label="More download options"></button>
        <ul class="dropdown-menu dropdown-menu-end">
          <li><button class="dropdown-item" type="button" id="download-split-btn">
            <i class="fas fa-scissors fa-fw me-1"></i>With train / dev / test split…</button></li>
          <li><a class="dropdown-item" href="#stats-${id}"><i class="fas fa-file-archive fa-fw me-1"></i>Whole project (.algf)…</a></li>
        </ul>
      </div>
    </div>
  </div>
  <div class="row">
    <div class="col-12 col-md-6 col-lg-4">
      <h2 class="section-title">Phrase pairs <span>most frequent first; click a phrase to search</span></h2>
      <table id="phrases-table" class="display" style="width:100%">
        <thead>
          <tr>
            <th></th>
            <th></th>
          </tr>
        </thead>
      </table>
      <div class="mt-2">
        <button id="download-phrases-btn" class="btn btn-sm btn-secondary">
          <i class="fas fa-download"></i> Download phrases
        </button>
      </div>
      <!-- Fixes Preview -->
      <div class="card mt-3 shadow-sm">
        <div class="card-header d-flex justify-content-between align-items-center">
          <h6 class="card-title mb-0">
            <i class="fas fa-list-check me-2"></i>Pending edits
            <span class="badge rounded-pill text-bg-secondary ms-1" id="fixes-count">0</span>
          </h6>
          <div class="d-flex align-items-center gap-2">
            <button class="btn btn-sm btn-secondary" type="button" data-bs-toggle="collapse" 
                    data-bs-target="#fixes-upload-section" aria-expanded="false" 
                    aria-controls="fixes-upload-section" title="Import fixes">
              <i class="fas fa-upload"></i>
            </button>
          </div>
        </div>
        <div class="card-body p-0">
          <!-- Upload Section (Hidden by default) -->
          <div class="collapse" id="fixes-upload-section">
            <div class="p-3 border-bottom bg-light">
              <div class="mb-2">
                <label for="fixes-file-input" class="form-label small fw-bold">
                  <i class="fas fa-file-import me-1"></i>Import Fixes
                </label>
                <input class="form-control form-control-sm" type="file" id="fixes-file-input" 
                       name="file" accept=".json,application/json">
                <div class="form-text">A JSON list of edits, e.g. downloaded on the History page of another project</div>
              </div>
            </div>
          </div>
          
          <!-- Fixes List -->
          <div class="p-2" id="fixes-container" style="max-height: 200px; overflow-y: auto;">
            <div class="text-center text-muted py-3">
              <i class="fas fa-info-circle me-2"></i>No changes pending
            </div>
          </div>
        </div>
      </div>
      <div id="glossary-panel" class="accordion mt-4">
        <div class="accordion-item">
          <h2 class="accordion-header" id="headingGlossary">
            <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseGlossary"
              aria-expanded="false" aria-controls="collapseGlossary">
              <i class="fas fa-book me-2 text-muted"></i>Glossary
              <span class="badge rounded-pill text-bg-secondary ms-2" id="glossary-count">0</span>
            </button>
          </h2>
          <div id="collapseGlossary" class="accordion-collapse collapse" aria-labelledby="headingGlossary"
            data-bs-parent="#glossary-panel">
            <div class="accordion-body">
              <p class="small text-muted">Translation pairs you confirmed: with <i class="fas fa-check"></i> in the phrase list,
                in Review &gt; Words, or here. They leave the phrase list, and Review flags pairs that have a glossary
                term but none of its confirmed translations.</p>
              <form id="glossary-form" class="input-group input-group-sm mb-2">
                <input type="text" class="form-control" id="glossary-src" placeholder="Source" aria-label="Glossary source" required>
                <input type="text" class="form-control" id="glossary-tgt" placeholder="Target" aria-label="Glossary target" required>
                <button class="btn btn-outline-primary" type="submit" title="Add the pair to the glossary"><i class="fas fa-plus"></i></button>
              </form>
              <table id="glossary-table" class="table table-sm">
                <thead><tr><th>pair</th><th></th></tr></thead>
                <tbody></tbody>
              </table>
              <div class="mb-3">
                <label for="glossary-file-input" class="form-label">Import a glossary</label>
                <input class="form-control form-control-sm" type="file" id="glossary-file-input" accept=".tsv,.txt,.json,text/plain,application/json">
                <div class="form-text"><code>source&lt;TAB&gt;target</code> per line, or JSON exported here.</div>
              </div>
              <div class="d-flex flex-wrap gap-2">
                <button id="download-glossary-tsv" class="btn btn-sm btn-secondary"><i class="fas fa-download"></i> TSV</button>
                <button id="download-glossary-json" class="btn btn-sm btn-secondary"><i class="fas fa-download"></i> JSON</button>
                <button id="clear-glossary-btn" class="btn btn-sm btn-outline-danger ms-auto"><i class="fas fa-trash-can"></i> Remove all</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div id="ignored-phrases" class="accordion my-4">
        <div class="accordion-item">
          <h2 class="accordion-header" id="headingTwo">
            <button class="accordion-button" type="button" data-bs-toggle="collapse" data-bs-target="#collapseTwo"
              aria-expanded="false" aria-controls="collapseTwo">
              <i class="fas fa-eye-slash me-2 text-muted"></i>Hidden phrases
            </button>
          </h2>
          <div id="collapseTwo" class="accordion-collapse collapse" aria-labelledby="headingTwo"
            data-bs-parent="#ignored-phrases">
            <div class="accordion-body">

              <div class="mb-3">
                <label for="ignored-file-input" class="form-label">Import a hide list</label>
                <input class="form-control form-control-sm" type="file" id="ignored-file-input" name="file" accept=".txt,.tsv,.json,text/plain,application/json">
                <div class="form-text">
                  A word list (<code>.txt</code>, one word or phrase per line) hides those source phrases
                  whatever their translation; <code>src&lt;TAB&gt;tgt</code> lines hide pairs. JSON exported
                  here works too. A phrase made only of hidden words is hidden as well.
                </div>
              </div>

              <table id="ignored-table" class="table table-sm">
                <thead>
                  <tr>
                    <th>phrase</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <!-- Dynamically populated list of fixes -->
                </tbody>
              </table>
              <!-- create button to download ignore -->
              <div class="d-flex gap-2">
                <button id="download-ignored-btn" class="btn btn-sm btn-secondary"><i class="fas fa-download"></i> Download</button>
                <button id="delete-ignored-btn" class="btn btn-sm btn-outline-danger ms-auto"><i class="fas fa-trash-can"></i> Remove all</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="col-12 col-md-6 col-lg-8">
      <h2 class="section-title">Sentence pairs <span>matches of the search highlighted; click a sentence to edit it</span></h2>
      <table id="translations-table" class="display" style="width:100%">
        <thead>
          <tr>
            <th></th>
          </tr>
        </thead>
      </table>
    </div>
  </div>
  `;

  const sidebar = document.getElementById("sidebar-content");
  sidebar.innerHTML = `
    <form id="fix-form" class="sidebar-section" autocomplete="off">
      <h2 class="panel-label">Find &amp; fix</h2>
      <div class="fix-grid">
        <span></span>
        <span class="fix-grid-head">Phrase</span>
        <span class="fix-grid-head">Replace with</span>
        <label class="fix-grid-side" for="fix-test1" title="Source side">Src</label>
        <input type="text" id="fix-test1" class="form-control form-control-sm" placeholder="source" aria-label="Source phrase">
        <input type="text" id="fix-fix1" class="form-control form-control-sm" placeholder="unchanged" aria-label="Source replacement">
        <label class="fix-grid-side" for="fix-test2" title="Target side">Tgt</label>
        <input type="text" id="fix-test2" class="form-control form-control-sm" placeholder="target" aria-label="Target phrase">
        <input type="text" id="fix-fix2" class="form-control form-control-sm" placeholder="unchanged" aria-label="Target replacement">
      </div>

      <div class="d-flex gap-2 mt-3">
        <button class="btn btn-sm btn-secondary flex-grow-1" type="button" id="search-phrases-btn">
          <i class="fas fa-search"></i> Search
        </button>
        <button class="btn btn-sm btn-link text-muted" type="button" id="clear-search-btn">Clear</button>
      </div>

      <div class="mt-3">
        <label for="fix-percentage" class="form-label d-flex justify-content-between mb-1">
          <span>Share of matches to edit</span>
          <span id="fix-percentage-value" class="text-muted fw-normal tabular">100%</span>
        </label>
        <input type="range" class="form-range" id="fix-percentage" min="0" max="100" value="100">
      </div>
      <input type="hidden" id="fix-direction" value="0">

      <div class="d-grid gap-2 mt-2">
        <div class="d-flex gap-2">
          <button class="btn btn-sm btn-primary flex-grow-1" type="button" id="add-fix-btn"
                  title="Replace the phrases in the matching sentences">
            <i class="fas fa-pen"></i> Add fix
          </button>
          <button class="btn btn-sm btn-secondary flex-grow-1" type="button" id="augment-btn"
                  title="Add edited copies of the matching sentences, keeping the originals">
            <i class="fas fa-clone"></i> Augment
          </button>
        </div>
        <button class="btn btn-sm btn-link link-danger text-start px-0" type="button" id="delete-sentences-btn">
          <i class="fas fa-trash-can"></i> Delete matching sentences…
        </button>
      </div>
    </form>

    <form id="set-metadata-form" class="sidebar-section">
      <h2 class="panel-label">Phrase extraction</h2>
      <div class="mb-2">
        <label for="threshold-input" class="form-label">
          Score threshold
          <i class="fas fa-circle-info ms-1 text-muted"
             data-bs-toggle="tooltip"
             data-bs-placement="right"
             title="Only phrase pairs that occur exclusively in sentences scoring below the threshold are collected."></i>
        </label>
        <input type="number" class="form-control form-control-sm" id="threshold-input" min="0" max="10000" placeholder="threshold" value="${project.threshold}">
      </div>
      <div class="settings-grid">
        <span class="form-label">Phrase length</span>
        <input type="number" class="form-control form-control-sm" id="min-phrase-length-input" min="1" max="10" value="${project.min_phrase_len}" aria-label="Minimum phrase length" title="minimum">
        <input type="number" class="form-control form-control-sm" id="max-phrase-length-input" min="1" max="10" value="${project.max_phrase_len}" aria-label="Maximum phrase length" title="maximum">
        <span class="form-label">Occurrences</span>
        <input type="number" class="form-control form-control-sm" id="min-occurrences-input" min="1" max="100" value="${project.min_count}" aria-label="Minimum occurrences" title="minimum">
        <input type="number" class="form-control form-control-sm" id="max-occurrences-input" min="1" value="${project.max_count}" aria-label="Maximum occurrences" title="maximum">
        <label class="form-label" for="max-phrases-input">Max. phrases</label>
        <input type="number" class="form-control form-control-sm span-2" id="max-phrases-input" max="40000000" value="${project.max_phrases}">
        <label class="form-label" for="num-cores-input">CPU cores</label>
        <input type="number" class="form-control form-control-sm" id="num-cores-input" min="1" max="16" value="${numCores}">
      </div>
      <div class="form-text mb-3">Length and occurrences: minimum and maximum.</div>
      <div class="d-grid gap-2">
        <button class="btn btn-sm btn-primary" type="button" id="threshold-btn-soft">
          <i class="fas fa-rotate"></i> Extract phrases
        </button>
        <button class="btn btn-sm btn-secondary" type="button" id="threshold-btn-hard"
                title="Align all sentences again, then extract the phrases">
          <i class="fas fa-arrows-left-right"></i> Realign sentences
        </button>
      </div>
    </form>
    `;

  const extractAndStoreStats = async () => {
    profiler.clear();
    const extractStats = await profiler.measureAsync('extractPhrases', () => extractPhrases(id));
    profiler.data = { ...profiler.data, ...(extractStats || {}) };
    await mergeProjectStats(id, profiler.data);
    return extractStats;
  };
  const phraseCount = (stats) => (stats?.total_phrases_filtered ?? 0).toLocaleString();

  bindAsyncButton(
    document.getElementById("threshold-btn-soft"),
    async () => {
      const stats = await runActivity("Extracting phrases", extractAndStoreStats,
        { done: (stats) => `Extracted ${phraseCount(stats)} phrase pairs` });
      toast(`Extracted ${phraseCount(stats)} phrase pairs.`, "success");
      $('#phrases-table').DataTable().ajax.reload();
    },
    "Extracting…"
  );

  bindAsyncButton(
    document.getElementById("threshold-btn-hard"),
    async () => { 
      const stats = await runActivity("Realigning sentences", async () => {
        await stage(0, 0.6, "", () => recomputeAlignments(id));
        return stage(0.6, 1, "Extracting phrases", extractAndStoreStats);
      }, { done: (stats) => `Realigned; ${phraseCount(stats)} phrase pairs` });
      toast(`Realigned all sentences and extracted ${phraseCount(stats)} phrase pairs.`, "success");
      $('#phrases-table').DataTable().ajax.reload();
      $('#translations-table').DataTable().ajax.reload(null, false);
    },
    "Realigning…"
  );

  bindAsyncButton(
    document.getElementById("store-btn"),
    async () => {
      await saveProject(id);
      document.getElementById("project-name-label").textContent = document.getElementById("document_name").value;
      toast("Project name saved.", "success", { delay: 2500 });
    },
    ""
  );
  document.getElementById("document_name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("store-btn").click();
  });

  // Update percentage display when slider value changes
  document.getElementById("fix-percentage").addEventListener("input", (event) => {
    document.getElementById("fix-percentage-value").textContent = `${event.target.value}%`;
  });

  // Initialize Bootstrap tooltips
  const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
  tooltipTriggerList.forEach(function (tooltipTriggerEl) {
    new bootstrap.Tooltip(tooltipTriggerEl);
  });

  function clearSearch() {
    $('#fix-test1').val('');
    $('#fix-fix1').val('');
    $('#fix-test2').val('');
    $('#fix-fix2').val('');
    $('#fix-direction').val('0');
    $('#fix-fix1').prop('disabled', false);
    $('#fix-fix2').prop('disabled', false);
    // reset to first page
    $('#translations-table').DataTable().page('first').draw('page');
  }

  document.getElementById("clear-search-btn").addEventListener("click", () => {
    clearSearch();
  });

  bindAsyncButton(
    document.getElementById("search-phrases-btn"),
    () => {
      const input = getPhraseInput();
      showTranslations(
        input.src_phrase, 
        input.tgt_phrase, 
        input.direction, 
        input.src_fix, 
        input.tgt_fix
      );
    },
    ""
  );

  bindAsyncButton(
    document.getElementById("delete-sentences-btn"),
    async () => {
      const input = getPhraseInput();
      const srcPhrase = input.src_phrase.trim();
      const tgtPhrase = input.tgt_phrase.trim();
      
      if (!srcPhrase && !tgtPhrase) {
        await showAlert("Please enter at least one phrase (Phrase 1 or Phrase 2) to delete matching sentences.", "No Phrase Entered", "warning");
        return;
      }
      
      let message = "Are you sure you want to delete all sentences where:\n\n";
      if (srcPhrase && tgtPhrase) {
        message += `• Source contains: "${srcPhrase}"\n• AND Target contains: "${tgtPhrase}"`;
      } else if (srcPhrase) {
        message += `• Source contains: "${srcPhrase}"`;
      } else {
        message += `• Target contains: "${tgtPhrase}"`;
      }
      message += "\n\nThis action cannot be undone!";
      
      if (!await showDeleteConfirm(message, "Delete sentences")) {
        return;
      }
      
      const deletedCount = await deleteTranslationsByPhrasePair(id, srcPhrase, tgtPhrase, input.direction);
      toast(`Deleted ${deletedCount.toLocaleString()} sentence pair(s).`, "success");
      phrasesTable.ajax.reload();
      translationsTable.ajax.reload();
    },
    ""
  );

  function addChange(type) {
    const input = getPhraseInput();
    input.type = type;
    if (!input.src_phrase.trim() && !input.tgt_phrase.trim()) {
      toast("Search for a phrase first (Phrase 1 and/or Phrase 2), then enter the replacement.", "warning");
      return;
    }
    if (input.src_fix === input.src_phrase && input.tgt_fix === input.tgt_phrase) {
      toast("The fix is identical to the phrase: change Fix 1 or Fix 2 first.", "warning");
      return;
    }
    // one pending edit per phrase pair and kind: adding it again updates it
    const exists = fixes.find(f => 
      f.src_phrase === input.src_phrase && 
      f.tgt_phrase === input.tgt_phrase && 
      f.direction === input.direction &&
      f.type === input.type
    );
    if (exists) {
      Object.assign(exists, input);
    } else {
      fixes.push(input);
    }

    showTranslations(
      input.src_phrase, 
      input.tgt_phrase, 
      input.direction, 
      input.src_fix, 
      input.tgt_fix
    );

    updateFixesList();
  }

  bindAsyncButton(
    document.getElementById("add-fix-btn"), 
    () => {
      addChange('fix');
    },
    ""
  );

  bindAsyncButton(
    document.getElementById("augment-btn"), 
    () => {
      addChange('augment');
    },
    ""
  );


  bindAsyncButton(
    document.getElementById("apply-fixes-btn"), 
    async () => {
      if (fixes.length === 0) {
        toast("There are no pending edits. Search for a phrase and use “Add Fix” or “Augment” first.", "info");
        return;
      }
      const pending = fixes.slice();
      const n = pending.length;
      await runActivity(`Applying ${n} edit${n === 1 ? "" : "s"}`, () => applyFixes(id, pending),
        { done: () => `Applied ${n} edit${n === 1 ? "" : "s"}` });
      fixes = [];
      clearSearch();
      updateFixesList();
      toast(`Applied ${n} edit${n === 1 ? "" : "s"}. See History for details.`, "success",
        { action: { label: "History", href: `#history-${id}` } });
      $('#phrases-table').DataTable().ajax.reload();
      $('#translations-table').DataTable().ajax.reload(null, false);
    },
    "Applying…"
  );

  bindAsyncButton(
    document.getElementById("download-btn"),
    () => downloadProject(id).catch(reportError)
  );
  document.getElementById("download-split-btn").addEventListener("click", () => openSplitDialog(id));

  bindAsyncButton(
    document.getElementById("download-ignored-btn"), 
    () => {
      downloadIgnoredPhrases(id)
    }
  );

  bindAsyncButton(
    document.getElementById("download-phrases-btn"), 
    () => {
      downloadPhrases(id)
    }
  );


  document.getElementById("fixes-file-input").addEventListener("change", async function(event) {
    const file = event.target.files[0]; 
    if (file) {
      console.log("Selected file:", file.name);

      const reader = new FileReader();
      reader.onload = async function(e) {
        try {
          const importedFixes = JSON.parse(e.target.result);

          if (!Array.isArray(importedFixes)) {
            await showAlert("The imported file must contain a JSON array of fixes.", "Invalid File Format", "danger");
            return;
          }

          // keep valid fixes and augmentations (as written by History → Download);
          // deletions are applied right away on this page, so they are skipped
          let added = 0, skipped = 0;
          for (const entry of importedFixes) {
            const type = entry?.type || "fix";
            const str = (v) => (typeof v === "string" ? v : "");
            const fix = {
              src_phrase: str(entry?.src_phrase), tgt_phrase: str(entry?.tgt_phrase),
              src_fix: str(entry?.src_fix) || str(entry?.src_phrase),
              tgt_fix: str(entry?.tgt_fix) || str(entry?.tgt_phrase),
              direction: String(entry?.direction ?? "0"),
              percentage: String(entry?.percentage ?? "100"),
              type,
            };
            if (!["fix", "augment"].includes(type) || (!fix.src_phrase && !fix.tgt_phrase) ||
                (fix.src_fix === fix.src_phrase && fix.tgt_fix === fix.tgt_phrase)) {
              skipped++;
              continue;
            }
            const same = fixes.find(f => f.src_phrase === fix.src_phrase && f.tgt_phrase === fix.tgt_phrase &&
              String(f.direction) === fix.direction && f.type === fix.type);
            if (same) Object.assign(same, fix); else fixes.push(fix);
            added++;
          }

          updateFixesList();
          toast(`Imported ${added} edit(s)` + (skipped ? `, skipped ${skipped} (deletions or no change)` : "") +
            "; apply them with “Apply edits”.", added ? "success" : "warning");
        } catch (error) {
          console.error("Error parsing JSON:", error);
          await showAlert("Failed to parse the JSON file. Please ensure the file contains valid JSON.", "Import Error", "danger");
        }
      };
      reader.readAsText(file);
      event.target.value = "";   // so the same file can be imported again
    }
  });
  
  document.getElementById("ignored-file-input").addEventListener("change", function(event) {
    const file = event.target.files[0]; 
    if (file) {
      file.text()
        .then(content => importIgnoredFromFile(id, content))
        .then(({ read, added }) => {
          const dup = read - added;
          toast(`${file.name}: ${added.toLocaleString()} entries added to the hide list` +
            (dup ? ` (${dup.toLocaleString()} already there).` : "."), "success");
          ignoredTable.ajax.reload();
          phrasesTable.ajax.reload(null, false);
        })
        .catch(reportError)
        .finally(() => { event.target.value = ""; });
    }
  });

  // Initialize DataTable with POST-based server-side processing
  const translationsTable = $("#translations-table").DataTable({
    processing: true,      // show "Processing…" while loading
    serverSide: true,      // server handles paging/filtering/sorting
    deferRender: true,
    scroller: false,
    scrollY: 800,
    paging: true,
    pageLength: 20,
    lengthMenu: [10, 20, 50, 100],
    autoWidth: false,  // let columns take natural width
    ajax: async function (d, callback) {
      d.phrase1 = $('#fix-test1').val();
      d.phrase2 = $('#fix-test2').val();
      d.fix1 = $('#fix-fix1').val();
      d.fix2 = $('#fix-fix2').val();
      d.direction = $('#fix-direction').val();
      d.project_id = id;  // add project ID to request data
      const result = await fetchTranslations(d);
      callback(result); // DataTable expects JSON in correct format
    },
    columns: [
      { data: null, render: (data, type, row) => `
        <div class="translation-row">
          <div contenteditable="true" class="mb-2" 
          style="word-wrap: break-word; white-space: pre-wrap;" 
          id="translation-src-${row.row_id}">${row.line1}</div>
          <div contenteditable="true" style="word-wrap: break-word; white-space: pre-wrap;" id="translation-tgt-${row.row_id}">${row.line2}</div>
          <div class="btn-group-horizontal ms-2 my-2">
            <button class="store-translation-btn btn btn-sm btn-outline-success" data-id="${row.row_id}">
              <i class="fas fa-save"></i>
            </button>
            <button class="remove-translation-btn btn btn-sm btn-outline-danger" data-id="${row.row_id}">
              <i class="fas fa-trash"></i>
            </button>
            <span class="mx-2 score">Score: ${row.score}</span>
          </div>
        </div>` }
    ]
  });
  
  // Attach handlers every time the table draws
  const projectId = id;
  translationsTable.on('draw', () => {
    document.querySelectorAll('.store-translation-btn').forEach(btn => {
      const rowId = btn.dataset.id;
      bindAsyncButton(
        btn,
        () => storeTranslationBtn(projectId, rowId),
        ""
      );
    });
    document.querySelectorAll('.remove-translation-btn').forEach(btn => {
      const rowId = btn.dataset.id;
      bindAsyncButton(
        btn,
        () => removeTranslationBtn(projectId, rowId),
        ""
      );
    });
  });

  // Initialize DataTable with POST-based server-side processing
  const phrasesTable = $("#phrases-table").DataTable({
    processing: true,      // show "Processing…" while loading
    serverSide: true,      // server handles paging/filtering/sorting
    autoWidth: false,  // let columns take natural width
    pageLength: 6,
    scrollY: 400,
    scroller: true,
    lengthChange: false,
    ajax: function (d, callback) {
      const min_phrase_len = $("#min-phrase-length-input").val();
      const params = { ...d, project_id: id, min_phrase_len: min_phrase_len };
      fetchPhrases(params).then(result => callback(result));
    },
    columns: [
        { data: null, render: (data, type, row) => `<button class="btn btn-sm btn-outline show-phrases-btn" data-src="${escapeForHtmlAttr(row.src_phrase)}" data-tgt="${escapeForHtmlAttr(row.tgt_phrase)}" data-direction="${row.direction}"><i class="fas fa-search"></i> ${row.num_occurrences}</button>
        <button class="btn btn-sm btn-clear show-src-phrase-btn" data-text="${escapeForHtmlAttr(row.src_phrase)}">${escapeHtml(row.src_phrase)}</button>${getDirectionSymbol(row.direction)}<button class="btn btn-sm btn-clear search-tgt-phrase-btn" data-text="${escapeForHtmlAttr(row.tgt_phrase)}">${escapeHtml(row.tgt_phrase)}</button>` },
        { data: null, render: (data, type, row) => `<div class="phrase-actions">
            <button class="btn btn-sm btn-outline confirm-phrase-btn" data-id="${row.id}" title="Correct: add to the glossary" aria-label="Add to the glossary"><i class="fas fa-check"></i></button>
            <button class="btn btn-sm btn-outline ignore-phrase-btn" data-id="${row.id}" data-src="${escapeHtml(row.src_phrase)}" data-tgt="${escapeHtml(row.tgt_phrase)}" title="Hide this pair" aria-label="Hide this pair"><i class="fas fa-eye-slash"></i></button>
          </div>` }
    ]
  });
  // Text size of the phrase and sentence lists (saved in the browser)
  const sizeRange = document.getElementById('text-size-range');
  const sizeValue = document.getElementById('text-size-value');
  const showSize = pct => {
    document.documentElement.style.setProperty('--text-scale', pct / 100);
    sizeValue.textContent = `${pct}%`;
  };
  sizeRange.value = getTextSize();
  showSize(Number(sizeRange.value));
  sizeRange.addEventListener('input', () => showSize(Number(sizeRange.value)));
  sizeRange.addEventListener('change', () => {
    try { localStorage.setItem(TEXT_SIZE_KEY, sizeRange.value); } catch (e) { /* private mode */ }
    phrasesTable.scroller.measure(); // rows are taller or shorter now
  });

  // Attach handlers every time the table draws
  phrasesTable.on('draw', () => {
    document.querySelectorAll('.confirm-phrase-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await addPhraseToGlossary(id, btn.dataset.id);
          toast("Added to the glossary.", "success");
          glossaryTable.ajax.reload(null, false);
          phrasesTable.ajax.reload(null, false);
        } catch (err) {
          reportError(err);
          btn.disabled = false;
        }
      });
    });
    document.querySelectorAll('.ignore-phrase-btn').forEach(btn => {
      const phrase_id =  btn.dataset.id;
      btn.addEventListener('click', async () => {
        await setIgnorePhrase(id, phrase_id, 1);
        ignoredTable.ajax.reload(null, false);
        phrasesTable.ajax.reload(null, false);
      });
    });
    document.querySelectorAll('.show-src-phrase-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const phrase = btn.dataset.text;
        $('#fix-test1').val(phrase);
        $('#fix-fix1').val(phrase);
        $('#fix-test2').val('');
        $('#fix-fix2').val('');
        $('#fix-direction').val('0');
        phrasesTable.search(phrase).draw();
      });
    });
    document.querySelectorAll('.search-tgt-phrase-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const phrase = btn.dataset.text;
        $('#fix-test1').val('');
        $('#fix-fix1').val('');
        $('#fix-test2').val(phrase);
        $('#fix-fix2').val(phrase);
        $('#fix-direction').val('0');
        phrasesTable.search(phrase).draw();
      });
    });
    document.querySelectorAll('.show-phrases-btn').forEach(btn => {
      // get data-src, data-tgt, data-direction
      const src = btn.dataset.src;
      const tgt = btn.dataset.tgt;
      const direction = btn.dataset.direction;
      btn.addEventListener('click', () => showTranslations(src, tgt, direction));
    });
  });

  // The glossary
  const glossaryTable = $("#glossary-table").DataTable({
    processing: true,
    serverSide: true,
    autoWidth: false,
    pageLength: 6,
    lengthChange: false,
    searching: false,
    ajax: function (d, callback) {
      fetchGlossary({ ...d, project_id: id }).then(result => {
        document.getElementById("glossary-count").textContent = result.recordsTotal.toLocaleString();
        callback(result);
      }).catch(reportError);
    },
    language: { emptyTable: "No confirmed pairs yet." },
    columns: [
      { data: null, render: (data, type, row) => `${escapeHtml(row.src)} ↔ ${escapeHtml(row.tgt)}` },
      { data: null, render: (data, type, row) => `<button class="btn btn-sm btn-outline remove-glossary-btn" data-id="${row.id}" title="Remove from the glossary" aria-label="Remove from the glossary"><i class="fas fa-undo"></i></button>` },
    ],
  });
  glossaryTable.on('draw', () => {
    document.querySelectorAll('.remove-glossary-btn').forEach(btn => btn.addEventListener('click', async () => {
      try {
        await removeGlossaryEntry(id, btn.dataset.id);
        glossaryTable.ajax.reload(null, false);
        phrasesTable.ajax.reload(null, false);
      } catch (err) {
        reportError(err);
      }
    }));
  });
  document.getElementById("glossary-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const src = document.getElementById("glossary-src").value.trim();
    const tgt = document.getElementById("glossary-tgt").value.trim();
    if (!src || !tgt) { toast("Type a source and a target.", "warning"); return; }
    try {
      const added = await addGlossaryPairs(id, [[src, tgt]]);
      toast(added ? `“${src}” ↔ “${tgt}” added to the glossary.` : "That pair is already in the glossary.", added ? "success" : "info");
      e.target.reset();
      glossaryTable.ajax.reload();
      phrasesTable.ajax.reload(null, false);
    } catch (err) {
      reportError(err);
    }
  });
  document.getElementById("glossary-file-input").addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) return;
    file.text()
      .then(content => importGlossaryFile(id, content))
      .then(({ read, added }) => {
        const dup = read - added;
        toast(`${file.name}: ${added.toLocaleString()} pairs added to the glossary` +
          (dup ? ` (${dup.toLocaleString()} already there).` : "."), "success");
        glossaryTable.ajax.reload();
        phrasesTable.ajax.reload(null, false);
      })
      .catch(reportError)
      .finally(() => { event.target.value = ""; });
  });
  for (const format of ["tsv", "json"]) {
    document.getElementById(`download-glossary-${format}`).addEventListener("click", async () => {
      try {
        const n = await downloadGlossary(id, format, project.name);
        if (!n) toast("The glossary is empty.", "info");
      } catch (err) {
        reportError(err);
      }
    });
  }
  bindAsyncButton(document.getElementById("clear-glossary-btn"), async () => {
    const ok = await showDeleteConfirm("Remove all pairs from the glossary?\n\nTheir phrase pairs are listed again.",
      "Empty the glossary", "Remove all");
    if (!ok) return;
    await clearGlossary(id);
    glossaryTable.ajax.reload();
    phrasesTable.ajax.reload(null, false);
  });

  // Initialize DataTable with POST-based server-side processing
  const ignoredTable = $("#ignored-table").DataTable({
    processing: true,      // show "Processing…" while loading
    serverSide: true,      // server handles paging/filtering/sorting
    autoWidth: false,  // let columns take natural width
    pageLength: 6,
    lengthChange: false,
    ajax: function (d, callback) {
      const params = { ...d, project_id: id };
      fetchIgnoredPhrases(params).then(result => callback(result));
    },
    columns: [
        { data: null, render: (data, type, row) => {
            const any = '<span class="text-muted fst-italic" title="any translation">any</span>';
            const src = row.src_phrase ? escapeHtml(row.src_phrase) : any;
            const tgt = row.tgt_phrase ? escapeHtml(row.tgt_phrase) : any;
            const tag = row.imported == 1 ? '' : ' <span class="badge text-bg-light" title="hidden from the phrase table">pair</span>';
            return `${src} ↔ ${tgt}${tag}`;
          } },
        { data: null, render: (data, type, row) => `<button class="btn btn-sm btn-outline undo-ignore-phrase-btn" data-id="${row.id}" data-imported="${row.imported}"><i class="fas fa-undo"></i></button>` }
    ]
  });

  // Attach handlers every time the table draws
  ignoredTable.on('draw', () => {
    document.querySelectorAll('.undo-ignore-phrase-btn').forEach(btn => {
      const phrase_id =  btn.dataset.id;
      const imported = btn.dataset.imported;
      btn.addEventListener('click', async () => {
        await setIgnorePhrase(id, phrase_id, 0, imported);
        ignoredTable.ajax.reload(null, false);
        phrasesTable.ajax.reload(null, false);
      });
    });
  });

  // bind delete all ignored phrases button
  bindAsyncButton(
    document.getElementById("delete-ignored-btn"), 
    async () => {
      const confirmed = await showDeleteConfirm(
        "Show all hidden phrases again?\n\nThis empties the list of hidden phrases.",
        "Unhide all phrases", "Unhide all"
      );
      if (!confirmed) {
        return;
      }
      await deleteAllIgnoredPhrases(id);
      ignoredTable.ajax.reload(null, false);
      phrasesTable.ajax.reload(null, false);
    }
  );

  // pending edits kept from an earlier visit of this project
  updateFixesList();

  // opened with a phrase to look at (e.g. from the Review page)
  if (params.get("src") || params.get("tgt")) {
    showTranslations(params.get("src") || "", params.get("tgt") || "", params.get("direction") || "0");
    document.getElementById("translations-table")?.scrollIntoView({ block: "start" });
  }
}

function showTranslations(phrase1, phrase2, direction, fix1 = '', fix2 = '') {

  // a pending fix for this phrase pair: show its replacement
  const fix = fixes.find(f => f.src_phrase === phrase1 && f.tgt_phrase === phrase2 && String(f.direction) === String(direction));

  if (fix && !fix1 && !fix2) {
    fix1 = fix.src_fix;
    fix2 = fix.tgt_fix;
  } else {
    fix1 = fix1 ? fix1 : phrase1;
    fix2 = fix2 ? fix2 : phrase2;
  }

  $('#fix-test1').val(phrase1);
  $('#fix-fix1').val(fix1);
  $('#fix-test2').val(phrase2);
  $('#fix-fix2').val(fix2);
  $('#fix-direction').val(direction);

  if (direction == 1) {
    // set fix-fix.1 disabled
    $('#fix-fix1').prop('disabled', true);
  } else if (direction == -1) {
    $('#fix-fix2').prop('disabled', true);
  } else {
    $('#fix-fix1').prop('disabled', false);
    $('#fix-fix2').prop('disabled', false);
  }

  // reset to first page
  $('#translations-table').DataTable().page('first').draw('page');
}

function getPhraseInput() {
  return {
    src_phrase: $('#fix-test1').val(),
    tgt_phrase: $('#fix-test2').val(),
    src_fix: $('#fix-fix1').val(),
    tgt_fix: $('#fix-fix2').val(),
    direction: $('#fix-direction').val(),
    percentage: $('#fix-percentage').val()
  };
}

async function storeTranslationBtn(project_id, row_id) {
  const line1 = $(`#translation-src-${row_id}`).text();
  const line2 = $(`#translation-tgt-${row_id}`).text();
  await storeTranslation(project_id, row_id, line1, line2);
  toast("Sentence pair saved.", "success", { delay: 2500 });
}

async function removeTranslationBtn(project_id, row_id) {
  // ask alert to confirm
  const confirmed = await showDeleteConfirm(
    "Delete this sentence pair from the corpus?",
    "Delete sentence pair"
  );
  if (!confirmed) {
    return;
  }

  // store empty translation
  await deleteTranslation(project_id, row_id);
  toast("Sentence pair deleted.", "success", { delay: 2500 });
  // redraw table
  $('#translations-table').DataTable().ajax.reload(null, false); // false to stay on current page
}

function updateFixesList() {
  const container = $('#fixes-container');
  const fixesCount = $('#fixes-count');
  
  fixesCount.text(fixes.length)
    .toggleClass('text-bg-warning', fixes.length > 0)
    .toggleClass('text-bg-secondary', fixes.length === 0);
  
  if (fixes.length === 0) {
    container.html(`
      <div class="text-center text-muted py-3">
        <i class="fas fa-info-circle me-2"></i>No changes pending
      </div>
    `);
    return;
  }

  container.empty();
  fixes.forEach(function (fix, index) {
    const fix1_text = fix.src_fix ? `${fix.src_fix}` : fix.src_phrase;
    const fix2_text = fix.tgt_fix ? `${fix.tgt_fix}` : fix.tgt_phrase;
    const directionSymbol = getDirectionSymbol(fix.direction);

    container.append(`
      <div class="fix-entry border rounded p-2 mb-2 bg-light">
        <div class="d-flex justify-content-between align-items-start">
          <div class="flex-grow-1">
            <div class="text-muted mb-1">
              <span class="fw-bold">${escapeHtml(fix.src_phrase)}</span> 
              <span class="mx-1">${directionSymbol}</span> 
              <span class="fw-bold">${escapeHtml(fix.tgt_phrase)}</span>
            </div>
            <div class="text-success">
              ${fix1_text ? `<span>${escapeHtml(fix1_text)}</span>` : ''}
              <span class="mx-1">${directionSymbol}</span> 
              ${fix2_text ? `<span>${escapeHtml(fix2_text)}</span>` : ''}
              <span class="badge bg-info">${escapeHtml(fix.type)}</span>
            </div>
          </div>
          <div class="text-end ms-2">
            <span class="badge bg-secondary d-block mb-1">${fix.percentage}%</span>
            <button class="btn btn-sm btn-outline-danger remove-fix-btn" data-idx="${index}"
                    title="Remove fix">
              <i class="fas fa-times"></i>
            </button>
          </div>
        </div>
      </div>
    `);
  });

  // Reattach event handlers
  $('.remove-fix-btn').on('click', function() {
    const index = $(this).data('idx');
    removeFix(index);
  });
}

function removeFix(index) {
  fixes.splice(index, 1);
  updateFixesList();
}