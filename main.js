import { initPyodide } from "./pyodide.js";
import { router } from "./router.js";

function showLoader(show) {
  const loader = document.querySelector(".loader");
  if (loader) {
    loader.style.display = show ? "inline-block" : "none";
  }
  var logContainer = document.getElementById('log');
  if (logContainer) {
    if (show) {
      logContainer.classList.add('show');
    } else {
      logContainer.classList.remove('show');
    }
  }
}

(async function main() {
  showLoader(true);
  await initPyodide();
  router(); // render initial page
  showLoader(false);
})();
