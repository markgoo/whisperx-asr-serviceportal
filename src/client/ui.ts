/** 模态框与确认对话框。 */

import { clear, h } from './dom';

export interface ModalOptions {
  title: string;
  body: HTMLElement;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  wide?: boolean;
  /** Return false (or throw) to keep the dialog open. */
  onConfirm?: () => boolean | void | Promise<boolean | void>;
}

let openModal: HTMLElement | null = null;

export function closeModal(): void {
  closeModalElement();
}

function closeModalElement(): void {
  openModal?.remove();
  openModal = null;
  document.body.style.overflow = '';
}

export function showModal(opts: ModalOptions): void {
  closeModalElement();
  const root = document.getElementById('modal-root')!;
  const mask = h('div', { class: 'modal-mask' });

  const confirmBtn = h(
    'button',
    { class: `btn ${opts.danger ? 'danger' : 'primary'}` },
    opts.confirmText ?? '确定',
  );
  const cancelBtn = h('button', { class: 'btn' }, opts.cancelText ?? '取消');

  const dialog = h(
    'div',
    { class: `modal${opts.wide ? ' wide' : ''}` },
    h('div', { class: 'modal-head' }, h('h3', null, opts.title)),
    h('div', { class: 'modal-body' }, opts.body),
    h(
      'div',
      { class: 'modal-foot' },
      opts.onConfirm ? cancelBtn : null,
      opts.onConfirm ? confirmBtn : cancelBtn,
    ),
  );
  mask.appendChild(dialog);
  root.appendChild(mask);
  openModal = mask;
  document.body.style.overflow = 'hidden';

  mask.addEventListener('mousedown', (ev) => {
    if (ev.target === mask) closeModalElement();
  });
  cancelBtn.addEventListener('click', () => closeModalElement());

  const submit = async (): Promise<void> => {
    if (!opts.onConfirm) return closeModalElement();
    confirmBtn.toggleAttribute('disabled', true);
    try {
      const keep = await opts.onConfirm();
      if (keep === false) return;
      closeModalElement();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      let alertBox = dialog.querySelector('.alert.err') as HTMLElement | null;
      if (!alertBox) {
        alertBox = h('div', { class: 'alert err' });
        dialog.querySelector('.modal-body')!.prepend(alertBox);
      }
      clear(alertBox);
      alertBox.append(msg);
    } finally {
      confirmBtn.toggleAttribute('disabled', false);
    }
  };

  confirmBtn.addEventListener('click', () => void submit());
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      document.removeEventListener('keydown', onKey);
      closeModalElement();
    }
    if (ev.key === 'Enter' && !(ev.target instanceof HTMLTextAreaElement)) {
      document.removeEventListener('keydown', onKey);
      void submit();
    }
  };
  document.addEventListener('keydown', onKey);
  mask.addEventListener('remove', () => document.removeEventListener('keydown', onKey));

  const focusable = dialog.querySelector('input, textarea, select') as HTMLElement | null;
  (focusable ?? confirmBtn).focus();
}

export function confirmDialog(
  title: string,
  message: string,
  confirmText = '确定',
  danger = false,
): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    showModal({
      title,
      body: h('div', null, message),
      confirmText,
      danger,
      onConfirm: () => {
        answered = true;
        resolve(true);
      },
    });
    const original = document.getElementById('modal-root')!.firstElementChild as HTMLElement;
    const observer = new MutationObserver(() => {
      if (!document.body.contains(original) && !answered) {
        answered = true;
        observer.disconnect();
        resolve(false);
      }
    });
    observer.observe(document.getElementById('modal-root')!, { childList: true });
  });
}

export function promptDialog(
  title: string,
  label: string,
  initial: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value: initial }) as HTMLInputElement;
    let answer: string | null = null;
    showModal({
      title,
      body: h('div', null, h('div', { class: 'field' }, h('label', null, label), input)),
      onConfirm: () => {
        const value = input.value.trim();
        if (!value) throw new Error('不能为空');
        answer = value;
        resolve(value);
      },
    });
    const original = document.getElementById('modal-root')!.firstElementChild as HTMLElement;
    const observer = new MutationObserver(() => {
      if (!document.body.contains(original) && answer === null) {
        observer.disconnect();
        resolve(null);
      }
    });
    observer.observe(document.getElementById('modal-root')!, { childList: true });
  });
}
