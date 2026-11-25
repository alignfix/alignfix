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


/* The glossary of confirmed translation pairs (backend/py/glossary.py). */

import { initPyodide } from "../../pyodide.js";
import { safeSyncfs } from "./storage.js";
import { downloadBlob, safeFilename } from "./utils.js";

let callCounter = 0;

async function call(fn, args, { write = false } = {}) {
  const pyodide = await initPyodide();
  // a name per call: calls can overlap (one waits for storage while another starts)
  const name = `gl_args_${++callCounter}`;
  pyodide.globals.set(name, pyodide.toPy(args));
  let json;
  try {
    json = await pyodide.runPythonAsync(`
import json
import glossary
json.dumps(glossary.${fn}(*${name}), ensure_ascii=False)
`);
  } catch (err) {
    const match = /ValueError: (.*)/.exec(err.message || "");
    throw match ? new Error(match[1]) : err;
  } finally {
    pyodide.globals.delete(name);
  }
  if (write) await safeSyncfs(pyodide);
  return JSON.parse(json);
}

/** One page for a DataTable: data = { project_id, start, length, search: { value }, draw }. */
export async function fetchGlossary(data) {
  const [rows, total, filtered] = await call("fetch", [
    parseInt(data.project_id), parseInt(data.start) || 0, parseInt(data.length) || 10, String(data.search?.value || ""),
  ]);
  return { draw: data.draw, recordsTotal: total, recordsFiltered: filtered, data: rows };
}

/** Confirm a phrase pair of the phrase table. Returns 1 if it was new. */
export function addPhraseToGlossary(project_id, phrase_id) {
  return call("add_phrase_pair", [parseInt(project_id), parseInt(phrase_id)], { write: true });
}

/** Add pairs typed as text: [[src, tgt], ...]. Returns the number of new entries. */
export function addGlossaryPairs(project_id, pairs, origin = "manual") {
  return call("add_text_pairs", [parseInt(project_id), pairs.map(([s, t]) => [String(s), String(t)]), origin],
    { write: true });
}

export function removeGlossaryEntry(project_id, entry_id) {
  return call("remove_entry", [parseInt(project_id), parseInt(entry_id)], { write: true });
}

/** Remove all entries of a term on one side ('src' | 'tgt'), as Review lists it. */
export function removeGlossaryTerm(project_id, side, term) {
  return call("remove_term", [parseInt(project_id), side === "tgt" ? "tgt" : "src", String(term)], { write: true });
}

export function clearGlossary(project_id) {
  return call("clear", [parseInt(project_id)], { write: true });
}

export function countGlossary(project_id) {
  return call("count", [parseInt(project_id)]);
}

/** Import a glossary file (source<TAB>target lines, or JSON [{src, tgt}]). Returns { read, added }. */
export async function importGlossaryFile(project_id, content) {
  const [read, added] = await call("import_file", [parseInt(project_id), String(content)], { write: true });
  return { read, added };
}

/** Download the glossary as TSV (source<TAB>target) or JSON. Returns the number of entries. */
export async function downloadGlossary(project_id, format = "tsv", projectName = "") {
  const entries = await call("export_entries", [parseInt(project_id)]);
  if (!entries.length) return 0;
  const base = `${safeFilename(projectName, `project_${project_id}`)}_glossary`;
  if (format === "json") {
    downloadBlob(new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" }), `${base}.json`);
  } else {
    const clean = (s) => String(s).replace(/[\t\r\n]+/g, " ");
    const text = ["src\ttgt", ...entries.map(e => `${clean(e.src)}\t${clean(e.tgt)}`)].join("\n") + "\n";
    downloadBlob(new Blob([text], { type: "text/tab-separated-values;charset=utf-8" }), `${base}.tsv`);
  }
  return entries.length;
}
