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

import { importScoresFromFile, assignAutoScores, assignStabilityScores, assignConsistencyScores, explainConsistency, getScores, getAlignmentsWithScores } from "../backend/js/scores.js";
import { bindAsyncButton, escapeHtml, reportError } from "./utils.js";
import { runActivity } from "./activity.js";
import { toast } from "./dialogs.js";

/**
 * renderScores(projectId)
 * - Renders a scores page showing histogram, distribution table, and file upload
 */
export async function renderScores(projectId) {
  const app = document.getElementById('app') || document.body;
  app.innerHTML = `<div class="container py-3"><div class="text-center">Loading...</div></div>`;

  let scoresData;
  try {
    scoresData = await getScores(projectId);
  } catch (e) {
    app.innerHTML = `<div class="alert alert-danger">Failed to load scores: ${e.message}</div>`;
    return;
  }

  app.innerHTML = `
    <div>
      <div class="row">
        <div class="col-12">
          <div class="page-header">
            <h1 class="page-title">Scores</h1>
            <span class="text-muted small">One score per sentence pair; low scores mark pairs worth reviewing.</span>
          </div>
        </div>

        <!-- File Upload Section -->
        <div class="col-12 col-lg-4 mb-4">
          <div class="card h-100">
            <div class="card-header d-flex justify-content-between align-items-center">
              <h5 class="card-title mb-0">
                <i class="fas fa-calculator me-2"></i>Assign scores
              </h5>
              <button id="refresh-scores-btn" class="btn btn-sm btn-link text-muted p-0" title="Reload the scores">
                <i class="fas fa-rotate"></i><span class="visually-hidden">Refresh</span>
              </button>
            </div>
            <div class="card-body">
              <div class="panel-label">Compute from the alignments</div>
              <div class="list-group score-methods mb-4">
                <button id="assign-difficulty-scores-btn" class="list-group-item list-group-item-action" data-busy="icon">
                  <i class="fas fa-brain"></i>
                  <span><strong>Translation clarity</strong><small>How ambiguous the words of a sentence are</small></span>
                </button>
                <button id="assign-stability-scores-btn" class="list-group-item list-group-item-action" data-busy="icon">
                  <i class="fas fa-link"></i>
                  <span><strong>Alignment stability</strong><small>How completely both sides are aligned</small></span>
                </button>
                <button id="assign-consistency-scores-btn" class="list-group-item list-group-item-action" data-busy="icon">
                  <i class="fas fa-magnifying-glass"></i>
                  <span><strong>Alignment consistency</strong><small>Likely translation errors, as on the Review page</small></span>
                </button>
              </div>

              <div class="panel-label">Or upload your own</div>
              <input class="form-control form-control-sm" type="file" id="scores-file-input" name="file" accept=".txt,.csv" aria-label="Scores file">
              <div class="form-text">A text file with one score per line, in sentence order.</div>
            </div>
          </div>
        </div>

        <!-- Histogram Section -->
        <div class="col-12 col-lg-8 mb-4">
          <div class="card h-100">
            <div class="card-header">
              <h5 class="card-title mb-0">
                <i class="fas fa-chart-column me-2"></i>Score distribution
              </h5>
            </div>
            <div class="card-body">
              <div class="text-center" id="histogram-container">
                <canvas id="scores-histogram" width="600" height="400"></canvas>
              </div>
            </div>
          </div>
        </div>

        <!-- Alignments Viewer - Always Visible -->
        <div class="col-12 mb-4">
          <div class="card">
            <div class="card-header">
              <h5 class="card-title mb-0">
                <i class="fas fa-list me-2"></i>Sentence pairs by score
              </h5>
            </div>
            <div class="card-body">
              <div class="row g-2 align-items-end mb-3">
                <div class="col-6 col-md-2">
                  <label class="form-label" for="min-score-filter">Min. score</label>
                  <input type="number" id="min-score-filter" class="form-control form-control-sm" step="0.1" placeholder="any">
                </div>
                <div class="col-6 col-md-2">
                  <label class="form-label" for="max-score-filter">Max. score</label>
                  <input type="number" id="max-score-filter" class="form-control form-control-sm" step="0.1" placeholder="any">
                </div>
                <div class="col-12 col-md-3">
                  <label class="form-label" for="sort-order">Sort by</label>
                  <select id="sort-order" class="form-select form-select-sm">
                    <option value="desc">Score, high to low</option>
                    <option value="asc">Score, low to high</option>
                    <option value="id">Line number</option>
                  </select>
                </div>
                <div class="col-12 col-md-auto d-flex gap-2">
                  <button id="apply-filters-btn" class="btn btn-sm btn-primary">
                    <i class="fas fa-filter"></i> Apply
                  </button>
                  <button id="reset-filters-btn" class="btn btn-sm btn-secondary">
                    <i class="fas fa-rotate-left"></i> Reset
                  </button>
                </div>
              </div>

              <!-- Alignments Table -->
              <div class="table-responsive">
                <table id="alignments-table" class="table table-sm table-hover">
                  <thead>
                    <tr>
                      <th style="width: 5%;">ID</th>
                      <th style="width: 10%;">Score</th>
                      <th style="width: 35%;">Source</th>
                      <th style="width: 35%;">Target</th>
                      <th style="width: 15%;">Actions</th>
                    </tr>
                  </thead>
                  <tbody id="alignments-tbody">
                    <tr>
                      <td colspan="5" class="text-center text-muted">
                        <i class="fas fa-spinner fa-spin me-2"></i>Loading alignments...
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <!-- Pagination Controls -->
              <div class="d-flex flex-wrap gap-2 justify-content-between align-items-center mt-3 small">
                <div>
                  <span class="text-muted">Page</span>
                  <span id="current-page">1</span> <span class="text-muted">of</span> <span id="total-pages">1</span>
                  <span class="ms-3 text-muted">·</span>
                  <span id="total-records" class="ms-2">0</span> <span class="text-muted">sentence pairs</span>
                </div>
                <div class="small">
                  <label class="me-2 text-muted" for="page-size">Per page</label>
                  <select id="page-size" class="form-select form-select-sm d-inline-block" style="width: auto;">
                    <option value="30" selected>30</option>
                    <option value="50">50</option>
                    <option value="100">100</option>
                    <option value="500">500</option>
                    <option value="1000">1000</option>
                  </select>
                </div>
                <div class="btn-group">
                  <button id="first-page-btn" class="btn btn-sm btn-outline-secondary">
                    <i class="fas fa-angle-double-left"></i>
                  </button>
                  <button id="prev-page-btn" class="btn btn-sm btn-outline-secondary">
                    <i class="fas fa-angle-left"></i>
                  </button>
                  <button id="next-page-btn" class="btn btn-sm btn-outline-secondary">
                    <i class="fas fa-angle-right"></i>
                  </button>
                  <button id="last-page-btn" class="btn btn-sm btn-outline-secondary">
                    <i class="fas fa-angle-double-right"></i>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Score Metrics Explanations -->
        <div class="col-12">
          <div class="card">
            <div class="card-header">
              <h5 class="card-title mb-0">
                <i class="fas fa-circle-info me-2"></i>How the scores are computed
              </h5>
            </div>
            <div class="card-body">
              <ul class="nav nav-tabs" id="metricsTab" role="tablist">
                <li class="nav-item" role="presentation">
                  <button class="nav-link active" id="difficulty-tab" data-bs-toggle="tab" data-bs-target="#difficulty" type="button" role="tab">
                    <i class="fas fa-brain me-1"></i>Translation Clarity
                  </button>
                </li>
                <li class="nav-item" role="presentation">
                  <button class="nav-link" id="stability-tab" data-bs-toggle="tab" data-bs-target="#stability" type="button" role="tab">
                    <i class="fas fa-link me-1"></i>Alignment Stability Index
                  </button>
                </li>
                <li class="nav-item" role="presentation">
                  <button class="nav-link" id="consistency-tab" data-bs-toggle="tab" data-bs-target="#consistency" type="button" role="tab">
                    <i class="fas fa-search me-1"></i>Alignment Consistency
                  </button>
                </li>
              </ul>
              <div class="tab-content p-3" id="metricsTabContent">
                <!-- Translation Clarity Tab -->
                <div class="tab-pane fade show active" id="difficulty" role="tabpanel">
                  <h5>Translation Clarity Score</h5>
                  <p>This metric estimates how <strong>clear and unambiguous a sentence is to translate</strong> based on the translation options available for its words. Higher scores indicate clearer, less ambiguous translations.</p>
                  
                  <h6>How it works:</h6>
                  <ol>
                    <li><strong>Translation statistics:</strong> From the word alignments, the system learns for each word how often it is left unaligned and how often it is aligned to each of its translations (words seen fewer than 20 times are skipped).</li>
                    <li><strong>Word-level ambiguity:</strong> The ambiguity of a word is the entropy of this distribution. A word with one dominant translation and a few rare variants is still clear; a word whose translations are evenly split is ambiguous.</li>
                    <li><strong>Sentence difficulty:</strong> The mean ambiguity over the words of both sides (words without statistics get the corpus median).</li>
                    <li><strong>Normalization &amp; inversion:</strong> Sentences are ranked by difficulty and mapped to 0-1, so higher scores mean clearer translations.</li>
                  </ol>

                  <h6>Formula:</h6>
                  <div class="bg-light p-3 rounded mb-2">
                    <code>H(w) = −p₀ log p₀ − Σₜ r·p(t|w) log(r·p(t|w))</code><br>
                    <code>D(S) = (1 / |W(S)|) × Σ H(w) for w in W(S)</code>
                  </div>
                  <p class="small">
                    Where <code>r</code> is how often <code>w</code> is aligned at all, <code>p₀ = 1 − r</code>, <code>p(t|w)</code> is the share of its links that go to <code>t</code>,
                    and <code>W(S)</code> are the words of both sides of sentence pair <code>S</code>.
                    The final score is <code>1 − rank(D) / (N − 1)</code> over the <code>N</code> sentence pairs.
                  </p>

                  <h6>Score Range:</h6>
                  <div class="d-flex flex-wrap align-items-center gap-2 mt-2">
                    <span class="badge bg-danger">0.0 - Very Ambiguous</span>
                    <span class="badge bg-warning">0.3 - Difficult</span>
                    <span class="badge bg-info">0.6 - Moderate</span>
                    <span class="badge bg-success">0.8+ - Easy</span>
                  </div>
                </div>
                
                <!-- Alignment Stability Tab -->
                <div class="tab-pane fade" id="stability" role="tabpanel">
                  <h5>Alignment Stability Index</h5>
                  <p>This metric measures the <strong>quality and reliability</strong> of word alignments between source and target sentences.</p>
                  
                  <h6>Components:</h6>
                  <ul>
                    <li><strong>Coverage:</strong> the share of source words (recall) and of target words (precision) with at least one alignment point.</li>
                    <li><strong>Balance:</strong> their harmonic mean (F1), which is low if one side is covered much better than the other.</li>
                    <li><strong>Unaligned penalty:</strong> the F1 is multiplied by the share of all words that are aligned.</li>
                  </ul>

                  <h6>Formula:</h6>
                  <div class="bg-light p-3 rounded mb-2">
                    <code>P = aligned_tgt / |T|, R = aligned_src / |S|, F1 = 2PR / (P + R)</code><br>
                    <code>Stability = F1 × (1 − (unaligned_src + unaligned_tgt) / (|S| + |T|))</code>
                  </div>

                  <h6>Score Range:</h6>
                  <div class="d-flex flex-wrap align-items-center gap-2 mt-2">
                    <span class="badge bg-danger">0.0 - Bad</span>
                    <span class="badge bg-warning">0.3 - Fair</span>
                    <span class="badge bg-info">0.6 - Good</span>
                    <span class="badge bg-success">0.8+ - Excellent</span>
                  </div>
                </div>

                <!-- Alignment Consistency Tab -->
                <div class="tab-pane fade" id="consistency" role="tabpanel">
                  <h5>Alignment Consistency</h5>
                  <p>This metric flags sentence pairs with <strong>likely translation errors</strong>: omissions, mistranslations,
                    hallucinated additions and pairs that do not belong together. Words that are simply translated in several
                    valid ways (synonyms, inflections, paraphrases) are <em>not</em> penalised. Low scores are worth reviewing;
                    the Review page lists the same issues with explanations.</p>

                  <h6>Checks</h6>
                  <ul>
                    <li><strong>Usual translation missing:</strong> for every word seen in at least 20 sentences, AlignFix learns its usual
                      translations from the alignments (linked often in both directions, inflections merged) and how often
                      at least one of them appears on the other side. A word is flagged when none appears although one nearly always does.
                      This does not rely on the alignment of the sentence itself.</li>
                    <li><strong>Numbers</strong> that appear on one side only.</li>
                    <li><strong>Repetitions</strong> in the target that the source does not have.</li>
                    <li><strong>Length ratio</strong> far outside what is usual in the corpus.</li>
                    <li><strong>Copies:</strong> the target is the untranslated source.</li>
                  </ul>

                  <h6>Formula</h6>
                  <div class="bg-light p-3 rounded mb-2">
                    <code>surprise(w) = −ln(1 − e(w)) − ln 5</code>, counted when positive<br>
                    <code>Consistency(S) = 1 / (1 + Σ surprises of the issues of S)</code>
                  </div>
                  <p class="small">
                    Where <code>e(w)</code> is the share of the sentences containing <code>w</code> in which a usual translation of
                    <code>w</code> appears on the other side. A missing translation only counts when <code>e(w)</code> is above 80%.
                    Open a sentence pair to see its issues.
                  </p>

                  <h6>Score range</h6>
                  <div class="d-flex flex-wrap align-items-center gap-2 mt-2">
                    <span class="badge bg-danger">&lt; 0.15 – Likely error</span>
                    <span class="badge bg-warning">0.15 – 0.25 – Worth a look</span>
                    <span class="badge bg-success">1.0 – Nothing found</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Alignment Detail Modal -->
    <div class="modal fade" id="alignmentModal" tabindex="-1" aria-labelledby="alignmentModalLabel" aria-hidden="true">
      <div class="modal-dialog modal-xl">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title" id="alignmentModalLabel">
              <i class="fas fa-align-justify me-2"></i>Alignment Details
            </h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body">
            <div class="row mb-3">
              <div class="col-md-6">
                <strong>ID:</strong> <span id="modal-alignment-id"></span>
              </div>
              <div class="col-md-6">
                <strong>Score:</strong> <span id="modal-alignment-score" class="badge bg-info"></span>
              </div>
            </div>
            <div class="row mb-3">
              <div class="col-12">
                <label class="form-label fw-bold">Source Text:</label>
                <div id="modal-source-text" class="p-3 bg-light border rounded"></div>
              </div>
            </div>
            <div class="row mb-3">
              <div class="col-12">
                <label class="form-label fw-bold">Target Text:</label>
                <div id="modal-target-text" class="p-3 bg-light border rounded"></div>
              </div>
            </div>
            <div class="row mb-3">
              <div class="col-12">
                <label class="form-label fw-bold">Unexpected Tokens:</label>
                <div id="modal-consistency" class="small"></div>
              </div>
            </div>
            <div class="row">
              <div class="col-12">
                <label class="form-label fw-bold">Alignment Visualization:</label>
                <div id="modal-alignment-viz" class="p-3 bg-white border rounded overflow-auto" style="font-family: monospace; max-height: 500px;">
                  <!-- Alignment visualization will be rendered here -->
                </div>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const sidebar = document.getElementById('sidebar-content');
  if (sidebar) {
    sidebar.innerHTML = `
     <div class="p-3">
      <h4>About Scores</h4>
      <p>
        Scores should indicate the <strong>quality/difficulty of translations</strong> in your project. 
        You can <strong>upload your own scores</strong> or use automatic ones based on metrics like 
        <em>perplexity</em>, <em>BLEU</em>, or any custom measure.
      </p>
      <p>
        <strong>Low scores mark translations worth reviewing.</strong> When extracting phrases, the
        score threshold collects only phrase pairs that occur <em>exclusively</em> in sentences scoring
        below it: pairs that also occur in a higher-scoring sentence are treated as trusted, which
        reduces the number of phrases to review.
      </p>
      <p>
        <strong>"Translation Difficulty"</strong> estimates how
        <strong>difficult a sentence is to translate</strong>, based on the <em>average ambiguity</em>
        (entropy of the aligned translations) of its words.
      </p>
    </div>
    `;
  }

  // Initialize chart variable
  const ctx = document.getElementById('scores-histogram').getContext('2d');
  let scoreChart;

  // Function to plot histogram
  async function plotScoresHistogram() {
    try {
      const binned = await getScores(projectId);

      if (!binned || binned.length === 0) {
        document.getElementById('histogram-container').innerHTML = `
          <div class="text-center text-muted py-5">
            <i class="fas fa-chart-bar fa-3x mb-3"></i>
            <p>No scores available for histogram</p>
          </div>
        `;
        return;
      }

      // Convert pyodide objects to plain JavaScript
      const field = (m, key) => (m.get ? m.get(key) : m[key]);
      const binnedObjects = binned.map(m => ({
        bin: field(m, 'bin'),
        end: field(m, 'end'),
        count: field(m, 'count'),
      }));

      const labels = binnedObjects.map(b => b.bin === b.end
        ? Number(b.bin).toFixed(2)
        : `${Number(b.bin).toFixed(2)}–${Number(b.end).toFixed(2)}`);
      const data = binnedObjects.map(b => b.count);

      // Destroy existing chart
      if (scoreChart) scoreChart.destroy();

      // Create new chart
      scoreChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            label: 'Sentence pairs',
            data,
            backgroundColor: '#8fb3e0',
            borderRadius: 3
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { 
              title: { display: true, text: 'Score' },
              grid: { display: false },
              ticks: {
                // the start of each range is enough on the axis
                callback: function(value) {
                  return String(this.getLabelForValue(value)).split('–')[0];
                }
              }
            },
            y: {
              title: { display: true, text: 'Sentence pairs' },
              beginAtZero: true,
              ticks: { precision: 0 }
            }
          },
          animation: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                title: (items) => `Score ${items[0].label}`,
                label: (context) => `${context.parsed.y.toLocaleString()} sentence pairs`
              }
            }
          }
        }
      });

    } catch (error) {
      console.error('Error plotting histogram:', error);
      document.getElementById('histogram-container').innerHTML = `
        <div class="alert alert-danger">
          Error loading histogram: ${escapeHtml(error.message)}
        </div>
      `;
    }
  }

  // File upload handler: one score per line, in corpus order
  document.getElementById("scores-file-input").addEventListener("change", async function(event) {
    const input = event.target;
    const file = input.files[0];
    if (!file) return;
    try {
      const lines = (await file.text()).split(/\r?\n/).map(line => line.trim()).filter(line => line !== '');
      const count = await runActivity(`Importing scores from ${file.name}`, () => importScoresFromFile(projectId, lines),
        { done: (n) => `Imported ${n.toLocaleString()} scores` });
      toast(`Imported ${count.toLocaleString()} scores from ${file.name}.`, "success");
      await plotScoresHistogram();
      await loadAlignments();
    } catch (error) {
      reportError(error);
    } finally {
      input.value = "";
    }
  });

  // Automatic scores: each runs as an activity with progress in the status bar
  const autoScores = [
    ["assign-difficulty-scores-btn", "Translation difficulty", assignAutoScores],
    ["assign-consistency-scores-btn", "Alignment consistency", assignConsistencyScores],
    ["assign-stability-scores-btn", "Alignment stability", assignStabilityScores],
  ];
  for (const [buttonId, name, assign] of autoScores) {
    bindAsyncButton(
      document.getElementById(buttonId),
      async () => {
        await runActivity(`Computing ${name.toLowerCase()} scores`, () => assign(projectId),
          { done: () => `${name} scores assigned` });
        toast(`${name} scores assigned; low scores are worth reviewing first.`, "success");
        await plotScoresHistogram();
        await loadAlignments();
      },
      "Computing…"
    );
  }

  // Refresh button
  bindAsyncButton(
    document.getElementById("refresh-scores-btn"),
    async () => {
      await plotScoresHistogram();
      await loadAlignments();
      console.log("Scores data refreshed");
    },
    ""
  );

  // Initial load
  await plotScoresHistogram();

  // Alignments pagination state
  let currentPage = 1;
  let pageSize = 30;
  let totalRecords = 0;
  let currentFilters = {
    minScore: null,
    maxScore: null,
    sortOrder: 'desc'
  };

  // Function to fetch and display alignments
  async function loadAlignments() {
    const tbody = document.getElementById('alignments-tbody');
    tbody.innerHTML = '<tr><td colspan="5" class="text-center"><i class="fas fa-spinner fa-spin me-2"></i>Loading...</td></tr>';

    try {
      
      const data = await getAlignmentsWithScores(projectId, currentPage, pageSize, currentFilters);
      totalRecords = data.total;

      // Update pagination info
      const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
      document.getElementById('current-page').textContent = currentPage;
      document.getElementById('total-pages').textContent = totalPages;
      document.getElementById('total-records').textContent = totalRecords.toLocaleString();

      // Update pagination buttons state
      document.getElementById('first-page-btn').disabled = currentPage === 1;
      document.getElementById('prev-page-btn').disabled = currentPage === 1;
      document.getElementById('next-page-btn').disabled = currentPage >= totalPages;
      document.getElementById('last-page-btn').disabled = currentPage >= totalPages;

      // Populate table
      if (data.alignments.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No alignments found</td></tr>';
        return;
      }

      tbody.innerHTML = data.alignments.map(row => {
        const scoreClass = row.score >= 0.7 ? 'success' : row.score >= 0.4 ? 'warning' : 'danger';
        return `
          <tr>
            <td>${row.id}</td>
            <td><span class="badge bg-${scoreClass}">${row.score ? row.score.toFixed(3) : 'N/A'}</span></td>
            <td class="text-truncate" style="max-width: 300px;" title="${escapeHtml(row.src_text_detok)}">${escapeHtml(row.src_text_detok)}</td>
            <td class="text-truncate" style="max-width: 300px;" title="${escapeHtml(row.tgt_text_detok)}">${escapeHtml(row.tgt_text_detok)}</td>
            <td>
              <button class="btn btn-sm btn-outline-primary view-alignment-btn" 
                      data-id="${row.id}"
                      data-src="${escapeHtml(row.src_text)}"
                      data-tgt="${escapeHtml(row.tgt_text)}"
                      data-align="${row.alignment || ''}"
                      data-score="${row.score || 0}">
                <i class="fas fa-eye me-1"></i>View
              </button>
            </td>
          </tr>
        `;
      }).join('');

      // Attach view button handlers
      document.querySelectorAll('.view-alignment-btn').forEach(btn => {
        btn.addEventListener('click', function() {
          showAlignmentModal(
            this.dataset.id,
            this.dataset.src,
            this.dataset.tgt,
            this.dataset.align,
            parseFloat(this.dataset.score)
          );
        });
      });

    } catch (error) {
      console.error('Error loading alignments:', error);
      tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger">Error: ${error.message}</td></tr>`;
    }
  }

  // Function to visualize alignment
  function visualizeAlignment(srcText, tgtText, alignmentStr) {
    if (!alignmentStr || !srcText || !tgtText) {
      return '<div class="text-muted">No alignment data available</div>';
    }

    const srcTokens = srcText.split(' ');
    const tgtTokens = tgtText.split(' ');
    const alignPairs = alignmentStr.split(' ').map(pair => {
      const [s, t] = pair.split('-').map(Number);
      return { src: s, tgt: t };
    }).filter(p => !isNaN(p.src) && !isNaN(p.tgt));

    // Create alignment matrix with better sizing
    let html = '<div style="overflow-x: auto;"><table class="table table-bordered table-sm align-middle" style="font-size: 0.8em; min-width: 100%; width: max-content;"><thead><tr><th style="position: sticky; left: 0; background: var(--surface); z-index: 10;"></th>';
    
    // Header row with target tokens
    tgtTokens.forEach((token, idx) => {
      if (token == "#NB") { token = "_"; }
      html += `<th class="text-center align-middle" style="min-width: 50px; max-width: 80px; padding: 8px 4px;">
                <div style="font-weight: bold;">${idx}</div>
                <div style="font-size: 0.9em; word-break: break-word;">${escapeHtml(token)}</div>
              </th>`;
    });
    html += '</tr></thead><tbody>';

    // Rows for source tokens
    srcTokens.forEach((srcToken, srcIdx) => {
      if (srcToken == "#NB") { srcToken = "_"; }
      html += `<tr><th style="position: sticky; left: 0; background: var(--surface); z-index: 5; min-width: 50px; max-width: 120px; padding: 8px;">
                 <div style="font-weight: bold;">${srcIdx}</div>
                 <div style="font-size: 0.9em; word-break: break-word;">${escapeHtml(srcToken)}</div>
               </th>`;
      tgtTokens.forEach((tgtToken, tgtIdx) => {
        const isAligned = alignPairs.some(p => p.src === srcIdx && p.tgt === tgtIdx);
        const bgClass = isAligned ? 'bg-primary text-white' : '';
        html += `<td class="text-center align-middle ${bgClass} align-cell" data-src="${srcIdx}" data-tgt="${tgtIdx}" style="padding: 12px 4px;">${isAligned ? '●' : ''}</td>`;
      });
      html += '</tr>';
    });
    
    html += '</tbody></table></div>';
    return html;
  }

  // Function to render interactive text with clickable words
  function renderInteractiveText(text, type) {
    const tokens = text.split(' ');
    return tokens.map((token, idx) => {

      if (token == "#NB") { return '_'; }  // Skip rendering for #NB tokens

      return `<span class="word-token ${type}-word" data-idx="${idx}" style="cursor: pointer; padding: 2px 4px; margin: 2px; border-radius: 3px; transition: background-color 0.2s;">${escapeHtml(token)}</span>`;
    }).join(' ');
  }

  // Show tokens flagged by the last consistency run and underline them in the texts
  async function showConsistencyDetails(id) {
    const container = document.getElementById('modal-consistency');
    container.innerHTML = '<span class="text-muted">Loading…</span>';
    try {
      const flagged = await explainConsistency(projectId, id);
      if (flagged === null) {
        container.innerHTML = '<span class="text-muted">Run <strong>Alignment consistency</strong> to see possible translation issues.</span>';
        return;
      }
      if (flagged.length === 0) {
        container.innerHTML = '<span class="text-success">No translation issues found.</span>';
        return;
      }
      container.innerHTML = `<ul class="list-unstyled mb-0 small">${flagged.map(f =>
        `<li class="mb-1"><i class="fas fa-circle-exclamation me-1 text-${f.anomaly >= 1 ? 'danger' : 'warning'}"></i>${escapeHtml(f.text)}</li>`
      ).join('')}</ul>`;
      for (const f of flagged) {
        if (f.index === null || f.index === undefined) continue;
        const el = document.querySelector(`.${f.side}-word[data-idx="${f.index}"]`);
        if (el) {
          el.style.textDecoration = 'underline wavy #dc3545';
          el.title = f.text;
        }
      }
    } catch (error) {
      console.error('Error explaining consistency:', error);
      container.innerHTML = `<span class="text-danger">Error: ${escapeHtml(error.message)}</span>`;
    }
  }

  // Function to show alignment modal
  function showAlignmentModal(id, srcText, tgtText, alignment, score) {
    document.getElementById('modal-alignment-id').textContent = id;
    document.getElementById('modal-alignment-score').textContent = score.toFixed(3);
    
    // Render interactive text
    document.getElementById('modal-source-text').innerHTML = renderInteractiveText(srcText, 'src');
    document.getElementById('modal-target-text').innerHTML = renderInteractiveText(tgtText, 'tgt');
    showConsistencyDetails(id);
    
    // Render raw alignment string above the visualization
    const alignmentDisplay = alignment || 'No alignment data';
    document.getElementById('modal-alignment-viz').innerHTML = `
      <div class="mb-3">
        <label class="form-label fw-bold small">Raw Alignment String:</label>
        <pre class="bg-light p-2 border rounded" style="font-size: 0.85em; overflow-x: auto;"><code>${escapeHtml(alignmentDisplay)}</code></pre>
      </div>
      ${visualizeAlignment(srcText, tgtText, alignment)}
    `;

    // Parse alignment pairs
    const alignPairs = alignment ? alignment.split(' ').map(pair => {
      const [s, t] = pair.split('-').map(Number);
      return { src: s, tgt: t };
    }).filter(p => !isNaN(p.src) && !isNaN(p.tgt)) : [];

    // Add click handlers for source words
    document.querySelectorAll('.src-word').forEach(word => {
      word.addEventListener('click', function() {
        const srcIdx = parseInt(this.dataset.idx);
        
        // Clear previous highlights
        document.querySelectorAll('.src-word, .tgt-word').forEach(w => {
          w.style.backgroundColor = '';
          w.style.fontWeight = '';
          w.style.color = ''; // back to the theme's text colour
        });
        document.querySelectorAll('.align-cell').forEach(cell => {
          cell.style.outline = '';
        });

        // Highlight clicked source word
        this.style.backgroundColor = '#ffc107';
        this.style.fontWeight = 'bold';
        this.style.color = '#212529'; // Keep dark text on yellow background

        // Find and highlight aligned target words
        const alignedTgtIndices = alignPairs
          .filter(p => p.src === srcIdx)
          .map(p => p.tgt);
        
        alignedTgtIndices.forEach(tgtIdx => {
          const tgtWord = document.querySelector(`.tgt-word[data-idx="${tgtIdx}"]`);
          if (tgtWord) {
            tgtWord.style.backgroundColor = '#28a745';
            tgtWord.style.fontWeight = 'bold';
            tgtWord.style.color = 'white';
          }
          
          // Highlight cells in matrix
          const cell = document.querySelector(`.align-cell[data-src="${srcIdx}"][data-tgt="${tgtIdx}"]`);
          if (cell) {
            cell.style.outline = '3px solid #ffc107';
          }
        });
      });
    });

    // Add click handlers for target words
    document.querySelectorAll('.tgt-word').forEach(word => {
      word.addEventListener('click', function() {
        const tgtIdx = parseInt(this.dataset.idx);
        
        // Clear previous highlights
        document.querySelectorAll('.src-word, .tgt-word').forEach(w => {
          w.style.backgroundColor = '';
          w.style.fontWeight = '';
          w.style.color = ''; // back to the theme's text colour
        });
        document.querySelectorAll('.align-cell').forEach(cell => {
          cell.style.outline = '';
        });

        // Highlight clicked target word
        this.style.backgroundColor = '#28a745';
        this.style.fontWeight = 'bold';
        this.style.color = 'white';

        // Find and highlight aligned source words
        const alignedSrcIndices = alignPairs
          .filter(p => p.tgt === tgtIdx)
          .map(p => p.src);
        
        alignedSrcIndices.forEach(srcIdx => {
          const srcWord = document.querySelector(`.src-word[data-idx="${srcIdx}"]`);
          if (srcWord) {
            srcWord.style.backgroundColor = '#ffc107';
            srcWord.style.fontWeight = 'bold';
            srcWord.style.color = '#212529'; // Keep dark text on yellow background
          }
          
          // Highlight cells in matrix
          const cell = document.querySelector(`.align-cell[data-src="${srcIdx}"][data-tgt="${tgtIdx}"]`);
          if (cell) {
            cell.style.outline = '3px solid #28a745';
          }
        });
      });
    });

    const modalElement = document.getElementById('alignmentModal');
    const modal = new bootstrap.Modal(modalElement, {
      focus: false  // Prevent Bootstrap from focusing the modal element
    });
    
    // Fix accessibility issue: ensure focus is managed properly when modal closes
    modalElement.addEventListener('hide.bs.modal', function() {
      // Blur focused element BEFORE modal starts hiding to prevent aria-hidden warning
      if (document.activeElement && modalElement.contains(document.activeElement)) {
        document.activeElement.blur();
      }
    }, { once: true });
    
    modal.show();
  }

  // Pagination button handlers
  document.getElementById('first-page-btn').addEventListener('click', () => {
    currentPage = 1;
    loadAlignments();
  });

  document.getElementById('prev-page-btn').addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      loadAlignments();
    }
  });

  document.getElementById('next-page-btn').addEventListener('click', () => {
    const totalPages = Math.ceil(totalRecords / pageSize);
    if (currentPage < totalPages) {
      currentPage++;
      loadAlignments();
    }
  });

  document.getElementById('last-page-btn').addEventListener('click', () => {
    currentPage = Math.ceil(totalRecords / pageSize);
    loadAlignments();
  });

  // Page size change handler
  document.getElementById('page-size').addEventListener('change', (e) => {
    pageSize = parseInt(e.target.value);
    currentPage = 1;
    loadAlignments();
  });

  // Filter handlers
  document.getElementById('apply-filters-btn').addEventListener('click', () => {
    const minScore = document.getElementById('min-score-filter').value;
    const maxScore = document.getElementById('max-score-filter').value;
    const sortOrder = document.getElementById('sort-order').value;

    currentFilters.minScore = minScore ? parseFloat(minScore) : null;
    currentFilters.maxScore = maxScore ? parseFloat(maxScore) : null;
    currentFilters.sortOrder = sortOrder;
    currentPage = 1;

    loadAlignments();
  });

  document.getElementById('reset-filters-btn').addEventListener('click', () => {
    document.getElementById('min-score-filter').value = '';
    document.getElementById('max-score-filter').value = '';
    document.getElementById('sort-order').value = 'desc';
    
    currentFilters = {
      minScore: null,
      maxScore: null,
      sortOrder: 'desc'
    };
    currentPage = 1;

    loadAlignments();
  });

  // Load alignments on initial page load
  await loadAlignments();
}