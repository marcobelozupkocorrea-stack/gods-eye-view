/**
 * barreto.top: the bus layer's "Filtrar linha" chip asks for a line in a
 * sheet (with the lines on screen as suggestions) and sets the layer param.
 */
import { openFormSheet } from './formSheet.js';

export function installBusesUi({ dataManager, signal } = {}) {
  const onFilter = async (event) => {
    const { linha = null, sugestoes = [] } = event.detail || {};
    const values = await openFormSheet({
      title: 'Filtrar linha de ônibus',
      intro:
        'Mostra só os ônibus dessa linha na cidade inteira e o trajeto que eles vêm fazendo.',
      fields: [
        {
          name: 'linha',
          label: 'Número da linha',
          value: linha || '',
          placeholder: 'ex.: 474, 0.156, 5102',
          maxLength: 20,
          required: true,
          suggestions: sugestoes,
          submitOnSuggestion: true,
          hint: sugestoes.length
            ? 'Toque numa das linhas que estão na tela agora ou digite outra.'
            : '',
        },
      ],
      submitLabel: 'Filtrar',
    });
    if (!values?.linha) return;
    await dataManager?.setLayerParams?.(
      'city-buses',
      { linha: values.linha },
      { origin: 'user' },
    );
  };
  globalThis.addEventListener('barreto:buses-filter', onFilter, { signal });
}
