/**
 * barreto.top: "Como usar" — a Portuguese quick guide opened from a "?"
 * button in the top action bar (and from the welcome dialog).
 */
const SECTIONS = [
  {
    icon: 'explore',
    title: 'Navegar no globo',
    items: [
      '<b>Computador:</b> arraste para girar · roda do mouse para aproximar · <b>Ctrl + arrastar</b> (ou botão do meio) para inclinar.',
      '<b>Celular:</b> um dedo move · dois dedos em pinça aproximam · dois dedos deslizando juntos inclinam.',
      'Botões no topo: <span class="ms">public</span> volta ao globo inteiro · <b>N</b> aponta para o norte · <span class="ms">view_in_ar</span> alterna vista de cima / inclinada.',
    ],
  },
  {
    icon: 'warning',
    title: 'Ver o que está acontecendo no Brasil',
    items: [
      'Abra o painel <b>BRASIL AGORA</b> (canto superior esquerdo, botão <b>+</b>).',
      'Ele lista os alertas ativos do INMET, da Defesa Civil e do Cemaden, e os alertas de desmatamento do INPE.',
      '<b>Toque num item</b> e o mapa vai até o local e abre os detalhes.',
    ],
  },
  {
    icon: 'filter_alt',
    title: 'Filtrar',
    items: [
      'No BRASIL AGORA, ligue ou desligue as <b>fontes</b> nos botões (INMET, Defesa Civil, Cemaden, Desmatamento).',
      'Escolha a <b>gravidade</b> (todas, alta ou maior, só a máxima).',
      'Digite um <b>estado ou cidade</b> (ex.: <i>SP</i>, <i>Ubatuba</i>, <i>Rio Grande do Sul</i>). Acentos não importam.',
    ],
  },
  {
    icon: 'layers',
    title: 'Ligar e desligar camadas',
    items: [
      'Painel <b>CAMADAS</b>: cada linha tem um botão <b>LIGADA / DESLIGADA</b>.',
      'Com a camada ligada aparece a <b>legenda</b> com as cores e quantas ocorrências há de cada tipo.',
      'O botão <span class="ms">layers_clear</span> no topo desliga todas de uma vez.',
    ],
  },
  {
    icon: 'touch_app',
    title: 'Ver os detalhes de algo no mapa',
    items: [
      '<b>Toque ou clique</b> num ponto, área colorida, avião, navio ou câmera para abrir o cartão de informações.',
      'Toque num lugar vazio do mapa para fechar o cartão.',
      'Cores dos alertas: amarelo = atenção · laranja = alto/severo · vermelho = máximo.',
    ],
  },
  {
    icon: 'videocam',
    title: 'Câmeras ao vivo',
    items: [
      'Ligue <b>Câmeras públicas</b> em CAMADAS e aproxime de uma cidade (ex.: São Paulo, litoral norte de SP).',
      'Toque no ícone da câmera: as do DER-SP mostram vídeo ao vivo; as da CET mostram fotos atualizadas.',
      'Vídeo ao vivo começa em alguns segundos. No máximo 6 vídeos ao mesmo tempo para todos.',
    ],
  },
  {
    icon: 'search',
    title: 'Ir até um lugar',
    items: [
      'Na barra <b>LOCAL</b> (embaixo), toque numa cidade brasileira ou digite um endereço, cidade ou coordenada e aperte Enter.',
    ],
  },
  {
    icon: 'share',
    title: 'Compartilhar o que você está vendo',
    items: [
      'O botão <span class="ms">link</span> copia um link com a posição e as camadas ligadas. Quem abrir (com login) vê a mesma coisa.',
    ],
  },
  {
    icon: 'keyboard',
    title: 'Atalhos de teclado (computador)',
    items: [
      '<b>F</b> painel de camadas · <b>H</b> mostra/oculta o HUD · <b>V</b> visão limpa · <b>O</b> órbita automática · <b>1 a 7</b> estilos visuais · <b>Esc</b> fecha.',
    ],
  },
];

export function initHelp({ signal } = {}) {
  const dialog = document.createElement('div');
  dialog.id = 'barreto-help';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'barreto-help-title');
  dialog.hidden = true;
  dialog.innerHTML = `
    <div class="barreto-help-card">
      <header>
        <h2 id="barreto-help-title">Como usar</h2>
        <button type="button" class="barreto-help-close" aria-label="Fechar o guia">
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      </header>
      <div class="barreto-help-body">
        ${SECTIONS.map(
          (section) => `
          <section>
            <h3><span class="material-symbols-outlined" aria-hidden="true">${section.icon}</span>${section.title}</h3>
            <ul>${section.items.map((item) => `<li>${item.replace(/<span class="ms">([a-z_]+)<\/span>/g, '<span class="material-symbols-outlined barreto-inline-icon" aria-hidden="true">$1</span>')}</li>`).join('')}</ul>
          </section>`,
        ).join('')}
      </div>
      <footer>Fontes: INMET, Defesa Civil (IDAP), Cemaden, INPE (DETER e Queimadas), NASA FIRMS, DER-SP, CET-SP e as fontes originais do God's Eye View.</footer>
    </div>`;
  document.body.append(dialog);

  let lastFocus = null;
  const open = () => {
    lastFocus = document.activeElement;
    dialog.hidden = false;
    requestAnimationFrame(() => dialog.classList.add('visible'));
    dialog.querySelector('.barreto-help-close')?.focus();
  };
  const close = () => {
    dialog.classList.remove('visible');
    dialog.hidden = true;
    lastFocus?.focus?.();
  };
  dialog.querySelector('.barreto-help-close').addEventListener('click', close);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') close();
  });

  const nav = document.getElementById('top-center-actions');
  let button = null;
  if (nav) {
    button = document.createElement('button');
    button.type = 'button';
    button.id = 'barreto-help-btn';
    button.setAttribute('aria-label', 'Como usar (ajuda)');
    button.title = 'Como usar';
    button.innerHTML =
      '<span class="material-symbols-outlined" aria-hidden="true">help</span>';
    button.addEventListener('click', open);
    nav.append(button);
  }
  signal?.addEventListener('abort', () => {
    dialog.remove();
    button?.remove();
  });
  return { open, close };
}
