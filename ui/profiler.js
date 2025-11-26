/*
  Patch Worker to count creations so profiler can measure "threads spawned"
  Works for code that uses new Worker(...) (including Emscripten pthread workers).
  We keep a global counter on window.__profiler_worker_create_count.
*/
(function patchWorkerForProfiler() {
  if (typeof window === 'undefined') return;
  if (window.Worker && !window.Worker.__patchedForProfiler) {
    const OrigWorker = window.Worker;
    function PatchedWorker(scriptURL, options) {
      try {
        // increment global counter
        window.__profiler_worker_create_count = (window.__profiler_worker_create_count || 0) + 1;
      } catch (e) { /* ignore */ }
      // construct original Worker
      // support both constructor and callable patterns
      return new OrigWorker(scriptURL, options);
    }
    // keep prototype chain so instanceof Worker still works
    PatchedWorker.prototype = OrigWorker.prototype;
    PatchedWorker.__patchedForProfiler = true;
    PatchedWorker.__orig = OrigWorker;
    window.Worker = PatchedWorker;
  }

  // If terminate is called we don't decrement global counter because
  // counting creations (spawned) is often more useful than tracking live workers.
  // If you need live-worker count, we can wrap terminate/add bookkeeping.
})();

export const profiler = {
  data: {},

  clear() {
    // Clear all accumulated profiling data to prevent memory buildup
    this.data = {};
    
    // Reset worker count if needed
    if (typeof window !== 'undefined') {
      window.__profiler_worker_create_count = 0;
    }
  },

  // measure supports sync or async functions (func may return a Promise)
  async measure(name, func) {
    const startTime = performance.now();
    const startMem = (performance && performance.memory) ? performance.memory.usedJSHeapSize : null;
    const startWorkerCreates = (typeof window !== 'undefined' && window.__profiler_worker_create_count) ? window.__profiler_worker_create_count : 0;

    let result;
    try {
      result = func();
      if (result && typeof result.then === "function") {
        result = await result;
      }
    } catch (err) {
      throw err;
    } finally {
      const endTime = performance.now();
      const endMem = (performance && performance.memory) ? performance.memory.usedJSHeapSize : null;
      const endWorkerCreates = (typeof window !== 'undefined' && window.__profiler_worker_create_count) ? window.__profiler_worker_create_count : 0;

      // If memory API missing (Firefox), store null so we can skip it in averages
      const memDiff = (startMem !== null && endMem !== null) ? (endMem - startMem) : null;
      const threadsSpawned = Math.max(0, endWorkerCreates - (startWorkerCreates || 0));

      if (!this.data[name]) this.data[name] = [];
      this.data[name].push({
        cpu_ms: endTime - startTime,
        mem_bytes: memDiff,
        startMemUsed: startMem,
        endMemUsed: endMem,
        threads_spawned: threadsSpawned,
        timestamp: Date.now()
      });
    }
    return result;
  },

  async measureAsync(name, asyncFunc) {
    return this.measure(name, asyncFunc);
  },

  // report summary to console including heap usage and threads spawned per function (avg / total / last)
  reportToConsole() {
    let overallCPUtotal = 0;
    let overallThreads = 0;

    for (const [name, entries] of Object.entries(this.data)) {
      const totalCPU = entries.reduce((a, b) => a + b.cpu_ms, 0);
      overallCPUtotal += totalCPU;

      // Only consider entries that have mem_bytes (memory API supported)
      const memSamples = entries.filter(e => e.mem_bytes !== null);
      const totalMemDelta = memSamples.reduce((a, b) => a + b.mem_bytes, 0);
      const avgCPU = totalCPU / entries.length;
      const avgMemDelta = memSamples.length ? (totalMemDelta / memSamples.length) : null;

      const totalThreads = entries.reduce((a, b) => a + (b.threads_spawned || 0), 0);
      overallThreads += totalThreads;
      const last = entries[entries.length - 1];
      const lastMemDelta = (last && last.mem_bytes !== null) ? last.mem_bytes : null;
      const lastEndMemKB = (last && last.endMemUsed !== null) ? (last.endMemUsed / 1024).toFixed(2) + ' KB' : 'N/A';
      const lastThreads = (last && (last.threads_spawned !== undefined)) ? last.threads_spawned : 'N/A';

      // Console output: include avg/total CPU, heap deltas and threads spawned
      console.log(`${name} => calls: ${entries.length}, total CPU: ${totalCPU.toFixed(2)} ms, avg CPU: ${avgCPU.toFixed(2)} ms, total heap Δ: ${memSamples.length ? (totalMemDelta/1024).toFixed(2)+' KB' : 'N/A'}, avg heap Δ: ${avgMemDelta !== null ? (avgMemDelta/1024).toFixed(2) + ' KB' : 'N/A'}, last heap Δ: ${lastMemDelta !== null ? (lastMemDelta/1024).toFixed(2) + ' KB' : 'N/A'}, threads spawned (total/last): ${totalThreads}/${lastThreads}, last heap used: ${lastEndMemKB}`);
    }

    // overall summary
    console.log(`Overall CPU total: ${overallCPUtotal.toFixed(2)} ms (${(overallCPUtotal/1000).toFixed(2)} s), overall threads spawned: ${overallThreads}`);

    if (performance && performance.memory) {
      console.log('JS Heap Limit (MB):', (performance.memory.jsHeapSizeLimit / 1024 / 1024).toFixed(2));
      console.log('Total JS Heap Size (MB):', (performance.memory.totalJSHeapSize / 1024 / 1024).toFixed(2));
      console.log('Used JS Heap Size (MB):', (performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(2));
    } else {
      console.log('Memory metrics: not available in this browser (performance.memory unsupported).');
    }
  },

  // render a simple metrics summary into a DOM element (selector or element)
  displayMetrics(target) {
    let el = (typeof target === 'string') ? document.querySelector(target) : target;
    if (!el) return;

    // Build a compact table for nicer UI (uses bootstrap classes if available)
    const table = document.createElement('table');
    table.className = 'table table-sm table-striped';
    table.style.marginBottom = '0';

    const thead = document.createElement('thead');
    thead.innerHTML = `<tr>
      <th scope="col">Name</th>
      <th scope="col" class="text-end">Calls</th>
      <th scope="col" class="text-end">Avg CPU (ms)</th>
      <th scope="col" class="text-end">Total CPU (ms)</th>
      <th scope="col" class="text-end">Avg Mem Δ (KB)</th>
      <th scope="col" class="text-end">Total Mem Δ (KB)</th>
      <th scope="col" class="text-end">Threads</th>
      <th scope="col" class="text-end">Last</th>
    </tr>`;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    let overallCPU = 0;
    let overallThreads = 0;
    let anyMemSamples = false;
    let overallMemDelta = 0;

    for (const [name, entries] of Object.entries(this.data)) {
      const totalCPU = entries.reduce((a, b) => a + b.cpu_ms, 0);
      overallCPU += totalCPU;

      const memSamples = entries.filter(e => e.mem_bytes !== null);
      const totalMemAll = memSamples.reduce((a, b) => a + b.mem_bytes, 0);
      overallMemDelta += totalMemAll;
      if (memSamples.length) anyMemSamples = true;

      const totalThreads = entries.reduce((a, b) => a + (b.threads_spawned || 0), 0);
      overallThreads += totalThreads;

      const avgCPU = totalCPU / entries.length;
      const avgMem = memSamples.length ? (totalMemAll / memSamples.length) : null;
      const last = entries[entries.length - 1];
      const lastTs = last.timestamp;
      const lastDate = new Date(lastTs).toLocaleTimeString();
      const lastThreads = last && (last.threads_spawned !== undefined) ? last.threads_spawned : 'N/A';

      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      tdName.textContent = name;
      tr.appendChild(tdName);

      const tdCalls = document.createElement('td');
      tdCalls.className = 'text-end';
      tdCalls.textContent = entries.length;
      tr.appendChild(tdCalls);

      const tdAvgCPU = document.createElement('td');
      tdAvgCPU.className = 'text-end';
      tdAvgCPU.textContent = avgCPU.toFixed(1);
      tr.appendChild(tdAvgCPU);

      const tdTotalCPU = document.createElement('td');
      tdTotalCPU.className = 'text-end';
      tdTotalCPU.textContent = totalCPU.toFixed(1);
      tr.appendChild(tdTotalCPU);

      const tdAvgMem = document.createElement('td');
      tdAvgMem.className = 'text-end';
      tdAvgMem.textContent = avgMem !== null ? (avgMem / 1024).toFixed(1) : 'N/A';
      tr.appendChild(tdAvgMem);

      const tdTotalMem = document.createElement('td');
      tdTotalMem.className = 'text-end';
      tdTotalMem.textContent = (totalMemAll !== 0 && memSamples.length) ? (totalMemAll / 1024).toFixed(1) : 'N/A';
      tr.appendChild(tdTotalMem);

      const tdThreads = document.createElement('td');
      tdThreads.className = 'text-end';
      tdThreads.textContent = `${totalThreads} / ${lastThreads}`;
      tr.appendChild(tdThreads);

      const tdLast = document.createElement('td');
      tdLast.className = 'text-end';
      tdLast.textContent = lastDate;
      tr.appendChild(tdLast);

      tbody.appendChild(tr);
    }

    table.appendChild(tbody);

    // Footer with heap info or notice and overall CPU + overall threads
    const footer = document.createElement('div');
    footer.style.marginTop = '0.5rem';
    footer.style.fontSize = '0.9rem';
    footer.style.color = '#666';

    const overallCPUstr = `Overall CPU: ${(overallCPU/1000).toFixed(2)} s (${overallCPU.toFixed(1)} ms)`;
    const overallThreadsStr = `Overall threads spawned: ${overallThreads}`;

    if (performance && performance.memory) {
      footer.innerHTML = `${overallCPUstr} &nbsp;|&nbsp; ${overallThreadsStr} &nbsp;|&nbsp; Heap used: ${(performance.memory.usedJSHeapSize/1024/1024).toFixed(2)} MB of ${(performance.memory.jsHeapSizeLimit/1024/1024).toFixed(2)} MB`;
    } else {
      footer.textContent = `${overallCPUstr} | ${overallThreadsStr} | Memory metrics: not available in this browser.`;
    }

    // Replace element content
    el.innerHTML = '';
    el.appendChild(table);
    el.appendChild(footer);
  },

  async measureAndLog(name, func) {
    await this.measure(name, func);
    this.reportToConsole();
  },

  clear() {
    this.data = {};
    // reset counter if needed
    if (typeof window !== 'undefined') window.__profiler_worker_create_count = 0;
  }
};