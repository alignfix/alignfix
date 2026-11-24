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

import { renderHome } from "./ui/home.js";
import { renderProject } from "./ui/project.js";
import { renderStats } from "./ui/stats.js";
import { renderAbout } from "./ui/about.js";
import { renderHistory } from "./ui/history.js";
import { renderScores } from "./ui/scores.js";
import { renderReview } from "./ui/review.js";
import { getProject } from "./backend/js/projects.js";
import { escapeHtml } from "./ui/utils.js";
import { isBusy } from "./ui/activity.js";

const projectPages = ["project", "review", "scores", "history", "stats"];
const pageTitles = { project: "Phrases", review: "Review", stats: "Stats", history: "History", scores: "Scores" };

function resetContent() {
  document.getElementById("app").innerHTML = "";
  document.getElementById("sidebar-content").innerHTML = "";
}

function setActive(item, active) {
  item.classList.toggle("active", active);
  const link = item.querySelector("a");
  if (link) {
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

/** Navigation for a page outside of a project (home, about). */
function setActiveNav(page) {
  for (const p of projectPages) {
    const item = document.getElementById(p);
    item.style.display = "none";
    setActive(item, false);
  }
  document.getElementById("project-name-nav").classList.add("d-none");
  for (const p of ["home", "about"]) setActive(document.getElementById(p), p === page);
}

/** Navigation for a page of a project. */
async function updateNav(projectId, activePage) {
  for (const p of ["home", "about"]) setActive(document.getElementById(p), false);
  for (const page of projectPages) {
    const item = document.getElementById(page);
    item.style.display = "block";
    setActive(item, page === activePage);
    const link = item.querySelector("a");
    link.href = `#${page}-${projectId}`;
    link.textContent = pageTitles[page];
  }

  const nameItem = document.getElementById("project-name-nav");
  const label = document.getElementById("project-name-label");
  nameItem.classList.remove("d-none");
  label.textContent = "";
  try {
    const project = await getProject(projectId);
    label.textContent = project?.name || `Project ${projectId}`;
  } catch (e) {
    label.textContent = `Project ${projectId}`;
  }
  document.title = `${label.textContent} · ${pageTitles[activePage]} · AlignFix`;
}

export async function router() {
  resetContent();

  const route = window.location.hash || "#home";
  const app = document.getElementById("app") || document.body;
  const sidebar = document.getElementById("sidebar-content") || null;

  // "#page-<projectId>?key=value": the query passes e.g. a phrase to search for
  const [path, query = ""] = route.split("?");
  const params = new URLSearchParams(query);
  const page = path.split("-")[0];
  const projectId = path.split("-")[1];
  if (projectPages.includes(page.slice(1))) {
    let exists = /^\d+$/.test(projectId || "");
    if (exists) {
      try {
        exists = Boolean(await getProject(projectId));
      } catch (err) {
        console.error("Could not load the project:", err);
      }
    }
    if (!exists) {
      setActiveNav(null);
      app.innerHTML = `<div class="empty-state"><i class="fas fa-map-signs"></i><h5>No such project</h5>
        <p>It may have been deleted. <a href="#home">Go to your projects</a>.</p></div>`;
      return;
    }
  }
  // while an operation runs the title shows its progress
  if (!isBusy()) document.title = "AlignFix";

  try {
    switch (page) {
      case "#home":
        setActiveNav("home");
        await renderHome(app);
        break;
      case "#project":
        updateNav(projectId, "project");
        await renderProject(projectId, params);
        break;
      case "#stats":
        updateNav(projectId, "stats");
        await renderStats(projectId, true);
        break;
      case "#history":
        updateNav(projectId, "history");
        await renderHistory(projectId);
        break;
      case "#review":
        updateNav(projectId, "review");
        await renderReview(projectId, params);
        break;
      case "#scores":
        updateNav(projectId, "scores");
        await renderScores(projectId);
        break;
      case "#about":
        setActiveNav("about");
        await renderAbout(app, sidebar);
        break;
      default:
        setActiveNav(null);
        app.innerHTML = `
          <div class="empty-state">
            <i class="fas fa-map-signs"></i>
            <h5>Page not found</h5>
            <p><code>${escapeHtml(route)}</code> does not exist. <a href="#home">Go to your projects</a>.</p>
          </div>`;
    }
  } catch (err) {
    console.error(`Could not show ${route}:`, err);
    app.innerHTML = `
      <div class="alert alert-danger">
        <h5 class="alert-heading"><i class="fas fa-circle-exclamation me-2"></i>This page could not be shown</h5>
        <p class="mb-0">The logs (above) contain the details. <a href="#home">Back to your projects</a></p>
      </div>`;
  }
  window.scrollTo(0, 0);
}

// Listen to navigation changes
window.addEventListener("hashchange", router);
