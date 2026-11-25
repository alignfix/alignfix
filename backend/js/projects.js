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

import { initPyodide } from "../../pyodide.js";
import { safeSyncfs } from "./storage.js";
import { downloadBlob, safeFilename } from "./utils.js";

/** The project with this id, or null if there is none. */
export async function getProject(id) {

  const pyodide = await initPyodide();

  pyodide.globals.set("id", parseInt(id));

  const response = await pyodide.runPythonAsync(`
      import json
      from projects import get_project

      res = get_project(id)
      json.dumps(res)
  `);

  
  const res = JSON.parse(response);
  return res;
}

export async function updateProjectStats(project_id, stats) {
  const statsStr = JSON.stringify(stats);

  const pyodide = await initPyodide();
  pyodide.globals.set("project_id", project_id);
  pyodide.globals.set("stats", statsStr);

  await pyodide.runPythonAsync(`
      import json
      from projects import update_project_stats
      data = json.loads(stats)
      update_project_stats(project_id, data)
  `);

  await safeSyncfs(pyodide);

  return;
}

export async function mergeProjectStats(project_id, new_stats) {
  const pyodide = await initPyodide();
  const new_stats_str = JSON.stringify(new_stats);
  pyodide.globals.set("project_id", project_id);
  pyodide.globals.set("new_stats", new_stats_str);

  await pyodide.runPythonAsync(`
      import json
      from projects import merge_project_stats
      data = json.loads(new_stats)
      merge_project_stats(project_id, data)
  `);

  await safeSyncfs(pyodide);

  return;
}

export async function saveProject(project_id) {

  const pyodide = await initPyodide();

  const name = document.getElementById("document_name").value;
  pyodide.globals.set("name", name);
  pyodide.globals.set("project_id", project_id);

  await pyodide.runPythonAsync(`
      from projects import update_project_name
      update_project_name(project_id, name)
  `);

  await safeSyncfs(pyodide);
  
  return true;
}

/** Delete a project (the caller asks for confirmation). */
export async function deleteProject(projectId) {
    const pyodide = await initPyodide();
    pyodide.globals.set("project_id", projectId);
    await pyodide.runPythonAsync(`
        from projects import delete_project
        delete_project(project_id)
    `);
    await safeSyncfs(pyodide);
    console.log(`Project ${projectId} deleted`);
}

const tsvCell = (v) => String(v ?? "").replace(/[\t\r\n]+/g, " ");
const tsv = (header, rows) => [header.join("\t"), ...rows.map(r => header.map(k => tsvCell(r[k])).join("\t"))].join("\n") + "\n";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function reportText(s, options) {
  const lines = [
    `AlignFix export of "${s.project}"`,
    `Exported ${new Date().toISOString().slice(0, 19).replace("T", " ")} (project created ${s.created_at || "?"})`,
    "",
    `Imported sentence pairs:  ${s.imported_pairs}`,
    `Deleted:                  ${s.deleted_pairs}`,
    `Edited:                   ${s.edited_pairs}`,
    `Added (augmentation):     ${s.added_pairs}`,
    `Exported sentence pairs:  ${s.exported_pairs}`,
    "",
    `Review: ${plural(s.review_marked_ok_pairs, "sentence pair")} checked and marked OK.`,
    `Glossary: ${plural(s.glossary_entries, "confirmed translation pair")}.`,
  ];
  const names = { delete: "Deleted", edit: "Edited", add: "Added" };
  for (const action of ["delete", "edit", "add"]) {
    const reasons = s.reasons?.[action];
    if (!reasons || !Object.keys(reasons).length) continue;
    lines.push("", `${names[action]}, by reason:`);
    for (const [reason, n] of Object.entries(reasons)) lines.push(`  ${String(n).padStart(7)}  ${reason}`);
  }
  if (s.split) {
    lines.push("", `Split (seed ${s.split.seed}): train ${s.split.train || 0}, dev ${s.split.dev || 0}, test ${s.split.test || 0} pairs.`,
      "No source or target sentence occurs in two parts (compared without case, spacing and punctuation).");
  }
  lines.push("", "Files",
    "  lines1.txt, lines2.txt   source and target, one sentence per line",
    "  alignments.txt           word alignments (Pharaoh format), line by line",
    "  line_origins.tsv         for every exported line: its line in the uploaded files and whether it was",
    "                           edited or added (an added pair points to the line it was copied from)",
    "  changes.tsv              every change: step, date, action, reason, line, text before and after",
    "  fixes.json               the find & fix and augmentation rules (History page)",
    "  glossary.tsv             the confirmed translation pairs (source<TAB>target)");
  if (s.split) lines.push("  split/*.src, *.tgt       the parts; split/*.lines: original line of each pair");
  return lines.join("\n") + "\n";
}

/**
 * Download the corpus as .zip: texts, alignments, change report and line origins;
 * with options.devSize / options.testSize also a train/dev/test split (options.seed).
 */
export async function downloadProject(project_id, options = {}) {
  const pyodide = await initPyodide();
  const args = [parseInt(project_id), parseInt(options.devSize) || 0, parseInt(options.testSize) || 0,
                parseInt(options.seed) || 1];
  pyodide.globals.set("dl_args", pyodide.toPy(args));
  let data, fixes, project;
  try {
    const json = await pyodide.runPythonAsync(`
import json
from export import corpus_export
from projects import get_project
from fixes import get_fixes
json.dumps({"export": corpus_export(*dl_args), "project": get_project(dl_args[0]),
            "fixes": get_fixes(dl_args[0])}, ensure_ascii=False)
`);
    ({ export: data, fixes, project } = JSON.parse(json));
  } finally {
    pyodide.globals.delete("dl_args");
  }

  const zip = new JSZip();
  zip.file("lines1.txt", data.lines1.join("\n"));
  zip.file("lines2.txt", data.lines2.join("\n"));
  zip.file("alignments.txt", data.alignments.join("\n"));
  zip.file("fixes.json", JSON.stringify(fixes, null, 2));
  zip.file("line_origins.tsv", tsv(["line", "original_line", "status"], data.provenance));
  zip.file("changes.tsv", tsv(["step", "date", "action", "reason", "original_line", "copied_from",
    "old_source", "old_target", "new_source", "new_target"], data.changes));
  zip.file("report.txt", reportText(data.summary, options));
  zip.file("glossary.tsv", tsv(["src", "tgt"], data.glossary));
  if (data.split) {
    for (const part of ["train", "dev", "test"]) {
      const idx = data.split.flatMap((p, i) => (p === part ? [i] : []));
      zip.file(`split/${part}.src`, idx.map(i => data.lines1[i]).join("\n"));
      zip.file(`split/${part}.tgt`, idx.map(i => data.lines2[i]).join("\n"));
      zip.file(`split/${part}.lines`, idx.map(i => data.provenance[i].original_line).join("\n"));
    }
  }
  const zipBlob = await zip.generateAsync({ type: "blob" });

  // e.g. "corpus_de-en_2026-11-24.zip" (':' of the time is not allowed in file names)
  const date = String(project?.created_at || "").slice(0, 10);
  downloadBlob(zipBlob, `${safeFilename(project?.name, `project_${project_id}`)}${date ? "_" + date : ""}.zip`);
  return data.summary;
}

export async function downloadBinaryProject(project_id) {
  // get binary data for download
  const pyodide = await initPyodide();

  pyodide.globals.set("project_id", project_id);
  
  const binaryData = await pyodide.runPythonAsync(`
      from binary import get_project_data_for_binary_download
      data = get_project_data_for_binary_download(project_id)
      data
  `);

  const uint8Array = binaryData.toJs();
  binaryData.destroy?.();

  const blob = new Blob([uint8Array], { type: 'application/octet-stream' });
  const project = await getProject(project_id).catch(() => null);
  downloadBlob(blob, `${safeFilename(project?.name, `project_${project_id}`)}.algf`);
}

export async function importBinaryProject(file) {
  const pyodide = await initPyodide();

  const arrayBuffer = await file.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);

  pyodide.globals.set("binary_data", uint8Array);

  const project_id = await pyodide.runPythonAsync(`
      from binary import import_project_data_from_binary
      project_id = import_project_data_from_binary(binary_data)
      project_id
  `);

  await safeSyncfs(pyodide);

  return project_id;
}