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
import { nextFrame } from "../../ui/utils.js";
import { writeFileInChunks } from "./utils.js";

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

async function _computeAlignments(module, atoolsModule, srcLines, tgtLines, numCores) {
    const startTime = performance.now();
    
    // Validate input
    if (srcLines.length !== tgtLines.length) {
        console.error(`❌ Input mismatch: ${srcLines.length} source vs ${tgtLines.length} target lines`);
        throw new Error('Source and target line counts must match');
    }

    console.log('operation:Preparing corpus');
    console.log('progress:5');
    
    // Combine into fast_align format
    const combinedLines = srcLines.map((src, i) => `${src} ||| ${tgtLines[i]}`);
    const combinedFilename = "/parallel.txt";
    const corpusSizeMB = (combinedLines.join('\n').length / 1024 / 1024).toFixed(1);
    
    writeFileInChunks(module, combinedFilename, combinedLines);
    console.log(`Prepared ${srcLines.length.toLocaleString()} pairs (${corpusSizeMB}MB)`);
    console.log('progress:15');

    const forwardFile = "/forward.align";
    const reverseFile = "/reverse.align";
    const symFile = "/symmetric.align";

    console.log('operation:Computing forward alignments');
    console.log('progress:20');
    await nextFrame();
    
    const forwardStart = performance.now();
    await module.ccall("run_fast_align", "void", ["string", "string", "boolean", "number"], [
      combinedFilename, forwardFile, false, numCores
    ], { async: true });
    const forwardDuration = ((performance.now() - forwardStart) / 1000).toFixed(1);
    
    let forwardLines = parseAlignmentLines(module.FS.readFile(forwardFile, { encoding: "utf8" }), srcLines.length, "forward");
    let forwardAlignCount = forwardLines.filter(line => line).length;
    console.log(`✅ Forward: ${forwardAlignCount.toLocaleString()} alignments (${forwardDuration}s)`);
    console.log('progress:45');

    console.log('operation:Computing reverse alignments');
    console.log('progress:50');
    await nextFrame();
    
    const reverseStart = performance.now();
    await module.ccall("run_fast_align", "void", ["string", "string", "boolean", "number"], [
      combinedFilename, reverseFile, true, numCores
    ], { async: true });
    const reverseDuration = ((performance.now() - reverseStart) / 1000).toFixed(1);
    
    let reverseLines = parseAlignmentLines(module.FS.readFile(reverseFile, { encoding: "utf8" }), srcLines.length, "reverse");
    let reverseAlignCount = reverseLines.filter(line => line).length;
    console.log(`✅ Reverse: ${reverseAlignCount.toLocaleString()} alignments (${reverseDuration}s)`);
    console.log('progress:75');

    console.log('operation:Symmetrizing alignments');
    console.log('progress:80');
    await nextFrame();

    const symStart = performance.now();
    // atools skips (emits nothing for) pairs whose forward alignment is empty, so only
    // pass the others and put the symmetrized lines back at their original positions.
    const symIndices = [];
    for (let i = 0; i < forwardLines.length; i++) {
      if (forwardLines[i]) symIndices.push(i);
    }
    const resultLines = new Array(srcLines.length).fill("");

    let resultContent = null;
    if (symIndices.length > 0) {
      // trailing "" so the file ends with a newline and the last line is read
      writeFileInChunks(atoolsModule, forwardFile, [...symIndices.map(i => forwardLines[i]), ""]);
      writeFileInChunks(atoolsModule, reverseFile, [...symIndices.map(i => reverseLines[i]), ""]);

      atoolsModule.ccall("run_atools", "void", ["string", "string", "string"], [
        forwardFile, reverseFile, symFile,
      ]);

      resultContent = atoolsModule.FS.readFile(symFile, { encoding: "utf8" });
      const symLines = parseAlignmentLines(resultContent, symIndices.length, "symmetrized");
      symIndices.forEach((lineIdx, k) => { resultLines[lineIdx] = symLines[k]; });
    }
    const symDuration = ((performance.now() - symStart) / 1000).toFixed(1);
    
    const totalDuration = ((performance.now() - startTime) / 1000).toFixed(1);
    const emptyCount = resultLines.filter(line => !line).length;
    console.log(`✅ Symmetrized: ${resultLines.length.toLocaleString()} final alignments (${symDuration}s, total ${totalDuration}s)` +
      (emptyCount ? `, ${emptyCount.toLocaleString()} pairs without alignment points` : ""));
    console.log('progress:100');

    // free up memory and resources
    module.FS.unlink(combinedFilename);
    module.FS.unlink(forwardFile);
    module.FS.unlink(reverseFile);
    if (symIndices.length > 0) {
      atoolsModule.FS.unlink(forwardFile);
      atoolsModule.FS.unlink(reverseFile);
      atoolsModule.FS.unlink(symFile);
    }

    // Clear large variables to help GC
    forwardLines = null;
    reverseLines = null;
    reverseAlignCount = null;
    forwardAlignCount = null;
    resultContent = null;

    return resultLines;
}

export async function computeAlignments(srcLines, tgtLines) {
  console.log('operation:Loading alignment modules');
  console.log('progress:0');
  
  const { createModule: createFastAlign, config: fastAlignConfig } = await window.WasmModuleLoader.loadFastAlign();
  const numCores = parseInt(document.getElementById("num-cores-input")?.value) || window.navigator.hardwareConcurrency || 1;
  const poolSize = Math.min(fastAlignConfig.poolSize, numCores);
  
  const CHUNK_SIZE = getFastAlignChunkSize(poolSize);
  const totalChunks = Math.ceil(srcLines.length / CHUNK_SIZE);
  
  let module = await createFastAlign({
    pthreadPoolSize: poolSize,
    locateFile: (file) => `/backend/fast_align/${file}`
  });

  const { createModule: createAtools, config: atoolsConfig } = await window.WasmModuleLoader.loadAtools();
  let atoolsModule = await createAtools({ 
    pthreadPoolSize: poolSize, 
    locateFile: (file) => `/backend/fast_align/${file}`
  });
  
  console.log(`✅ Alignment modules loaded (${poolSize} threads)`);
  console.log('progress:5');
  await nextFrame();

  let resultLines = [];
  
  // Process chunks sequentially
  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const startIdx = chunkIndex * CHUNK_SIZE;
    const endIdx = Math.min(startIdx + CHUNK_SIZE, srcLines.length);
    const progress = 5 + Math.floor((chunkIndex / totalChunks) * 90);
    
    console.log('progress:' + progress);
    if (totalChunks > 1) {
      console.log(`⚙️ Chunk ${chunkIndex + 1}/${totalChunks} (${(endIdx - startIdx).toLocaleString()} pairs)`);
    }
    
    const srcChunk = srcLines.slice(startIdx, endIdx);
    const tgtChunk = tgtLines.slice(startIdx, endIdx);
    
    const resultChunk = await _computeAlignments(module, atoolsModule, srcChunk, tgtChunk, poolSize);
    resultLines = resultLines.concat(resultChunk);
    await nextFrame();
    
    // Clear chunk references
    srcChunk.length = 0;
    tgtChunk.length = 0;
  }

  // Clean up WASM modules
  if (module?._free) {
    try { module._free(); } catch (e) { console.warn('FastAlign cleanup error:', e); }
  }
  if (atoolsModule?._free) {
    try { atoolsModule._free(); } catch (e) { console.warn('ATools cleanup error:', e); }
  }
  
  module = null;
  atoolsModule = null;
  await new Promise(r => setTimeout(r, 100));

  console.log('progress:100');
  return resultLines;
}

async function createProjectInSQLite() {
    console.log('operation:Creating project');
    const pyodide = await initPyodide();
    const projectId = await pyodide.runPythonAsync(`
        from projects import create_project
        create_project()
    `);
    await safeSyncfs(pyodide);
    console.log(`✅ Project created (ID: ${projectId})`);
    return projectId;
}

export async function storeAlignments(srcLines, tgtLines, alignLines, scoreLines) {
    console.log('operation:Storing alignments');
    console.log('progress:0');
    
    const projectId = await createProjectInSQLite();
    console.log('progress:10');

    const pyodide = await initPyodide();
    pyodide.globals.set("project_id", projectId);
    pyodide.globals.set("src_lines", srcLines);
    pyodide.globals.set("tgt_lines", tgtLines);
    pyodide.globals.set("align_lines", alignLines);
    pyodide.globals.set("score_lines", scoreLines);

    console.log('operation:Writing to database');
    console.log('progress:20');
    
    const storeStart = performance.now();
    await pyodide.runPythonAsync(`
        from projects import save_alignments
        save_alignments(project_id, src_lines, tgt_lines, align_lines, score_lines)
    `);
    const storeDuration = ((performance.now() - storeStart) / 1000).toFixed(1);
    
    console.log('progress:80');
    await safeSyncfs(pyodide);
    
    // Clear Python globals
    pyodide.globals.delete("src_lines");
    pyodide.globals.delete("tgt_lines");
    pyodide.globals.delete("align_lines");
    pyodide.globals.delete("score_lines");
    
    // Also run Python garbage collection
    await pyodide.runPythonAsync(`
        import gc
        gc.collect()
    `);

    console.log('progress:100');
    return projectId;
}

export async function recomputeAlignments(project_id) {
    console.log('operation:Recomputing alignments');
    console.log('progress:0');

    const pyodide = await initPyodide();
    pyodide.globals.set("project_id", project_id);
    
    console.log('operation:Loading project data');
    console.log('progress:5');
    
    const response = await pyodide.runPythonAsync(`
        from projects import get_project_data_for_alignments
        data = get_project_data_for_alignments(project_id)
        data
    `);

    const dataObj = response.toJs({ dict_converter: Object.fromEntries });
    console.log(`📊 Loaded ${dataObj.lines1.length.toLocaleString()} pairs from project ${project_id}`);
    console.log('progress:10');

    console.log('operation:Computing alignments');
    const alignments = await computeAlignments(dataObj.lines1, dataObj.lines2);
    console.log('progress:80');

    console.log('operation:Updating database');
    pyodide.globals.set("src_lines", dataObj.lines1);
    pyodide.globals.set("tgt_lines", dataObj.lines2);
    pyodide.globals.set("align_lines", alignments);
    pyodide.globals.set("score_lines", dataObj.scores);

    const updateStart = performance.now();
    await pyodide.runPythonAsync(`
        from projects import update_alignments
        update_alignments(project_id, align_lines)
    `);
    const updateDuration = ((performance.now() - updateStart) / 1000).toFixed(1);

    console.log('progress:95');
    await safeSyncfs(pyodide);

    console.log(`✅ Recomputed ${alignments.length.toLocaleString()} alignments (${updateDuration}s)`);
    console.log('progress:100');
    return true;
}
