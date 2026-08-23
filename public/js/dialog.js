/**
 * Custom dark-themed dialog system that replaces window.alert/confirm/prompt.
 * Exposes:
 *   Dialog.alert(message, title?)  -> Promise<void>
 *   Dialog.confirm(message, title?, opts?) -> Promise<boolean>
 *   Dialog.prompt(message, default?, title?) -> Promise<string | null>
 *
 * Also overrides window.alert/confirm/prompt so any existing call uses the
 * custom UI automatically.
 */
(function () {
  const dlg = document.getElementById('dialog');
  const iconEl = document.getElementById('dialogIcon');
  const titleEl = document.getElementById('dialogTitle');
  const msgEl = document.getElementById('dialogMessage');
  const inputWrap = document.getElementById('dialogInputWrap');
  const input = document.getElementById('dialogInput');
  const actions = document.getElementById('dialogActions');

  const ICONS = {
    info: { bg: 'bg-blue-500/20 text-blue-300', html: 'ℹ️' },
    success: { bg: 'bg-emerald-500/20 text-emerald-300', html: '✅' },
    warn: { bg: 'bg-amber-500/20 text-amber-300', html: '⚠️' },
    danger: { bg: 'bg-red-500/20 text-red-400', html: '🗑️' },
    question: { bg: 'bg-indigo-500/20 text-indigo-300', html: '❓' },
    edit: { bg: 'bg-pink-500/20 text-pink-300', html: '✏️' }
  };

  let open = false;

  function setIcon(kind) {
    const k = ICONS[kind] || ICONS.info;
    iconEl.className = 'shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-xl ' + k.bg;
    iconEl.innerHTML = k.html;
  }

  function show({ title, message, kind = 'info', input: withInput = false, defaultValue = '',
                 buttons, inputType = 'text', inputMax = 200 }) {
    if (open) return Promise.reject(new Error('Dialog already open'));

    titleEl.textContent = title || '';
    msgEl.textContent = message || '';
    setIcon(kind);

    if (withInput) {
      inputWrap.classList.remove('hidden');
      input.type = inputType;
      input.value = defaultValue || '';
      input.maxLength = inputMax;
    } else {
      inputWrap.classList.add('hidden');
    }

    actions.innerHTML = '';
    const buttonDefs = buttons || [{ text: 'OK', value: true, primary: true }];
    const buttonEls = [];

    // Create resolve FIRST so button handlers can reference a live binding via closure.
    let resolve;
    const p = new Promise(res => { resolve = res; });

    function close(val) {
      if (!open) return; // double-click guard
      open = false;
      dlg.classList.add('hidden');
      dlg.style.display = 'none';
      document.removeEventListener('keydown', keyHandler, true);
      dlg.onclick = null;
      resolve(val);
    }

    function keyHandler(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        const cancel = buttonDefs.find(b => b.value === false || b.value === null);
        close(cancel ? cancel.value : (buttonDefs[0] && buttonDefs[0].value));
      } else if (e.key === 'Enter') {
        // For prompts Enter submits; for confirms/alert Enter submits when a button is focused
        if (withInput || document.activeElement === input || buttonEls.includes(document.activeElement)) {
          e.preventDefault();
          const primary = buttonDefs.find(b => b.primary) || buttonDefs[buttonDefs.length - 1];
          const val = withInput ? input.value : primary.value;
          if (withInput && primary.validate && !primary.validate(val)) return;
          close(withInput ? val : primary.value);
        }
      }
    }

    buttonDefs.forEach((b) => {
      const btn = document.createElement('button');
      btn.textContent = b.text;
      let cls = 'px-4 py-2 rounded-lg text-sm font-semibold transition focus:outline-none focus:ring-2 ';
      if (b.danger) {
        cls += 'bg-red-600 hover:bg-red-500 text-white focus:ring-red-500';
      } else if (b.primary) {
        cls += 'bg-gradient-to-r from-pink-600 to-indigo-600 hover:from-pink-500 hover:to-indigo-500 text-white shadow focus:ring-pink-500';
      } else {
        cls += 'bg-slate-700 hover:bg-slate-600 text-slate-100 focus:ring-slate-500';
      }
      btn.className = cls;
      btn.addEventListener('click', () => close(b.value));
      actions.appendChild(btn);
      buttonEls.push(btn);
    });

    // Click on backdrop to cancel (only for confirm/alert — not prompt, to avoid accidental loss)
    dlg.onclick = (e) => {
      if (e.target === dlg) {
        if (!withInput) {
          const cancel = buttonDefs.find(b => b.value === false || b.value === null);
          close(cancel ? cancel.value : false);
        }
      }
    };

    open = true;
    dlg.classList.remove('hidden');
    dlg.style.display = 'flex';

    document.addEventListener('keydown', keyHandler, true);

    // Focus appropriate element after dialog is visible
    setTimeout(() => {
      if (withInput) {
        input.focus();
        input.select();
      } else if (buttonEls.length) {
        // Default focus = first "cancel" button (least destructive), else primary
        const cancel = buttonEls.find(b => b.value === false || b.value === null) || buttonEls[buttonEls.length - 1];
        cancel.focus();
      }
    }, 30);

    return p;
  }

  const Dialog = {
    alert(message, title = 'Notice') {
      return show({
        title, message, kind: 'info',
        buttons: [{ text: 'OK', value: true, primary: true }]
      });
    },
    confirm(message, title = 'Are you sure?', opts = {}) {
      const danger = opts.danger !== false && (opts.danger || /delete|remove|permanent/i.test(message + ' ' + title));
      return show({
        title, message,
        kind: opts.kind || (danger ? 'danger' : 'question'),
        buttons: [
          { text: opts.cancelText || 'Cancel', value: false },
          { text: opts.okText || 'OK', value: true, primary: true, danger }
        ]
      });
    },
    prompt(message, defaultValue = '', title = 'Enter value') {
      return show({
        title, message, kind: 'edit', input: true, defaultValue,
        buttons: [
          { text: 'Cancel', value: null },
          { text: 'OK', value: true, primary: true,
            validate(val) { return val && val.trim().length > 0; } }
        ]
      }).then(val => {
        // "OK" returns the input value; "Cancel" returns null
        if (val === null) return null;
        const v = (val || '').trim();
        return v.length ? v : null;
      });
    }
  };

  window.Dialog = Dialog;

  // Override native dialogs so existing code + any lib uses our custom UI.
  // We keep native versions around just in case.
  window._nativeAlert = window.alert;
  window._nativeConfirm = window.confirm;
  window._nativePrompt = window.prompt;

  // Note: native alert/confirm/prompt are synchronous-blocking; we can't truly
  // replicate that, but all calls in this app await the result. To be safe,
  // we DON'T globally override them — instead we replace each call site with
  // `await Dialog.xxx(...)`. This is safer because existing event handlers
  // using `if (confirm(...))` would break if we made it async.
})();
