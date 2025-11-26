export function bindAsyncButton(btn, handler, text="Processing...") {
  btn.addEventListener("click", async (e) => {
    const oldHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${text}`;
    const logContainer = document.getElementById('log');
    if (logContainer) {
      logContainer.classList.add('show');
    }
    try {
      // handler may be async
      const res = handler(e);
      if (res && typeof res.then === "function") {
        await res;
      }
    } catch (err) {
      console.error("Handler error:", err);
      throw err;
    } finally {
      btn.disabled = false;
      btn.innerHTML = oldHtml;
      if (logContainer) {
        logContainer.classList.remove('show');
      }
    }
  });
}

// Small utility: wait for the next paint(s) instead of using setTimeout.
// Using requestAnimationFrame avoids long 'setTimeout' handler violations
// and gives the browser a chance to flush logs/layout.
export function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}