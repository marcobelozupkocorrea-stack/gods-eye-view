/**
 * barreto.top: a small form in a sheet (bottom of the screen on phones, a
 * centred card on computers) instead of the browser's prompt() boxes.
 *
 *   const values = await openFormSheet({
 *     title: 'Nova área',
 *     fields: [
 *       { name: 'nome', label: 'Nome', value: 'Casa', required: true },
 *       { name: 'raioKm', label: 'Raio', type: 'range', min: 1, max: 100,
 *         value: 5, unit: 'km', presets: [2, 5, 10, 25, 50] },
 *     ],
 *     submitLabel: 'Criar área',
 *     onChange: (values) => …,   // live, e.g. to preview on the map
 *   });
 *   // → { nome, raioKm } or null when cancelled
 */

let open = null;

const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child) node.append(child);
  return node;
};

/** Close any sheet that is open (it resolves as cancelled). */
export function closeFormSheet() {
  open?.cancel();
}

export function openFormSheet({
  title,
  intro = '',
  fields = [],
  submitLabel = 'Salvar',
  cancelLabel = 'Cancelar',
  onChange = null,
} = {}) {
  closeFormSheet();
  return new Promise((resolve) => {
    const back = el('div', { className: 'barreto-form-backdrop' });
    const form = el('form', {
      className: 'barreto-form-sheet',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': title,
      novalidate: true,
    });
    const inputs = {};
    const rows = [];
    for (const field of fields) {
      const id = `barreto-form-${field.name}`;
      if (field.type === 'range') {
        const output = el('output', {
          className: 'barreto-form-value',
          for: id,
        });
        const input = el('input', {
          id,
          name: field.name,
          type: 'range',
          min: field.min ?? 0,
          max: field.max ?? 100,
          step: field.step ?? 1,
          value: field.value ?? field.min ?? 0,
        });
        const show = () => {
          output.textContent = `${input.value}${field.unit ? ` ${field.unit}` : ''}`;
        };
        show();
        input.addEventListener('input', show);
        const presets = (field.presets || []).map((v) => {
          const chip = el('button', {
            type: 'button',
            className: 'barreto-form-chip',
            text: `${v}${field.unit ? ` ${field.unit}` : ''}`,
          });
          chip.addEventListener('click', () => {
            input.value = String(v);
            show();
            emit();
          });
          return chip;
        });
        inputs[field.name] = input;
        rows.push(
          el('div', { className: 'barreto-form-row' }, [
            el('div', { className: 'barreto-form-label-row' }, [
              el('label', { for: id, text: field.label }),
              output,
            ]),
            input,
            presets.length
              ? el('div', { className: 'barreto-form-chips' }, presets)
              : null,
            field.hint
              ? el('p', { className: 'barreto-form-hint', text: field.hint })
              : null,
          ]),
        );
      } else {
        const input = el('input', {
          id,
          name: field.name,
          type: 'text',
          value: field.value ?? '',
          placeholder: field.placeholder || '',
          maxlength: field.maxLength ?? 60,
          autocomplete: 'off',
          enterkeyhint: 'done',
        });
        inputs[field.name] = input;
        const suggestions = (field.suggestions || []).map((v) => {
          const chip = el('button', {
            type: 'button',
            className: 'barreto-form-chip',
            text: String(v),
          });
          chip.addEventListener('click', () => {
            input.value = String(v);
            emit();
            if (field.submitOnSuggestion) form.requestSubmit();
          });
          return chip;
        });
        rows.push(
          el('div', { className: 'barreto-form-row' }, [
            el('label', { for: id, text: field.label }),
            input,
            suggestions.length
              ? el('div', { className: 'barreto-form-chips' }, suggestions)
              : null,
            field.hint
              ? el('p', { className: 'barreto-form-hint', text: field.hint })
              : null,
          ]),
        );
      }
    }
    const error = el('p', { className: 'barreto-form-error', role: 'alert' });
    error.hidden = true;
    const cancel = el('button', {
      type: 'button',
      className: 'al-btn barreto-form-cancel',
      text: cancelLabel,
    });
    const submit = el('button', {
      type: 'submit',
      className: 'al-btn barreto-form-submit',
      text: submitLabel,
    });
    form.append(
      el('div', { className: 'barreto-form-grip', 'aria-hidden': 'true' }),
      el('h2', { className: 'barreto-form-title', text: title }),
      intro ? el('p', { className: 'barreto-form-intro', text: intro }) : null,
      ...rows,
      error,
      el('div', { className: 'barreto-form-actions' }, [cancel, submit]),
    );

    const values = () => {
      const out = {};
      for (const field of fields) {
        const raw = inputs[field.name].value;
        out[field.name] = field.type === 'range' ? Number(raw) : raw.trim();
      }
      return out;
    };
    const emit = () => {
      try {
        onChange?.(values());
      } catch {
        /* preview only */
      }
    };
    for (const input of Object.values(inputs))
      input.addEventListener('input', emit);

    const done = (result) => {
      if (open?.form !== form) return;
      open = null;
      document.removeEventListener('keydown', onKey, true);
      form.classList.remove('visible');
      back.classList.remove('visible');
      setTimeout(() => {
        form.remove();
        back.remove();
      }, 180);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(null);
      }
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = values();
      const missing = fields.find((f) => f.required && !v[f.name]);
      if (missing) {
        error.textContent = `Preencha ${missing.label.toLowerCase()}.`;
        error.hidden = false;
        inputs[missing.name].focus();
        return;
      }
      done(v);
    });
    cancel.addEventListener('click', () => done(null));
    back.addEventListener('click', () => done(null));
    document.addEventListener('keydown', onKey, true);

    open = { form, cancel: () => done(null) };
    document.body.append(back, form);
    requestAnimationFrame(() => {
      form.classList.add('visible');
      back.classList.add('visible');
      const first = form.querySelector('input[type="text"]');
      // Phones: focusing opens the keyboard over the map; only focus there
      // when the field is empty.
      if (first && (!first.value || !matchMedia('(pointer: coarse)').matches))
        first.focus();
    });
    emit();
  });
}
