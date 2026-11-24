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

import { initPyodide } from "./pyodide.js";
import { router } from "./router.js";
import { runActivity } from "./ui/activity.js";

(async function main() {
  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="startup text-center text-muted py-5">
      <div class="spinner-border text-primary mb-3" role="status"></div>
      <h5>Starting AlignFix…</h5>
      <p class="small mb-0">The first start downloads the Python runtime (about 30 MB);
        later starts use the browser cache. Everything runs locally in your browser.</p>
    </div>`;
  try {
    await runActivity("Starting AlignFix", () => initPyodide(), { done: () => "Ready" });
  } catch (err) {
    app.innerHTML = `
      <div class="alert alert-danger m-4">
        <h5 class="alert-heading"><i class="fas fa-circle-exclamation me-2"></i>AlignFix could not start</h5>
        <p class="mb-1">The Python runtime or the database could not be loaded. Check your internet
          connection (needed for the first start) and reload the page; the logs above show the details.</p>
      </div>`;
    const detail = document.createElement("pre");
    detail.className = "small mb-0 mt-2";
    detail.textContent = String(err && err.message || err);
    app.querySelector(".alert").appendChild(detail);
    return;
  }
  router(); // render initial page
})();
