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

import { writeFileInChunks, wasmOutput } from './utils.js';
import { stage, report, yieldToUI } from '../../ui/activity.js';

export const MAX_LINE_LENGTH = 2000;
export const MIN_LINE_LENGTH = 1;
export const MAX_NUM_LINES = 1000000;
export const MAX_TOKENS_PER_LINE = 512;

function getTextTokeniseChunkSize(numCores) {
    if (numCores >= 16) return 500000;
    if (numCores >= 8) return 200000;
    if (numCores >= 4) return 100000;
    return 100000;
}

/**
 * Read the two files as sentence pairs. Pairs that cannot be processed are
 * skipped and counted in `skipped` (with the first few line numbers per reason)
 * so the page can show what was left out. Throws if the line counts differ.
 */
export async function getLinesFromFiles(src_file, tgt_file) {
  const src_lines = (await src_file.text()).split(/\r?\n/);
  const tgt_lines = (await tgt_file.text()).split(/\r?\n/);
  // a final newline is not an extra (empty) line
  if (src_lines.length > 0 && src_lines[src_lines.length - 1] === "") src_lines.pop();
  if (tgt_lines.length > 0 && tgt_lines[tgt_lines.length - 1] === "") tgt_lines.pop();

  if (src_lines.length !== tgt_lines.length) {
    throw new Error(`The files must have the same number of lines (source: ${src_lines.length.toLocaleString()}, target: ${tgt_lines.length.toLocaleString()}).`);
  }

  const skipped = {
    empty: { count: 0, lines: [], label: "an empty side" },
    tooLong: { count: 0, lines: [], label: `more than ${MAX_LINE_LENGTH.toLocaleString()} characters` },
    tooManyTokens: { count: 0, lines: [], label: `more than ${MAX_TOKENS_PER_LINE} words` },
    overLimit: { count: 0, lines: [], label: `beyond the limit of ${MAX_NUM_LINES.toLocaleString()} pairs` },
  };
  const skip = (reason, i) => {
    skipped[reason].count++;
    if (skipped[reason].lines.length < 5) skipped[reason].lines.push(i + 1);
  };

  const filtered_src_lines = [];
  const filtered_tgt_lines = [];
  for (let i = 0; i < src_lines.length; i++) {
    const src_line = src_lines[i].trim();
    const tgt_line = tgt_lines[i].trim();
    if (src_line.length < MIN_LINE_LENGTH || tgt_line.length < MIN_LINE_LENGTH) {
      skip("empty", i);
    } else if (src_line.length > MAX_LINE_LENGTH || tgt_line.length > MAX_LINE_LENGTH) {
      skip("tooLong", i);
    } else if (src_line.split(" ").length > MAX_TOKENS_PER_LINE || tgt_line.split(" ").length > MAX_TOKENS_PER_LINE) {
      skip("tooManyTokens", i);
    } else if (filtered_src_lines.length >= MAX_NUM_LINES) {
      skip("overLimit", i);
    } else {
      filtered_src_lines.push(src_line);
      filtered_tgt_lines.push(tgt_line);
    }
  }

  const skippedTotal = Object.values(skipped).reduce((n, r) => n + r.count, 0);
  for (const reason of Object.values(skipped)) {
    if (reason.count > 0) {
      console.warn(`Skipped ${reason.count.toLocaleString()} line pair(s) with ${reason.label} (line ${reason.lines.join(", ")}${reason.count > reason.lines.length ? ", ..." : ""})`);
    }
  }

  return { src_lines: filtered_src_lines, tgt_lines: filtered_tgt_lines, total: src_lines.length, skipped, skippedTotal };
}

async function _tokeniseLines(module, inputLines, numCores) {
  // Input and output file paths in the virtual filesystem
  const inputFile = "/input.txt";
  const outputFile = "/output.txt";

  writeFileInChunks(module, inputFile, inputLines);
  report(0.1);
  await yieldToUI();

  const tokenizeStart = performance.now();
  const result = await module.ccall(
    "tokenize_file", // Function name in C
    "number",        // Return type
    ["string", "string", "number"], // Argument types
    [inputFile, outputFile, numCores] // Arguments
  );
  const tokenizeDuration = (performance.now() - tokenizeStart) / 1000;
  if (result !== 0) {
    throw new Error(`Tokenization failed (exit code ${result})`);
  }
  report(0.8);

  // Each output line is "<line index>|||<tokens>", written by the threads in any
  // order. Place every line at its index so the result has exactly one entry per
  // input line (an empty last input line never reaches the file, for example).
  const tokenizedContent = module.FS.readFile(outputFile, { encoding: "utf8" });
  const lines = new Array(inputLines.length).fill("");
  let placed = 0;
  for (const line of tokenizedContent.split("\n")) {
    const sep = line.indexOf("|||");
    if (sep < 0) continue;
    const index = parseInt(line.slice(0, sep), 10);
    if (Number.isInteger(index) && index >= 0 && index < lines.length) {
      lines[index] = line.slice(sep + 3).trim();
      placed++;
    }
  }
  if (placed !== inputLines.length) {
    console.warn(`⚠️ Tokenizer returned ${placed} of ${inputLines.length} lines; missing lines are left empty`);
  }

  // free up memory and resources
  module.FS.unlink(inputFile);
  module.FS.unlink(outputFile);

  console.log(`✅ Tokenized ${inputLines.length.toLocaleString()} lines in ${tokenizeDuration.toFixed(2)}s`);
  return lines;
}

/** Tokenize lines with the C tokenizer. Progress: 0..1 of the current stage. */
export async function tokeniseLines(inputLines) {
  const { createModule, config } = await window.WasmModuleLoader.loadTextTokenize();
  const numCores = parseInt(document.getElementById("num-cores-input")?.value) 
                    || window.navigator.hardwareConcurrency || 1;
  const poolSize = Math.min(config.poolSize, numCores);

  let module = await createModule({ pthreadPoolSize: poolSize, ...wasmOutput("tokenizer") });

  const CHUNK_SIZE = getTextTokeniseChunkSize(poolSize);
  const totalChunks = Math.ceil(inputLines.length / CHUNK_SIZE);

  let resultLines = [];
  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const startIdx = chunkIndex * CHUNK_SIZE;
    const endIdx = Math.min(startIdx + CHUNK_SIZE, inputLines.length);
    const label = totalChunks > 1 ? `part ${chunkIndex + 1} of ${totalChunks}` : "";
    const resultChunk = await stage(chunkIndex / totalChunks, (chunkIndex + 1) / totalChunks, label,
      () => _tokeniseLines(module, inputLines.slice(startIdx, endIdx), poolSize));
    resultLines = resultLines.concat(resultChunk);
  }

  module = null;
  return resultLines;
}
