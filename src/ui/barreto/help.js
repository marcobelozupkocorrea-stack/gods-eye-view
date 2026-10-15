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
    icon: 'rainy',
    title: 'Chuva e tempo agora',
    items: [
      '<b>Radar de chuva (Brasil)</b>: imagens dos radares do CPTEC/INPE, Cemaden, DECEA e SIPAM, a cada 5–10 min. Cores: azul/verde = chuva fraca, amarelo/vermelho = forte. Onde não há radar, o mapa fica vazio — isso não quer dizer que não chove.',
      '<b>Nuvens por satélite</b>: GOES-19 do CPTEC/INPE sobre a América do Sul a cada 10 min. Azul e roxo = topos de nuvem muito frios (tempestades). Em <b>TEMPO</b> dá para escolher <i>Só nuvens</i> ou <i>Completa</i> e ver as últimas 2 horas com <i>Animar</i>.',
      '<b>Bicicletas compartilhadas</b>: estações da Bike Itaú (SP, Rio, Recife, Salvador, Porto Alegre, Brasília, Curitiba) com bicicletas livres agora.',
    ],
  },
  {
    icon: 'directions_car',
    title: 'Rotas com trânsito',
    items: [
      'Toque no botão <span class="ms">directions</span> ao lado da busca (ou em <b>Rota</b> num resultado da busca). Digite de onde e para onde: endereço, CEP, nome de lugar, um dos <b>Meus lugares</b> ou <b>Minha localização</b>.',
      'De carro, a rota considera o <b>trânsito ao vivo</b> (TomTom): atraso, hora de chegada, trechos lentos em amarelo/laranja/vermelho, acidentes e obras com ícone no mapa, e até 3 opções. Atualiza sozinha a cada 5 min.',
      '<b>Saída</b>: escolha "daqui a 1 hora" ou um dia e hora para ver quanto vai demorar com a previsão de trânsito. <b>Adicionar parada</b> põe até 10 pontos no caminho. <b>Sem pedágio</b> evita pedágios.',
      '<b>No caminho</b> mostra alertas do INMET e da Defesa Civil, chuva no radar, Cemaden e câmeras ao longo da rota — toque num item para ir até ele.',
      'Salve lugares (Casa, Trabalho…) em <b>Meus lugares</b>: ficam na sua conta, no celular e no computador. Para dirigir com voz e GPS, use <b>Abrir no Waze</b> ou <b>Google Maps</b>.',
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
      'Use a <b>busca</b> no alto: digite lugar, endereço com número ou CEP — os resultados aparecem enquanto você digita (Brasil primeiro).',
      'Embaixo da busca aparece <b>onde você está olhando</b> (bairro, cidade, estado). <b>Limites</b> desenha a divisa dessa área no mapa.',
      'Na barra <b>LOCAL</b> (embaixo) há atalhos para capitais.',
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
    icon: 'install_mobile',
    title: 'Instalar como aplicativo',
    items: [
      '<b>Android (Chrome):</b> menu <b>⋮</b> → <b>Instalar app</b> (ou "Adicionar à tela inicial").',
      '<b>iPhone (Safari):</b> botão <b>Compartilhar</b> → <b>Adicionar à Tela de Início</b>.',
      '<b>Computador (Chrome/Edge):</b> ícone de instalar na barra de endereço.',
      'O app abre em tela cheia, direto no mapa, com o mesmo login.',
      '<b>No celular:</b> a barra de baixo tem <b>Mapa · Alertas · Camadas · Rota · Mais</b>. Cada uma abre uma folha: arraste a alça para cima para ver tudo, para baixo (ou o botão Voltar) para fechar.',
      'À direita do mapa: <span class="ms">my_location</span> sua localização, <b>2D/3D</b> e a bússola (aparece quando o mapa está girado; toque para apontar ao norte).',
      'Segure o ícone do app na tela inicial para atalhos: Alertas, Rota, Buscar e Camadas. Sem internet, o app avisa e volta sozinho.',
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
      <div class="barreto-help-install" hidden>
        <button type="button"><span class="material-symbols-outlined" aria-hidden="true">install_mobile</span> Instalar o app neste aparelho</button>
      </div>
      <footer>Fontes: INMET, Defesa Civil (IDAP), Cemaden, INPE (DETER e Queimadas), NASA FIRMS, DER-SP, CET-SP e as fontes originais do God's Eye View.</footer>
    </div>`;
  document.body.append(dialog);

  // Offer a one-tap install where the browser supports it (Chrome/Edge/Android).
  let installPrompt = null;
  const installBox = dialog.querySelector('.barreto-help-install');
  globalThis.addEventListener?.(
    'beforeinstallprompt',
    (event) => {
      event.preventDefault();
      installPrompt = event;
      installBox.hidden = false;
    },
    { signal },
  );
  globalThis.addEventListener?.(
    'appinstalled',
    () => {
      installPrompt = null;
      installBox.hidden = true;
    },
    { signal },
  );
  installBox.querySelector('button').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    try {
      await installPrompt.userChoice;
    } finally {
      installPrompt = null;
      installBox.hidden = true;
    }
  });

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
