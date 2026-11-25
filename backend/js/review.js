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

/* Translation issues review and phrase table export (backend/py/review.py). */

import { initPyodide } from "../../pyodide.js";
import { downloadBlob, safeFilename } from "./utils.js";

async function callReview(fn, args) {
  const pyodide = await initPyodide();
  pyodide.globals.set("rv_args", pyodide.toPy(args));
  try {
    const json = await pyodide.runPythonAsync(`
import json, inspect
import review
rv_result = review.${fn}(**rv_args)
if inspect.isawaitable(rv_result):
    rv_result = await rv_result
json.dumps(rv_result, ensure_ascii=False)
`);
    return JSON.parse(json);
  } finally {
    pyodide.globals.delete("rv_args");
  }
}

function filters(params) {
  return {
    project_id: parseInt(params.project_id),
    search: String(params.search || ""),
    min_level: ["high", "medium", "low"].includes(params.min_level) ? params.min_level : "medium",
    kind: String(params.kind || ""),
    side: ["src", "tgt"].includes(params.side) ? params.side : "",
  };
}

const STATUSES = ["open", "ok", "all"];

/**
 * One page of the issue list with the project summary.
 * params: project_id, view ('sentences'|'words'), start, length, search,
 * min_level ('high'|'medium'|'low'), kind, side ('src'|'tgt'|''),
 * status ('open': not marked OK | 'ok' | 'all').
 */
export function fetchReviewOverview(params) {
  return callReview("review_overview", {
    ...filters(params),
    view: params.view === "words" ? "words" : "sentences",
    start: parseInt(params.start) || 0,
    length: parseInt(params.length) || 25,
    status: STATUSES.includes(params.status) ? params.status : "open",
  });
}

/** Mark sentence pairs OK (ok = false: remove the mark). Returns the number changed. */
export function markPairs(project_id, rowIds, ok = true) {
  return callReview("mark_pairs", { project_id: parseInt(project_id), row_ids: rowIds.map(Number), ok: !!ok });
}

/** Mark every open pair matching the filters OK. */
export function markAllPairs(params) {
  const { project_id, search, min_level, kind, side } = filters(params);
  return callReview("mark_all", { project_id, search, min_level, kind, side, ok: true });
}

/** Mark a word OK: it is not flagged any more (it stays in the phrase table). */
export function markWord(project_id, side, word, ok = true) {
  return callReview("mark_word", {
    project_id: parseInt(project_id), side: side === "tgt" ? "tgt" : "src", word: String(word), ok: !!ok,
  });
}

/**
 * Download the entries matching the filters (all pages) as CSV or JSON.
 * Returns the number of entries written.
 */
export async function downloadReview(params, format = "csv", projectName = "") {
  const view = params.view === "words" ? "words" : "sentences";
  const rows = await callReview("review_export", {
    ...filters(params), view, status: STATUSES.includes(params.status) ? params.status : "open",
  });
  if (!rows.length) return 0;
  const base = `${safeFilename(projectName, `project_${params.project_id}`)}_review_${view}`;
  if (format === "json") {
    downloadBlob(new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" }), `${base}.json`);
  } else {
    const header = Object.keys(rows[0]);
    const csv = [header.join(","), ...rows.map(r => header.map(k => csvCell(r[k])).join(","))].join("\n");
    downloadBlob(new Blob(["\ufeff" + csv + "\n"], { type: "text/csv;charset=utf-8" }), `${base}.csv`);
  }
  return rows.length;
}

/** The flagged sentence pairs of one word. */
export function fetchWordExamples(project_id, side, word) {
  return callReview("word_examples", {
    project_id: parseInt(project_id), side: side === "tgt" ? "tgt" : "src", word: String(word),
  });
}

/** The phrase table summarised per source phrase (see review.phrase_table). */
export async function getPhraseTable(project_id, { minTotal = 1, topK = 5 } = {}) {
  const pyodide = await initPyodide();
  pyodide.globals.set("pt_args", pyodide.toPy([parseInt(project_id), parseInt(minTotal) || 1, parseInt(topK) || 5]));
  try {
    const json = await pyodide.runPythonAsync(`
import json
from review import phrase_table
json.dumps(phrase_table(*pt_args), ensure_ascii=False)
`);
    return JSON.parse(json);
  } finally {
    pyodide.globals.delete("pt_args");
  }
}

function csvCell(value) {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(rows) {
  const header = ["src", "total", "top_tgt", "top_share", "num_tgts", "entropy", "alternatives"];
  const lines = rows.map(r => [
    r.src, r.total, r.top_tgt, r.top_share, r.num_tgts, r.entropy,
    r.alternatives.map(a => `${a.tgt} (${a.count})`).join(" | "),
  ].map(csvCell).join(","));
  return "﻿" + [header.join(","), ...lines].join("\n") + "\n";
}

/**
 * Download the phrase table. format 'csv' | 'json'; part 'all' | 'sure'
 * (top translation share >= sureShare) | 'dubious' (below it).
 * Returns the number of rows written.
 */
export async function downloadPhraseTable(project_id, { format = "csv", part = "all", minTotal = 1, sureShare = 0.75 } = {}) {
  let rows = await getPhraseTable(project_id, { minTotal });
  if (part === "sure") rows = rows.filter(r => r.top_share >= sureShare);
  else if (part === "dubious") rows = rows.filter(r => r.top_share < sureShare);
  if (!rows.length) return 0;
  const suffix = part === "all" ? "" : `_${part}`;
  const blob = format === "json"
    ? new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" })
    : new Blob([toCSV(rows)], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, `phrase_table_project_${project_id}${suffix}.${format}`);
  return rows.length;
}
