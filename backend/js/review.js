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

/* Word-level consistency review and phrase table export (backend/py/review.py). */

import { initPyodide } from "../../pyodide.js";
import { downloadBlob } from "./utils.js";

/**
 * One page of the word table, with summary and chart data.
 * params: project_id, side ('src'|'tgt'), start, length, search, sort
 * ('suspicious'|'consistency'|'frequency'|'alpha'), suspicious_only,
 * min_total, include_hidden.
 */
export async function fetchWordOverview(params) {
  const pyodide = await initPyodide();
  pyodide.globals.set("wo_args", pyodide.toPy({
    project_id: parseInt(params.project_id),
    side: params.side === "tgt" ? "tgt" : "src",
    start: parseInt(params.start) || 0,
    length: parseInt(params.length) || 25,
    search: String(params.search || ""),
    sort: String(params.sort || "suspicious"),
    suspicious_only: Boolean(params.suspicious_only),
    min_total: parseInt(params.min_total) || 1,
    include_hidden: Boolean(params.include_hidden),
  }));
  try {
    const json = await pyodide.runPythonAsync(`
import json
from review import word_overview
json.dumps(await word_overview(**wo_args), ensure_ascii=False)
`);
    return JSON.parse(json);
  } finally {
    pyodide.globals.delete("wo_args");
  }
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
