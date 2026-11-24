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

import { stage, report } from "./ui/activity.js";

let pyodide;

async function fetchText(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`Could not load ${path} (HTTP ${response.status})`);
    return response.text();
}

async function loadPythonFile(path) {
    const code = await fetchText(path);
    await pyodide.runPythonAsync(code);
}

async function loadPythonModule(path, moduleName) {
    const code = await fetchText(path);
    // write file into Pyodide FS
    pyodide.FS.writeFile(`/${moduleName}.py`, code);
    // append FS to Python path
    await pyodide.runPythonAsync(`
    import sys
    if '/${moduleName}' not in sys.path:
        sys.path.append('/')
    `);
}

// One shared initialization: callers arriving while it runs wait for it instead
// of getting an interpreter whose packages and modules are not loaded yet.
let initPromise = null;

export function initPyodide() {
    if (!initPromise) {
        initPromise = _initPyodide().catch(err => {
            initPromise = null;  // allow a retry after a failed load
            throw err;
        });
    }
    return initPromise;
}

const PYTHON_MODULES = [
    'db', 'progress', 'projects', 'alignment', 'phrases', 'scores', 'lexicon',
    'text', 'fixes', 'utils', 'binary', 'review',
];

async function _initPyodide() {
    if (!pyodide) {
        await stage(0, 0.5, "Loading the Python runtime", async () => {
            pyodide = await loadPyodide({
                // print() output goes to the log panel (stderr as warnings)
                stdout: (line) => console.log(line),
                stderr: (line) => console.warn(line),
            });
        });
        console.log("Pyodide loaded");

        await stage(0.5, 0.85, "Installing packages", async () => {
            await pyodide.loadPackage('micropip');
            const packages = ['sqlite3', 'numpy', 'bs4'];
            const micropip = pyodide.pyimport('micropip');
            for (const [i, name] of packages.entries()) {
                report(i / packages.length, name);
                await micropip.install(name);
            }
            micropip.destroy();
        });
        console.log("Python packages loaded");

        await stage(0.85, 0.9, "Opening the database", async () => {
            // mount IDBFS for persistence
            pyodide.FS.mkdir("/data");   // create /data dir
            pyodide.FS.mount(pyodide.FS.filesystems.IDBFS, {}, "/data");

            // sync from IndexedDB → memory
            await new Promise((resolve, reject) => {
                pyodide.FS.syncfs(true, err => err ? reject(err) : resolve());
            });
            console.log("Synced DB from IndexedDB");

            await loadPythonFile('backend/py/db_init.py');
            console.log("Database initialized");
        });

        await stage(0.9, 1, "Loading modules", async () => {
            for (const [i, name] of PYTHON_MODULES.entries()) {
                report(i / PYTHON_MODULES.length, name);
                await loadPythonModule(`backend/py/${name}.py`, name);
            }
            // module files were written after the import system may have cached "/"
            await pyodide.runPythonAsync(`
    import importlib
    importlib.invalidate_caches()
            `);
        });
        console.log("Python modules loaded");
    }

    return pyodide;
}
