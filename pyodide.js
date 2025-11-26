let pyodide;

async function loadPythonFile(path) {
    const response = await fetch(path);
    const code = await response.text();
    await pyodide.runPythonAsync(code);
}

async function loadPythonModule(path, moduleName) {
    const response = await fetch(path);
    const code = await response.text();
    // write file into Pyodide FS
    pyodide.FS.writeFile(`/${moduleName}.py`, code);
    // append FS to Python path
    await pyodide.runPythonAsync(`
    import sys
    if '/${moduleName}' not in sys.path:
        sys.path.append('/')
    `);
}

export async function initPyodide() {
    
    
    if (!pyodide) {
        pyodide = await loadPyodide();
        console.log("Pyodide loaded");
        await pyodide.loadPackage('micropip');
        await pyodide.runPythonAsync(`
            import micropip
            await micropip.install('sqlite3')
            await micropip.install('ftfy')
            await micropip.install('numpy')
            await micropip.install('bs4')
        `);
        console.log("sqlite3 loaded");

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

        await loadPythonModule('backend/py/db.py', 'db');
        await loadPythonModule('backend/py/projects.py', 'projects');
        await loadPythonModule('backend/py/alignment.py', 'alignment');
        await loadPythonModule('backend/py/phrases.py', 'phrases');
        await loadPythonModule('backend/py/scores.py', 'scores');
        await loadPythonModule('backend/py/text.py', 'text');
        await loadPythonModule('backend/py/fixes.py', 'fixes');
        await loadPythonModule('backend/py/utils.py', 'utils');
        await loadPythonModule('backend/py/binary.py', 'binary');
        console.log("Python modules loaded");
    }

    return pyodide;
}