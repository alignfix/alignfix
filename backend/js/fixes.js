import { initPyodide } from "../../pyodide.js";
import { safeSyncfs } from "./storage.js";

export async function applyFixes(project_id, fixes) {
  const pyodide = await initPyodide();

  pyodide.globals.set("project_id", project_id);
  pyodide.globals.set("fixes_json", JSON.stringify(fixes));

  const startTime = performance.now();

  await pyodide.runPythonAsync(`
      from fixes import apply_fixes
      fixes = json.loads(fixes_json)
      apply_fixes(project_id, fixes)
  `);

  const endTime = performance.now();
  console.log(`Applied fixes in ${(endTime - startTime).toFixed(2)} ms`);

  await safeSyncfs(pyodide);

  return;
}

export async function getFixes(project_id) {
  const pyodide = await initPyodide();

  pyodide.globals.set("project_id", project_id);

  const response = await pyodide.runPythonAsync(`
      import json
      from fixes import get_fixes

      fixes = get_fixes(project_id)
      json.dumps(fixes)
  `);
  
  const fixes = JSON.parse(response);
  return fixes;
}

export async function countFixes(project_id) {
  const pyodide = await initPyodide();

  pyodide.globals.set("project_id", project_id);

  const response = await pyodide.runPythonAsync(`
      import json
      from fixes import count_fixes

      num_fixes = count_fixes(project_id)
      num_fixes
  `);
  
  return response;
}