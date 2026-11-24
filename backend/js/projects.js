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

export async function downloadProject(project_id) {
  // get lines1, lines2 and create a blob for download, put two files in a zip and download
  const pyodide = await initPyodide();

  pyodide.globals.set("project_id", project_id);
  
  const response = await pyodide.runPythonAsync(`
      from projects import get_project_data_for_download
      data = get_project_data_for_download(project_id)
      data
  `);

  const dataObj = response.toJs({ dict_converter: Object.fromEntries });

  const lines1_str = dataObj.lines1.join("\n");
  const lines2_str = dataObj.lines2.join("\n");
  const alignments_str = dataObj.alignments.join("\n");
  
  const fixesArr = (dataObj.fixes || []).map(fix =>
    fix instanceof Map ? Object.fromEntries(fix) : fix
  );
  const fixes_str = JSON.stringify(fixesArr, null, 2);

  // create blobs for the two files
  const blob1 = new Blob([lines1_str], { type: 'text/plain' });
  const blob2 = new Blob([lines2_str], { type: 'text/plain' });
  const blob_alignments = new Blob([alignments_str], { type: 'text/plain' });
  const blob3 = new Blob([fixes_str], { type: 'application/json' });

  // create a zip file with the two blobs
  const zip = new JSZip();
  zip.file("lines1.txt", blob1);
  zip.file("lines2.txt", blob2);
  zip.file("alignments.txt", blob_alignments);
  zip.file("fixes.json", blob3);
  const zipBlob = await zip.generateAsync({ type: "blob" });

  // e.g. "corpus_de-en_2026-11-24.zip" (':' of the time is not allowed in file names)
  const date = String(dataObj.project.created_at || "").slice(0, 10);
  downloadBlob(zipBlob, `${safeFilename(dataObj.project.name, `project_${project_id}`)}${date ? "_" + date : ""}.zip`);
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