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

/* Modal dialogs and toast notifications (instead of alert() / confirm()). */

import { escapeHtml } from "./utils.js";

const ICONS = {
  info: '<i class="fas fa-info-circle text-info"></i>',
  success: '<i class="fas fa-check-circle text-success"></i>',
  warning: '<i class="fas fa-exclamation-triangle text-warning"></i>',
  danger: '<i class="fas fa-exclamation-circle text-danger"></i>',
  question: '<i class="fas fa-question-circle text-primary"></i>',
};

/**
 * Show a modal dialog. Resolves with the value of the clicked button, or null
 * if the dialog was dismissed. Title and message are plain text.
 */
export function showModal(title, message, type = 'info', buttons = []) {
  return new Promise((resolve) => {
    const modalId = 'customModal';
    document.getElementById(modalId)?.remove();

    if (buttons.length === 0) {
      buttons = [{ label: 'OK', value: 'ok', variant: 'primary' }];
    }
    const buttonHtml = buttons.map(btn =>
      `<button type="button" class="btn btn-${escapeHtml(btn.variant || 'secondary')}" data-result="${escapeHtml(btn.value)}">${escapeHtml(btn.label)}</button>`
    ).join('');

    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal fade" id="${modalId}" tabindex="-1" aria-hidden="true" aria-labelledby="${modalId}-title" data-bs-backdrop="static">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title d-flex align-items-center gap-2" id="${modalId}-title">
                ${ICONS[type] || ICONS.info}
                <span>${escapeHtml(title)}</span>
              </h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
            </div>
            <div class="modal-body">
              <p class="mb-0" style="white-space: pre-wrap;">${escapeHtml(message)}</p>
            </div>
            <div class="modal-footer">${buttonHtml}</div>
          </div>
        </div>
      </div>
    `);
    const modalElement = document.getElementById(modalId);
    const modal = new bootstrap.Modal(modalElement);
    let result = null;

    modalElement.querySelectorAll('[data-result]').forEach(btn => {
      btn.addEventListener('click', () => {
        result = btn.dataset.result;
        modal.hide();
      });
    });
    modalElement.addEventListener('shown.bs.modal', () => {
      // focus the last (primary) button so Enter confirms
      modalElement.querySelector('.modal-footer .btn:last-child')?.focus();
    });
    modalElement.addEventListener('hidden.bs.modal', () => {
      modal.dispose();
      modalElement.remove();
      resolve(result);
    });

    modal.show();
  });
}

export function showAlert(message, title = 'Notice', type = 'info') {
  return showModal(title, message, type);
}

/** Resolves true if confirmed. */
export async function showConfirm(message, title = 'Confirm', { confirmLabel = 'Confirm', type = 'question' } = {}) {
  const result = await showModal(title, message, type, [
    { label: 'Cancel', value: 'cancel', variant: 'secondary' },
    { label: confirmLabel, value: 'confirm', variant: 'primary' },
  ]);
  return result === 'confirm';
}

/** Resolves true if the deletion was confirmed. */
export async function showDeleteConfirm(message, title = 'Delete', confirmLabel = 'Delete') {
  const result = await showModal(title, message, 'danger', [
    { label: 'Cancel', value: 'cancel', variant: 'secondary' },
    { label: confirmLabel, value: 'delete', variant: 'danger' },
  ]);
  return result === 'delete';
}

/**
 * Short notification in the corner of the page. type: success, info,
 * warning or danger. options.action = { label, href } adds a link;
 * options.delay in ms (errors stay until closed).
 */
export function toast(message, type = 'info', options = {}) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container position-fixed bottom-0 end-0 p-3';
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }

  const el = document.createElement('div');
  el.className = `toast align-items-center border-0 toast-${type}`;
  el.setAttribute('role', type === 'danger' ? 'alert' : 'status');
  const action = options.action
    ? `<a class="btn btn-sm btn-light ms-2 toast-action" href="${escapeHtml(options.action.href)}">${escapeHtml(options.action.label)}</a>`
    : '';
  el.innerHTML = `
    <div class="d-flex align-items-center">
      <div class="toast-body d-flex align-items-start gap-2">
        ${ICONS[type] || ICONS.info}
        <span class="toast-message">${escapeHtml(message)}</span>
      </div>
      ${action}
      <button type="button" class="btn-close me-2 ms-auto" data-bs-dismiss="toast" aria-label="Close"></button>
    </div>`;
  container.appendChild(el);

  const sticky = type === 'danger' && options.delay === undefined;
  const t = new bootstrap.Toast(el, { autohide: !sticky, delay: options.delay || 6000 });
  el.addEventListener('hidden.bs.toast', () => { t.dispose(); el.remove(); });
  el.querySelector('.toast-action')?.addEventListener('click', () => t.hide());
  t.show();
  return t;
}
