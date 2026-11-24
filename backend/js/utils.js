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

// Helper function to write large arrays to files in chunks
export function writeFileInChunks(module, filename, lines, chunkSize = 10000) {
  const stream = module.FS.open(filename, 'w');
  
  for (let i = 0; i < lines.length; i += chunkSize) {
    const chunk = lines.slice(i, Math.min(i + chunkSize, lines.length));
    const text = chunk.join("\n") + (i + chunkSize < lines.length ? "\n" : "");
    const buffer = new TextEncoder().encode(text);
    module.FS.write(stream, buffer, 0, buffer.length);
  }
  
  module.FS.close(stream);
}
/**
 * print/printErr options for creating a WASM module: its stdout goes to the
 * log panel as details (hidden unless "Details" is selected), stderr as
 * warnings. onLine(text), if given, also receives every stdout line (e.g. to
 * follow progress messages).
 */
export function wasmOutput(name, onLine = null) {
  const log = window.AlignFixLog || console;
  return {
    print: (text) => {
      if (onLine) {
        try { onLine(text); } catch (e) { /* progress parsing must not break the module */ }
      }
      (log.debug || console.debug)(`[${name}] ${text}`);
    },
    printErr: (text) => (log.warn || console.warn)(`[${name}] ${text}`),
  };
}

/** Save a Blob as a file. The object URL is released once the download started. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // revoking right away cancels the download in some browsers
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** A file name from free text: no path separators, ':' etc. (invalid on Windows). */
export function safeFilename(text, fallback = "alignfix") {
  const name = String(text || "")
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 100);
  return name || fallback;
}
