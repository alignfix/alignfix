// Safe wrapper around pyodide.FS.syncfs with retries and fallback toggle
export async function safeSyncfs(pyodide, maxAttempts = 4) {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        let triedToggle = false;

        const trySync = (syncToPersistent = false) => {
            try {
                pyodide.FS.syncfs(syncToPersistent, (err) => {
                    if (!err) {
                        resolve();
                        return;
                    }

                    const errMsg = err && err.message ? err.message : String(err);
                    console.warn(`FS.syncfs attempt ${attempts + 1} failed:`, errMsg);

                    // Retry with exponential backoff
                    if (attempts < maxAttempts - 1) {
                        attempts++;
                        const delay = Math.pow(2, attempts) * 100;
                        setTimeout(() => trySync(syncToPersistent), delay);
                        return;
                    }

                    // If we exhausted attempts, try toggling the sync direction once
                    if (!triedToggle) {
                        triedToggle = true;
                        attempts = 0;
                        console.warn('FS.syncfs toggling sync direction and retrying');
                        // toggle direction: try true (syncToPersistent) if we previously used false, and vice versa
                        trySync(!syncToPersistent);
                        return;
                    }

                    // Give up
                    reject(err);
                });
            } catch (ex) {
                // catch synchronous exceptions from FS.syncfs
                const syncErrMsg = ex && ex.message ? ex.message : String(ex);
                console.error('FS.syncfs threw:', syncErrMsg);
                if (attempts < maxAttempts - 1) {
                    attempts++;
                    const delay = Math.pow(2, attempts) * 100;
                    setTimeout(() => trySync(syncToPersistent), delay);
                } else if (!triedToggle) {
                    triedToggle = true;
                    attempts = 0;
                    trySync(!syncToPersistent);
                } else {
                    reject(ex);
                }
            }
        };

        trySync(false);
    });
}