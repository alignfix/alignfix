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

/**
 * Write the in-memory database to the browser's persistent storage
 * (IndexedDB), retrying a few times with a growing delay. Rejects if all
 * attempts fail.
 *
 * Only ever syncs in this direction: syncfs(true) would load the stored
 * (older) state over the in-memory database and lose the latest changes.
 */
export async function safeSyncfs(pyodide, maxAttempts = 4) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await new Promise((resolve, reject) => {
                pyodide.FS.syncfs(false, (err) => err ? reject(err) : resolve());
            });
            if (attempt > 1) console.log(`Saved to browser storage on attempt ${attempt}`);
            return;
        } catch (err) {
            lastError = err;
            console.warn(`Saving to browser storage failed (attempt ${attempt} of ${maxAttempts}):`, err?.message || String(err));
            if (attempt < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 200 * 2 ** attempt));
            }
        }
    }
    const reason = lastError?.message || String(lastError);
    throw new Error(`Could not save to the browser storage (${reason}). The changes are kept until the page is closed; ` +
        `free up disk space or allow storage for this site, then try again.`);
}
