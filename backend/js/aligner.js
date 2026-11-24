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
import { stage, report, yieldToUI } from "../../ui/activity.js";
import { writeFileInChunks, wasmOutput } from "./utils.js";

const ALIGNMENT_LINE_RE = /^[0-9]+-[0-9]+(\s+[0-9]+-[0-9]+)*$/;

/**
 * Parse an alignment file into exactly `expected` lines, one per sentence pair.
 * Empty lines are kept: they are sentence pairs without any alignment point, and
 * dropping them would shift every following alignment onto the wrong sentence.
 * Anything after " ||| " (e.g. fast_align -s scores) is removed; invalid lines become "".
 */
function parseAlignmentLines(content, expected, label) {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop(); // trailing newline

  if (lines.length !== expected) {
    throw new Error(`${label}: expected ${expected} alignment lines, got ${lines.length}`);
  }

  return lines.map(line => {
    const links = line.split("|||")[0].trim();
    return links === "" || ALIGNMENT_LINE_RE.test(links) ? links : "";
  });
}

function getFastAlignChunkSize(numCores) {
    if (numCores >= 16) return 350000;
    if (numCores >= 8) return 250000;
    if (numCores >= 4) return 100000;
    return 100000;
}

// fast_align runs ITERATIONS EM iterations after an initial pass, and prints
// "INITIAL PASS", "ITERATION k" and "[n]" every 50,000 lines.
const FAST_ALIGN_ITERATIONS = 5;

/** Turns fast_align's output into progress (0..1) of one run over numLines. */
function fastAlignProgress(numLines) {
  let pass = 0;
  return (line) => {
    let m;
    if (/INITIAL PASS/.test(line)) {
      pass = 0;
    } else if ((m = line.match(/ITERATION (\d+)/))) {
      pass = parseInt(m[1], 10);
    } else if ((m = line.match(/\[(\d+)\]/))) {
      const within = Math.min(0.99, parseInt(m[1], 10) / Math.max(1, numLines));
      report((pass + within) / (FAST_ALIGN_ITERATIONS + 1));
      return;
    } else {
      return;
    }
    report(pass / (FAST_ALIGN_ITERATIONS + 1),
      pass === 0 ? "initial pass" : `iteration ${pass} of ${FAST_ALIGN_ITERATIONS}`);
  };
}

async function _computeAlignments(module, atoolsModule, srcLines, tgtLines, numCores) {
    const startTime = performance.now();
    
    // Validate input
    if (srcLines.length !== tgtLines.length) {
        throw new Error(`Source and target line counts must match (${srcLines.length} vs ${tgtLines.length})`);
    }

    const combinedFilename = "/parallel.txt";
    const forwardFile = "/forward.align";
    const reverseFile = "/reverse.align";
    const symFile = "/symmetric.align";

    await stage(0, 0.02, "Preparing corpus", async () => {
        // Combine into fast_align format
        const combinedLines = srcLines.map((src, i) => `${src} ||| ${tgtLines[i]}`);
        writeFileInChunks(module, combinedFilename, combinedLines);
        const sizeMB = combinedLines.reduce((n, l) => n + l.length + 1, 0) / 1024 / 1024;
        console.log(`Prepared ${srcLines.length.toLocaleString()} pairs (${sizeMB.toFixed(1)} MB)`);
    });

    const runFastAlign = async (outputFile, reverse, label) => {
        const started = performance.now();
        module.onFastAlignLine = fastAlignProgress(srcLines.length);
        try {
            await module.ccall("run_fast_align", "void", ["string", "string", "boolean", "number"], [
                combinedFilename, outputFile, reverse, numCores
            ], { async: true });
        } finally {
            module.onFastAlignLine = null;
        }
        const lines = parseAlignmentLines(module.FS.readFile(outputFile, { encoding: "utf8" }), srcLines.length, label);
        const seconds = ((performance.now() - started) / 1000).toFixed(1);
        console.log(`✅ ${label}: ${lines.filter(line => line).length.toLocaleString()} sentence pairs aligned (${seconds}s)`);
        return lines;
    };

    let forwardLines = await stage(0.02, 0.48, "Forward alignment",
        () => runFastAlign(forwardFile, false, "Forward alignment"));
    let reverseLines = await stage(0.48, 0.94, "Reverse alignment",
        () => runFastAlign(reverseFile, true, "Reverse alignment"));

    const resultLines = await stage(0.94, 1, "Symmetrizing", async () => {
        await yieldToUI();
        // atools skips (emits nothing for) pairs whose forward alignment is empty, so only
        // pass the others and put the symmetrized lines back at their original positions.
        const symIndices = [];
        for (let i = 0; i < forwardLines.length; i++) {
          if (forwardLines[i]) symIndices.push(i);
        }
        const result = new Array(srcLines.length).fill("");

        if (symIndices.length > 0) {
          // trailing "" so the file ends with a newline and the last line is read
          writeFileInChunks(atoolsModule, forwardFile, [...symIndices.map(i => forwardLines[i]), ""]);
          writeFileInChunks(atoolsModule, reverseFile, [...symIndices.map(i => reverseLines[i]), ""]);

          atoolsModule.ccall("run_atools", "void", ["string", "string", "string"], [
            forwardFile, reverseFile, symFile,
          ]);

          const symLines = parseAlignmentLines(
            atoolsModule.FS.readFile(symFile, { encoding: "utf8" }), symIndices.length, "symmetrized");
          symIndices.forEach((lineIdx, k) => { result[lineIdx] = symLines[k]; });

          atoolsModule.FS.unlink(forwardFile);
          atoolsModule.FS.unlink(reverseFile);
          atoolsModule.FS.unlink(symFile);
        }
        return result;
    });

    const totalDuration = ((performance.now() - startTime) / 1000).toFixed(1);
    const emptyCount = resultLines.filter(line => !line).length;
    console.log(`✅ Symmetrized ${resultLines.length.toLocaleString()} alignments (total ${totalDuration}s)` +
      (emptyCount ? `, ${emptyCount.toLocaleString()} pairs without alignment points` : ""));

    // free up memory and resources
    module.FS.unlink(combinedFilename);
    module.FS.unlink(forwardFile);
    module.FS.unlink(reverseFile);
    forwardLines = null;
    reverseLines = null;

    return resultLines;
}

/** Word alignments for the sentence pairs. Progress: 0..1 of the current stage. */
export async function computeAlignments(srcLines, tgtLines) {
  const numCores = parseInt(document.getElementById("num-cores-input")?.value) || window.navigator.hardwareConcurrency || 1;

  const { module: initialModule, atoolsModule: initialAtools, poolSize } = await stage(0, 0.03, "Loading alignment modules", async () => {
    const { createModule: createFastAlign, config: fastAlignConfig } = await window.WasmModuleLoader.loadFastAlign();
    const poolSize = Math.min(fastAlignConfig.poolSize, numCores);

    // fast_align's output is followed for progress: the module is created once,
    // so the handler is looked up per line (set per run in _computeAlignments).
    let module = null;
    module = await createFastAlign({
      pthreadPoolSize: poolSize,
      locateFile: (file) => `/backend/fast_align/${file}`,
      ...wasmOutput("fast_align", (line) => module && module.onFastAlignLine && module.onFastAlignLine(line)),
    });

    const { createModule: createAtools } = await window.WasmModuleLoader.loadAtools();
    const atoolsModule = await createAtools({
      pthreadPoolSize: poolSize,
      locateFile: (file) => `/backend/fast_align/${file}`,
      ...wasmOutput("atools"),
    });
    console.log(`✅ Alignment modules loaded (${poolSize} threads)`);
    return { module, atoolsModule, poolSize };
  });
  let module = initialModule;
  let atoolsModule = initialAtools;

  const CHUNK_SIZE = getFastAlignChunkSize(poolSize);
  const totalChunks = Math.ceil(srcLines.length / CHUNK_SIZE);
  let resultLines = [];

  await stage(0.03, 1, "", async () => {
    // Process chunks sequentially
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      const startIdx = chunkIndex * CHUNK_SIZE;
      const endIdx = Math.min(startIdx + CHUNK_SIZE, srcLines.length);
      const label = totalChunks > 1 ? `Part ${chunkIndex + 1} of ${totalChunks}` : "";
      if (totalChunks > 1) {
        console.log(`⚙️ Aligning part ${chunkIndex + 1}/${totalChunks} (${(endIdx - startIdx).toLocaleString()} pairs)`);
      }

      const resultChunk = await stage(chunkIndex / totalChunks, (chunkIndex + 1) / totalChunks, label, () =>
        _computeAlignments(module, atoolsModule, srcLines.slice(startIdx, endIdx), tgtLines.slice(startIdx, endIdx), poolSize));
      resultLines = resultLines.concat(resultChunk);
      await yieldToUI();
    }
  });

  // Clean up WASM modules
  if (module?._free) {
    try { module._free(); } catch (e) { console.warn('FastAlign cleanup error:', e); }
  }
  if (atoolsModule?._free) {
    try { atoolsModule._free(); } catch (e) { console.warn('ATools cleanup error:', e); }
  }
  module = null;
  atoolsModule = null;

  return resultLines;
}

async function createProjectInSQLite(name) {
    const pyodide = await initPyodide();
    pyodide.globals.set("project_name", name || "Project");
    const projectId = await pyodide.runPythonAsync(`
        from projects import create_project
        create_project(project_name)
    `);
    await safeSyncfs(pyodide);
    console.log(`✅ Project created (ID: ${projectId})`);
    return projectId;
}

// Rows per database call when storing or updating alignments: small enough to
// keep the page responsive and report progress in between.
const DB_CHUNK = 20000;

/** Create a project with the given sentence pairs. Progress: 0..1 of the current stage. */
export async function storeAlignments(srcLines, tgtLines, alignLines, scoreLines, name = "Project") {
    const projectId = await createProjectInSQLite(name);
    const pyodide = await initPyodide();
    pyodide.globals.set("project_id", projectId);

    const storeStart = performance.now();
    for (let start = 0; start < srcLines.length; start += DB_CHUNK) {
      const end = Math.min(start + DB_CHUNK, srcLines.length);
      report(start / srcLines.length, `${start.toLocaleString()} of ${srcLines.length.toLocaleString()} sentence pairs`);
      await yieldToUI();
      pyodide.globals.set("chunk_args", pyodide.toPy([
        srcLines.slice(start, end), tgtLines.slice(start, end),
        alignLines.slice(start, end), scoreLines.slice(start, end), start,
      ]));
      await pyodide.runPythonAsync(`
        from projects import save_alignments
        save_alignments(project_id, *chunk_args)
        del chunk_args
      `);
    }
    report(0.95, "writing to browser storage");
    await yieldToUI();
    await safeSyncfs(pyodide);
    console.log(`💾 Stored ${srcLines.length.toLocaleString()} sentence pairs (${((performance.now() - storeStart) / 1000).toFixed(1)}s)`);

    await pyodide.runPythonAsync(`
        import gc
        gc.collect()
    `);
    return projectId;
}

/** Realign all sentence pairs of a project. Progress: 0..1 of the current stage. */
export async function recomputeAlignments(project_id) {
    const pyodide = await initPyodide();
    pyodide.globals.set("project_id", project_id);

    const dataObj = await stage(0, 0.05, "Loading sentences", async () => {
      const response = await pyodide.runPythonAsync(`
          from projects import get_project_data_for_alignments
          get_project_data_for_alignments(project_id)
      `);
      const data = response.toJs({ dict_converter: Object.fromEntries });
      response.destroy();
      console.log(`📊 Loaded ${data.lines1.length.toLocaleString()} pairs from project ${project_id}`);
      return data;
    });

    const alignments = await stage(0.05, 0.9, "Aligning", () => computeAlignments(dataObj.lines1, dataObj.lines2));

    await stage(0.9, 1, "Saving alignments", async () => {
      const updateStart = performance.now();
      const n = alignments.length;
      for (let start = 0; start < n; start += DB_CHUNK) {
        const end = Math.min(start + DB_CHUNK, n);
        report(start / n, `${start.toLocaleString()} of ${n.toLocaleString()} sentence pairs`);
        await yieldToUI();
        pyodide.globals.set("chunk_args", pyodide.toPy([alignments.slice(start, end), dataObj.row_ids.slice(start, end)]));
        await pyodide.runPythonAsync(`
          from projects import update_alignments
          update_alignments(project_id, *chunk_args)
          del chunk_args
        `);
      }
      report(0.95, "writing to browser storage");
      await safeSyncfs(pyodide);
      console.log(`✅ Recomputed ${n.toLocaleString()} alignments (saved in ${((performance.now() - updateStart) / 1000).toFixed(1)}s)`);
    });
    return true;
}
