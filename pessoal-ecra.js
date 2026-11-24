/* DOE · Telemóvel — os ecrãs do Pessoal. Fase 1 (16 nov 2026): SÓ PARA LER — o separador Pessoal (o saldo de férias com a
   barra, «A seguir», «À espera de decisão», as entradas de Férias, Faltas e ausências, Horas e atrasos e Despesas), o ecrã
   Férias (de onde vêm os dias, os pedidos, o ano dia a dia, os feriados e fechos), o das Faltas e ausências (por mês) e o
   das Despesas (por reembolsar, pagas, anuladas); cada pedido, falta e despesa abre numa folha com o estado e o histórico.
   Fase 2 (17 nov 2026): PEDIR, CORRIGIR E CANCELAR férias, faltas, Teletrabalho e Out of Office (ausencias.js), só quando o
   servidor dá a funcionalidade `ausencias` (sem ela, tudo fica só para ler, como na F1): «Pedir férias» (datas e rever),
   «Falta ou ausência» (tipo, dias e detalhe, comprovativo e envio), o «Feito» com o estado do envio e o Desfazer de 5 s,
   «Por enviar» com o motivo do servidor («Mudar» ou «Desistir»), e na folha de cada pedido Corrigir e Cancelar pelo `pode`.
   Fase 3 (23 nov 2026): REGISTAR, CORRIGIR, ANULAR, MARCAR «PAGA» E DESFAZER «PAGA» as despesas (despesas.js), só quando o
   servidor dá a funcionalidade `despesas` (sem ela, as despesas só se lêem e o «Despesa» fica «Em breve»): um formulário de
   um ecrã (data, categoria, valor, imputação a obra ou departamento, fatura em papel, observações), a mesma fila, o mesmo
   Desfazer e o mesmo «Por enviar»; na folha de cada despesa as acções do `pode`. Corrigir uma despesa que já foi para a folha
   (Aguarda assinatura ou Paga) pede confirmação antes de enviar (`confirmouFolha`), e o 409 JA_NA_FOLHA leva ao mesmo aviso.
   Sem fotos de talão (decisão do Pedro): a fatura em papel é só sim/não, como no computador.
   Desenho: o protótipo validado pelo Pedro (docs/prototipos/telemovel-perfis/pessoal.js). A lógica é a de pessoal.js e de
   ausencias.js (puras, testadas em Node); a casca dá o kit (`K`).
   Regras:
   - tudo o que vem do servidor entra por textContent;
   - quem tem Pessoal decide-o o servidor (`pessoal` nas funcionalidades); a Edge de antes da F1 (403 TOKEN_DE_AMBITO)
     deixa o separador «Em breve» nesta abertura, sem pedir o login e sem tocar na fila;
   - os botões de corrigir e cancelar são os do `pode` do servidor; a página não tem segunda regra (os avisos antes de
     enviar, sobreposição, mês fechado, acima do saldo, são só avisos: o servidor decide e o motivo dele volta);
   - os comandos vão na fila única da casca (tipo 'aus', por conta, no IndexedDB): sem rede ficam «por enviar» e seguem
     sozinhos; sem a funcionalidade (Edge recuada) ficam lá, nunca se apagam sozinhos;
   - nenhuma foto nem ficheiro: o comprovativo é a caixa «Tenho documento comprovativo» (entregue ao RH, como hoje);
   - a leitura é a pedido (ao abrir o separador, ao voltar a rede, ao tocar na linha da data), em memória, e a cópia fica na
     localStorage, numa chave própria com a conta dentro (`doeMovel.pessoal`, revisão de f673e387, P1), para abrir sem rede
     («a cópia é das 08:12»); se não couber, fica só em memória e nada mais deixa de se gravar. Com o telemóvel desligado
     (TOKEN_REVOGADO), ao Sair e quando entra outra conta, a casca apaga-a com as outras leituras. */
(function () {
  'use strict';
  var P = self.DoeMovelPessoal, D = self.DoeMovelDiario, AU = self.DoeMovelAus || null, DS = self.DoeMovelDesp || null;
  if (!P || !D) return;
  var MS_RELER = 30 * 1000, ESPERAS = self.DOE_MOVEL_ESPERAS_LER || [5000, 30000, 120000], ADIAR = self.DOE_MOVEL_TF_ADIAR || 5000;
  var VISTAS = ['v-pessoal', 'v-pes-ferias', 'v-pes-faltas', 'v-pes-despesas', 'v-pes-form', 'v-pes-feito', 'v-pes-desp-form'];   // + o formulário das despesas (F3)
  var TIPO_EMPRESA = { ARQUITETO: 'Arquitecto', PROMOTOR: 'Promotor', CONSTRUTOR: 'Construtor', GESTOR_PROJECTO: 'Gestor de Projecto', PROJETISTA: 'Projectista' };

  function criar(K) {
    var S = estadoNovo();
    var el = K.el, bt = K.bt, ic = K.ic, limpar = K.limpar, $ = function (id) { return document.getElementById(id); };
    function estadoNovo() { return { lendo: false, erro: '', fora: false, recusa: '', semLigacao: false, lidoMs: 0, falhas: 0, timer: null, filtroFer: 'seguir', vistaFer: 'lista', filtroFt: 'mes', filtroDp: 'reemb', copia: null, soMemoria: false, form: null, formErro: null, feito: null, dform: null, dformErro: null }; }
    function feriados() { return self.DOE_MOVEL_FERIADOS || {}; }
    // ── A cópia da conta: em memória e no localStorage, na chave própria (P1) ──
    function lsLer() { try { return localStorage.getItem(P.LS_PESSOAL); } catch (e) { return null; } }
    function lsApagar() { try { localStorage.removeItem(P.LS_PESSOAL); } catch (e) { /* sem armazenamento */ } }
    function copia() {
      var conta = K.contaId(); if (!conta) return null;
      if (S.copia && S.copia.contaId === conta) return S.copia;
      var t = lsLer(), c = t ? P.deGuardado(t, conta) : null;
      if (t && !c) lsApagar();   // de outra conta (ou estragada): sai do telemóvel
      S.copia = c ? Object.assign({ contaId: conta }, c) : null;
      return S.copia;
    }
    function gravarLs(conta, data, lidoEm) {
      var g = P.paraGuardar(conta, data, lidoEm), ok = false;
      if (g) { try { localStorage.setItem(P.LS_PESSOAL, g.texto); ok = true; } catch (e) { ok = false; } }
      if (!ok) lsApagar();   // não coube: fica só em memória (uma cópia velha não fica a fingir que é a de agora)
      S.soMemoria = !ok;
    }
    function guardarCopia(data) {
      var conta = K.contaId(), lidoEm = new Date().toISOString();
      S.copia = { contaId: conta, data: data, lidoEm: lidoEm, cortada: false };   // o ecrã mostra sempre a leitura inteira
      gravarLs(conta, data, lidoEm);
    }
    /** Um registo devolvido por um comando entra na cópia (com o saldo ou o «por reembolsar» acertado), sem mudar a hora da
        leitura. L: a lógica do registo (ausencias.js, por omissão, ou despesas.js). */
    function atualizarCopia(registo, L) {
      var c = copia(), Lg = L || AU; if (!c || !Lg) return;
      Lg.aplicarResposta(c.data, registo, feriados());
      gravarLs(c.contaId, c.data, c.lidoEm);
    }
    function apagarCopia() { S.copia = null; lsApagar(); }
    /** A cópia do servidor, tal e qual (a base dos comandos: a `versao` que a pessoa viu). */
    function dados() { var c = copia(); return c ? c.data : null; }
    /** O que se mostra: a cópia com os comandos por enviar por cima (um pedido por enviar vê-se logo). */
    function dadosVista() { var d = dados(); if (AU && d) d = AU.comPendentes(d, K.fila(), K.contaId(), feriados()); if (DS && d) d = DS.comPendentes(d, K.fila(), K.contaId()); return d; }
    function naVista() { return VISTAS.indexOf(K.vista()) >= 0; }

    // ── Quem tem Pessoal (o servidor decide; a casca junta o quemVe()) ──
    /** A funcionalidade vem do servidor e o servidor não disse «não» nesta abertura. */
    function ativo() { return !S.fora && !S.recusa && P.temFuncionalidade(K.funcsPessoal()); }
    /** O servidor disse que esta conta não tem Pessoal (só de telemóvel, externa): o separador sai nesta abertura. */
    function recusado() { return S.recusa === 'SEM_PESSOAL' || S.recusa === 'CONTA_EXTERNA' || S.recusa === 'PAPEL_SEM_ESCRITA'; }   // revisão (C1): a conta que passou a só leitura perde-o
    /** F2: o servidor recebe os comandos das ausências desta conta (`ausencias`). Sem ela, o Pessoal só lê. */
    function ausDisponivel() { return !!AU && AU.disponivel(K.funcsPessoal()); }
    function podeEscrever() { return ausDisponivel() && ativo(); }
    /** F3: o servidor recebe os comandos das despesas desta conta (`despesas`). Sem ela, as despesas só se lêem. */
    function despDisponivel() { return !!DS && DS.disponivel(K.funcsPessoal()); }
    function despPodeEscrever() { return despDisponivel() && ativo(); }

    // ── Leitura ──
    async function ler(forcar) {
      if (S.lendo || !K.sessao()) return;
      if (!K.online() || !K.A.sessaoValida()) { redesenhar(); return; }
      if (!forcar && Date.now() - S.lidoMs < MS_RELER && copia()) { redesenhar(); return; }
      var conta = K.contaId();
      S.lendo = true; clearTimeout(S.timer); redesenhar();
      var r;
      try { r = await P.lerPessoal(K.deps()); } finally { S.lendo = false; }
      if (K.contaId() !== conta) return;   // entrou outra conta entretanto: esta leitura não é dela
      if (r.ok) {
        guardarCopia(r.data);
        S.erro = ''; S.recusa = ''; S.semLigacao = false; S.falhas = 0; S.lidoMs = Date.now();
        redesenhar(); return;
      }
      var f = P.falha(r);
      if (f.tipo === 'rede') { S.semLigacao = K.online(); redesenhar(); return; }
      if (f.tipo === 'embreve') { S.fora = true; S.foraTexto = f.texto; sair(f.texto); return; }
      if (f.tipo === 'recusa') {
        apagarCopia();   // a conta deixou de ter Pessoal: a cópia não fica no telemóvel
        S.recusa = f.code;
        if (f.tirar) { sair(f.texto); return; }
        S.erro = f.texto; K.desenharNav(); redesenhar(); return;   // revisão de 48b0111b (P2): a barra marca-o e o ecrã da conta diz este motivo
      }
      if (f.tipo === 'login') { K.talvezLogin({ accao: 'login', texto: f.texto, revogado: f.revogado }); return; }
      S.erro = f.texto;
      if (f.tipo === 'repetir') {
        var ms = Math.max(ESPERAS[Math.min(S.falhas, ESPERAS.length - 1)], (f.retryAfter || 0) * 1000); S.falhas++;
        S.timer = setTimeout(function () { if (naVista()) ler(true); }, ms);
      }
      redesenhar();
    }
    /** O servidor disse «não» (Em breve, ou a conta sem Pessoal): o separador muda já; quem estava num ecrã do Pessoal volta ao Hoje. */
    function sair(texto) {
      K.desenharNav();
      if (naVista()) { K.irHoje(); K.toast(texto, { ms: 6000 }); }
    }

    // ── Peças ──
    function linha(o) {   // { ic | ico, cls, t, s, est: {t, cls} | v (elemento), fn, k }
      var b = o.fn ? bt('mv-pes-l') : el('div', 'mv-pes-l leve');
      if (o.ico) { var io2 = ic(o.ico, 'mv-pes-ico'); b.appendChild(io2); }   // o ícone sem círculo (os acessos do Pessoal)
      else { var i = el('span', 'mv-pes-ic' + (o.cls ? ' ' + o.cls : '')); i.setAttribute('aria-hidden', 'true'); i.appendChild(ic(o.ic)); b.appendChild(i); }
      var t = el('span', 'mv-pes-lt'); t.appendChild(el('b', null, o.t)); if (o.s) t.appendChild(el('small', null, o.s)); b.appendChild(t);
      if (o.est) b.appendChild(el('span', 'mv-pes-est' + (o.est.cls ? ' ' + o.est.cls : ''), o.est.t));
      else if (o.v) { var vw = el('span', 'mv-pes-vw'); vw.appendChild(o.v); if (o.fn) vw.appendChild(ic('chev')); b.appendChild(vw); }   // o valor vivo à direita, com a seta junto dele (nunca cai sozinha)
      else if (o.fn) b.appendChild(ic('chev'));
      if (o.fn) { b.addEventListener('click', o.fn); if (o.k) b.setAttribute('data-k', o.k); }
      return b;
    }
    function grupo(titulo, linhas, meta) {
      var s = el('section', 'mv-sec'), h = el('div', 'mv-sec-h'); h.appendChild(el('h2', null, titulo)); if (meta != null) h.appendChild(el('span', 'mv-sec-m', meta)); s.appendChild(h);
      var g = el('div', 'mv-grupo'); linhas.forEach(function (l) { if (l) g.appendChild(l); }); s.appendChild(g);
      return s;
    }
    function pilula(e) { return el('span', 'mv-pes-est' + (e.cls ? ' ' + e.cls : ''), e.t); }
    function segm(rotulo, ops, atual, k, fn) {
      var w = el('div', 'mv-segm'); w.setAttribute('role', 'group'); w.setAttribute('aria-label', rotulo);
      ops.forEach(function (o) { var b = bt('', o[1]); b.setAttribute('aria-pressed', String(atual === o[0])); b.setAttribute('data-k', k + '-' + o[0]); b.addEventListener('click', function () { fn(o[0]); }); w.appendChild(b); });
      return w;
    }
    function faixa(cls, nomeIc, texto, titulo) { var f = el('div', 'mv-faixa' + (cls ? ' ' + cls : '')); f.setAttribute('role', 'status'); f.appendChild(ic(nomeIc || 'alerta')); var t = el('span', 'mv-faixa-t'); if (titulo) { t.appendChild(el('b', null, titulo)); t.appendChild(document.createTextNode(' · ')); } t.appendChild(document.createTextNode(texto)); f.appendChild(t); return f; }
    function barraEl(s) {
      var x = P.barra(s), w = el('div', 'mv-pes-b3'); w.setAttribute('role', 'img'); w.setAttribute('aria-label', x.aria);
      [['goz', x.goz], ['mar', x.mar], ['pen', x.pen]].forEach(function (z) { if (z[1] > 0) { var i = el('i', z[0]); i.style.width = z[1] + '%'; w.appendChild(i); } });
      var lg = el('div', 'mv-leg linha'); lg.setAttribute('aria-hidden', 'true');
      [['goz', x.n.goz, 'gozados'], ['mar', x.n.mar, 'marcados, ainda por gozar'], ['pen', x.n.pen, 'pendentes'], ['liv', x.n.liv, 'livres']].forEach(function (z) { var it = el('span'); it.appendChild(el('i', z[0])); it.appendChild(el('b', null, String(z[1]))); it.appendChild(document.createTextNode(' ' + z[2])); lg.appendChild(it); });
      return [w, lg];
    }
    /** A linha da data (como a do Hoje): quando foi lido, ou «sem rede · a cópia é das 08:12». Um toque volta a ler. */
    function linhaData() {
      var c = copia(), d = el('div', 'mv-hdata'), t, ama = false, dados_ = c ? D.textoDados(c.lidoEm, new Date()) : '';
      if (S.lendo) t = c ? 'a atualizar…' : 'a ler pela primeira vez…';
      else if (!K.online()) { t = c ? 'sem rede · a cópia é ' + dados_ : 'sem rede · ainda sem dados'; ama = true; }
      else if (!K.A.sessaoValida()) { t = c ? 'sessão acabada · a cópia é ' + dados_ : 'sessão acabada · ainda sem dados'; ama = true; }
      else if (S.semLigacao) { t = c ? 'sem ligação ao servidor · a cópia é ' + dados_ : 'sem ligação ao servidor'; ama = true; }
      else if (!c) t = 'ainda sem dados';
      else if (/^de /.test(dados_)) { t = 'a cópia é ' + dados_; ama = true; }
      else t = 'atualizado às ' + dados_.replace(/^das /, '');
      if (ama) d.classList.add('ama');
      var b = bt('', t); b.setAttribute('data-k', 'pes-data'); b.setAttribute('aria-label', t + '. Tocar para atualizar');
      b.addEventListener('click', function () { if (!K.online()) { K.toast('Sem rede. Fica a cópia que já tinhas.'); return; } ler(true); });
      d.appendChild(b);
      return d;
    }
    function faixaErro(v) { if (!S.erro) return; var f = el('div', 'mv-faixa ama'); f.setAttribute('role', 'status'); f.appendChild(ic('alerta')); f.appendChild(el('span', 'mv-faixa-t', S.erro)); v.appendChild(f); }
    function semDados(v) { v.appendChild(el('p', 'mv-nada', S.lendo || (K.online() && K.A.sessaoValida() && !S.erro) ? 'A ler o teu Pessoal…' : (S.recusa ? '' : 'Ainda não tenho o teu Pessoal neste telemóvel: aparece quando houver rede.'))); }
    function lead(v, txt) { var p = el('p', 'mv-lead', txt); p.tabIndex = -1; p.setAttribute('data-foco-inicial', ''); v.appendChild(p); v.appendChild(linhaData()); }
    function comFoco(v, fn) { var ae = document.activeElement, k = ae && v.contains(ae) ? ae.getAttribute('data-k') : null; limpar(v); fn(); if (k) { var y = v.querySelector('[data-k="' + k + '"]'); if (y) K.A.focar(y); } }

    // ── As linhas de cada coisa ──
    /** A pílula de um registo: o estado, ou «Por enviar» / «Não entrou» quando há um comando dele na fila. */
    function estadoDe(p) { return p.comErro ? { t: 'Não entrou', cls: 'neg' } : (p.porEnviar ? { t: 'Por enviar', cls: 'ama' } : P.estadoAusencia(p)); }
    function aoTocar(p, fn) { return function () { if (p.filaId && (p.porEnviar || p.comErro)) { var q = itemDaFila(p.filaId); if (q && (p.porEnviar || !p.versao)) { folhaItem(q); return; } } fn(p.id); }; }
    function linhaPedido(p, d) {
      var n = Number(p.diasUteis) || 0, e = estadoDe(p), et = p.porEnviar ? '' : P.etapaTexto(p);
      return linha({ ic: 'cal', cls: e.cls === 'neg' ? 'neg' : (e.cls === 'ama' ? 'ama' : (e.cls === 'pos' ? 'pos' : '')), t: P.intervalo(p.inicio, p.fim),
        s: 'Férias · ' + n + (n === 1 ? ' dia útil' : ' dias úteis') + (et ? ' · ' + et : '') + (String(p.inicio).slice(0, 4) !== String(d.ano) ? ' · conta em ' + String(p.inicio).slice(0, 4) : ''),
        est: e, k: 'ped-' + p.id, fn: aoTocar(p, folhaPedido) });
    }
    function linhaFalta(p, d) {
      var e = estadoDe(p), det = P.detalheFalta(p, d), pres = P.presenca(p), n = Number(p.dias) || 0;
      var s = P.intervalo(p.inicio, p.fim) + (pres ? '' : ' · ' + n + (n === 1 ? ' dia' : ' dias')) + (p.justificativos ? ' · justificativo no arquivo RH' : (p.anexo ? ' · com comprovativo' : ''));
      return linha({ ic: pres ? 'obra' : 'falta', cls: e.cls, t: p.rotulo + (det ? ' · ' + det : ''), s: s, est: e, k: 'ft-' + p.id, fn: aoTocar(p, folhaFalta) });
    }
    /** A pílula de uma despesa: o estado, ou «Por enviar» / «Não entrou» quando há um comando dela na fila (F3). */
    function estadoDespDe(x) { return x.comErro ? { t: 'Não entrou', cls: 'neg' } : (x.porEnviar ? { t: 'Por enviar', cls: 'ama' } : P.estadoDespesa(x)); }
    function linhaDespesa(x) {
      var e = estadoDespDe(x), im = P.imputCurta(x);
      return linha({ ic: 'etiqueta', cls: e.cls === 'nav' ? '' : e.cls, t: (x.categoria || 'Despesa') + ' · ' + P.eur(x.valor), s: (x.data ? D.textoDiaCurto(x.data) : '') + (im ? ' · ' + im : ''), est: e, k: 'dp-' + x.id, fn: aoTocar(x, folhaDespesa) });
    }
    function linhaFeriado(f, comToque) {
      var s = f.fecho ? f.nome + ' · conta se um pedido teu o cobrir' : f.nome + ' · não conta como dia de férias';
      return linha({ ic: 'cal', cls: '', t: P.intervalo(f.inicio, f.fim), s: s, k: comToque ? 'fer-' + f.inicio : null, fn: comToque ? folhaFeriados : null });
    }
    // ── O separador Pessoal ──
    // Redesenho de 24 nov 2026 (decisão do Pedro: direcção A do protótipo DOEX-Movel-Pessoal-Premium-Prototipo.html, «uma
    // coluna limpa, sem cartões»). SÓ APRESENTAÇÃO E ORGANIZAÇÃO: a leitura, a fila, o Desfazer, «Por enviar», os formulários,
    // o `pode` e quem vê o quê ficam como estavam. A ordem, de cima para baixo, é por estado (o parecer de UX):
    //   (1) o que não chegou («Por enviar» / «Não entrou»), uma linha por pedido, só quando existe;
    //   (2) o saldo: rótulo pequeno, o número, «por marcar», a barra fina e UMA linha «N pendentes · N livres»;
    //   (3) as acções do mesmo peso: Pedir férias · Falta ou ausência · Despesa (só as que o servidor deixa escrever);
    //   (4) «A seguir», de 1 a 3 linhas: o que espera decisão, as próximas férias, o próximo feriado (o nome primeiro);
    //   (5) um só grupo de acessos (Férias · Faltas e ausências · Despesas) com o número vivo à direita;
    //   (6) «A minha conta ›» (a casca: uma linha que abre a folha da conta; o círculo do topo também).
    // O nome aparece uma vez, na folha da conta. «Horas» e «Horas e atrasos» saem até existirem.
    function desenharTopo() {
      var v = $('v-pessoal'); if (!v) return;
      comFoco(v, function () { corpoTopo(v); if (K.seccaoConta) K.seccaoConta(v); });
    }
    /** Um valor à direita de uma linha: texto com os números a negrito ([['texto'], ['número', true], …]). */
    function valorEl(partes) { var s = el('span', 'mv-pes-v'); partes.forEach(function (x) { s.appendChild(x[1] ? el('b', null, String(x[0])) : document.createTextNode(String(x[0]))); }); return s; }
    function corpoTopo(v) {
      var cab = el('div', 'mv-hcab'), l = el('div', 'mv-hcab-l'), h1 = el('h1', 'mv-hola', 'Pessoal'); h1.id = 'pes-h1'; h1.tabIndex = -1; h1.setAttribute('data-foco-inicial', '');
      l.appendChild(h1);
      var av = K.contaTopo ? K.contaTopo() : null; if (av) l.appendChild(av);   // o círculo pequeno das iniciais: abre a conta
      cab.appendChild(l); cab.appendChild(linhaData()); v.appendChild(cab);
      faixaErro(v);
      cartaoPorEnviar(v);   // (1)
      var d = dadosVista();
      var zona = el('div', 'mv-pes-heroi-z'); v.appendChild(zona);   // a altura do saldo fica reservada: não salta quando chegam os dados
      if (!d) { semDados(zona); return; }
      zona.appendChild(saldoEl(d));   // (2)
      var acoes = acoesEl(); if (acoes) v.appendChild(acoes);   // (3)
      else v.appendChild(el('p', 'mv-pes-nota', 'Pedir férias, registar faltas e despesas pelo telemóvel chega a seguir. Por agora, no computador.'));
      v.appendChild(aSeguirEl(d));   // (4)
      v.appendChild(acessosEl(d));   // (5)
    }
    /** (2) O saldo: um botão que abre as Férias. Os quatro números da barra ficam no rótulo dela (e no ecrã Férias). */
    function saldoEl(d) {
      var r = P.resumoSaldo(d), s = d.saldo || {}, x = P.barra(s), pen = Number(s.pendentes) || 0, liv = Math.max(Number(s.livres) || 0, 0);
      var b = bt('mv-pes-saldo mv-pes-heroi'); b.setAttribute('data-k', 'ir-saldo');
      // revisão de 029ccb2a (8): um só rótulo, no botão, com os quatro números da barra (a barra dentro de um botão não chega ao leitor)
      b.setAttribute('aria-label', 'Férias ' + r.ano + ': ' + r.n + ' ' + r.unidade + ' por marcar. ' + x.aria + '.' + (s.comPorEnviar ? ' Já conta com o que tens por enviar.' : '') + ' Abrir as férias');
      b.appendChild(el('span', 'mv-pes-rot', 'Férias ' + r.ano));
      var n = el('span', 'mv-pes-hn'); n.appendChild(el('b', null, String(r.n))); n.appendChild(el('span', null, r.unidade + ' por marcar')); n.appendChild(ic('chev')); b.appendChild(n);
      var w = el('span', 'mv-pes-b3 fina'); w.setAttribute('aria-hidden', 'true');
      [['goz', x.goz], ['mar', x.mar], ['pen', x.pen]].forEach(function (z) { if (z[1] > 0) { var i = el('i', z[0]); i.style.width = z[1] + '%'; w.appendChild(i); } });
      b.appendChild(w);
      var sub = pen ? [[pen, true], [pen === 1 ? ' pendente · ' : ' pendentes · '], [liv, true], [liv === 1 ? ' livre' : ' livres']] : [[liv, true], [liv === 1 ? ' livre para pedir' : ' livres para pedir']];
      if (s.comPorEnviar) sub.push([' · já conta com o que tens por enviar']);
      var hs = el('span', 'mv-pes-hs'); hs.setAttribute('aria-hidden', 'true'); sub.forEach(function (z) { hs.appendChild(z[1] ? el('b', null, String(z[0])) : document.createTextNode(String(z[0]))); }); b.appendChild(hs);
      b.addEventListener('click', function () { K.abrir('v-pes-ferias'); });
      return b;
    }
    /** (3) As acções, do mesmo peso, só as que o servidor deixa escrever (sem nenhuma: null, e a frase de sempre). */
    function acoesEl() {
      var l = [];
      if (podeEscrever()) { l.push(['ferias', 'cal', 'Pedir férias', function () { abrirPedir('FERIAS'); }]); l.push(['falta', 'falta', 'Falta ou ausência', function () { abrirPedir(''); }]); }
      if (despPodeEscrever()) l.push(['despesa', 'etiqueta', 'Despesa', function () { abrirDespesa(); }]);
      if (!l.length) return null;
      var w = el('div', 'mv-pes-acoes');
      l.forEach(function (a) { var b = bt('mv-pes-ab'); b.setAttribute('data-k', 'rap-' + a[0]); b.appendChild(ic(a[1])); b.appendChild(el('span', null, a[2])); b.addEventListener('click', a[3]); w.appendChild(b); });
      return w;
    }
    /** O próximo feriado ou fecho em «A seguir»: o nome primeiro, a data à direita. */
    function linhaFeriadoTopo(f, hoje) {
      // um fecho que já começou (revisão de 029ccb2a): diz-se até quando dura; um que acaba hoje já não vem (feriadosEFechos)
      var data = f.fecho && f.inicio <= hoje ? 'até ' + P.intervalo(f.fim, f.fim) : P.intervalo(f.inicio, f.fim);
      return linha({ ic: 'cal', t: f.nome, s: f.fecho ? 'Conta se um pedido teu o cobrir' : 'Feriado', v: valorEl([[data, true]]), k: 'fer-' + f.inicio, fn: folhaFeriados });
    }
    /** (4) «A seguir», no máximo 3 linhas (revisão de 029ccb2a). O que ESPERA DECISÃO entra sempre e primeiro, também com data
        passada (é o que mais importa); depois as próximas férias (as que ainda não acabaram) e o próximo feriado ou fecho. O que já
        passou e não espera decisão não entra. Com mais de 3 à espera, ficam 2 e uma última linha «E mais N à espera de decisão ›»,
        que abre as Férias (ou as Faltas, se os que faltam forem todos faltas). */
    function aSeguirEl(d) {
      var esp = P.esperaDecisao(d).filter(function (p) { return !p.porEnviar; }), a = P.aSeguir(d, feriados()), ls = [];
      var linhaDe = function (p) { return P.ehFerias(p) ? linhaPedido(p, d) : linhaFalta(p, d); };
      if (esp.length > 3) {
        esp.slice(0, 2).forEach(function (p) { ls.push(linhaDe(p)); });
        var resto = esp.slice(2), soFaltas = resto.every(function (p) { return !P.ehFerias(p); });
        ls.push(linha({ ic: 'lista', cls: 'ama', t: 'E mais ' + resto.length + ' à espera de decisão', k: 'seguir-mais', fn: function () { K.abrir(soFaltas ? 'v-pes-faltas' : 'v-pes-ferias'); } }));
      } else {
        esp.forEach(function (p) { ls.push(linhaDe(p)); });
        var outros = [];
        if (a.pedido && a.pedido.fim >= d.hoje && !esp.some(function (p) { return p.id === a.pedido.id; })) outros.push(linhaPedido(a.pedido, d));
        if (!esp.length && !outros.length) outros.push(linha({ ic: 'cal', t: 'Sem férias marcadas' }));
        if (a.feriado) outros.push(linhaFeriadoTopo(a.feriado, d.hoje));
        outros.slice(0, Math.max(3 - ls.length, 0)).forEach(function (x) { ls.push(x); });
      }
      var s = el('section', 'mv-sec mv-pes-seguir'), h = el('div', 'mv-sec-h' + (ls.length < 2 ? ' mv-so-leitor' : '')); h.appendChild(el('h2', null, 'A seguir')); s.appendChild(h);
      var g = el('div', 'mv-pes-lista'); ls.forEach(function (x) { g.appendChild(x); }); s.appendChild(g);
      return s;
    }
    /** (5) Os acessos: Férias, Faltas e ausências e Despesas, cada um com o número vivo à direita. */
    function acessosEl(d) {
      var x = P.barra(d.saldo || {}), fm = P.faltasDoMes(d), pr = d.porReembolsar || {}, nd = Number(pr.n) || 0;
      var s = el('section', 'mv-sec mv-pes-acessos'), h = el('div', 'mv-sec-h mv-so-leitor'); h.appendChild(el('h2', null, 'O meu Pessoal')); s.appendChild(h);
      var g = el('div', 'mv-pes-lista');
      g.appendChild(linha({ ico: 'cal', t: 'Férias', v: valorEl([[x.n.goz, true], [x.n.goz === 1 ? ' gozado · ' : ' gozados · '], [x.n.mar, true], [x.n.mar === 1 ? ' marcado' : ' marcados']]), k: 'ir-ferias', fn: function () { K.abrir('v-pes-ferias'); } }));
      var vf = [[fm.mes + ': '], [fm.faltas, true], [fm.faltas === 1 ? ' falta' : ' faltas']]; if (fm.fora) vf.push([' · '], [fm.fora, true], [' fora']);
      g.appendChild(linha({ ico: 'falta', t: 'Faltas e ausências', v: valorEl(vf), k: 'ir-faltas', fn: function () { K.abrir('v-pes-faltas'); } }));
      g.appendChild(linha({ ico: 'etiqueta', t: 'Despesas', v: nd || Number(pr.valor) ? valorEl([[P.eur(pr.valor), true], [' por reembolsar']]) : valorEl([['nada por reembolsar']]), k: 'ir-despesas', fn: function () { K.abrir('v-pes-despesas'); } }));
      s.appendChild(g);
      return s;
    }
    /** (1) O que não chegou: uma linha por pedido desta conta que ainda não entrou (os parados primeiro, com o motivo). */
    function cartaoPorEnviar(v) {
      var ms = meusNaFila(); if (!ms.length) return;
      ms.sort(function (a, b) { return (a.estado === 'parado' ? 0 : 1) - (b.estado === 'parado' ? 0 : 1) || String(a.criadoEm).localeCompare(String(b.criadoEm)); });
      var s = el('section', 'mv-sec mv-pes-fila'), h = el('div', 'mv-sec-h mv-so-leitor'); h.appendChild(el('h2', null, 'Por enviar (' + ms.length + ')')); s.appendChild(h);
      ms.forEach(function (q) {
        var par = q.estado === 'parado', L = logica(q), b = bt('mv-faixa mv-faixa-toda ' + (par ? 'neg' : 'ama')); b.setAttribute('data-k', 'pe-' + q.id);
        b.appendChild(ic(par ? 'alerta' : 'enviar'));
        var t = el('span', 'mv-faixa-t'); t.appendChild(el('b', null, (par ? 'Não entrou · ' : 'Por enviar · ') + L.tituloItem(q)));
        t.appendChild(el('small', null, par ? (q.erro || 'Não entrou') : (L.resumoItem(q) || q.resumo || '') + ' · ' + estadoFila(q, false))); b.appendChild(t);
        b.appendChild(el('span', 'mv-faixa-b', 'Ver'));
        b.addEventListener('click', function () { folhaItem(q); });
        s.appendChild(b);
      });
      v.appendChild(s);
    }

    // ── Férias ──
    function desenharFerias() {
      var v = $('v-pes-ferias'); if (!v) return;
      comFoco(v, function () {
        var d = dadosVista();
        lead(v, 'Férias' + (d ? ' de ' + d.ano : '') + ' · só as tuas');
        faixaErro(v);
        if (!d) { semDados(v); return; }
        var cart = el('div', 'mv-grupo mv-pes-cart');
        barraEl(d.saldo).forEach(function (x) { cart.appendChild(x); });
        P.contasSaldo(d).forEach(function (z) { cart.appendChild(K.rlinha(z[0], z[1])); });
        v.appendChild(cart);
        var prox = P.resumoSaldo(d).prox; if (prox) v.appendChild(el('p', 'mv-pes-prox', prox));   // 24 nov 2026: «E 2 dias em 2027…» saiu do topo do Pessoal para aqui (o detalhe)
        v.appendChild(segm('Ver', [['lista', 'Os meus pedidos'], ['ano', 'O ano']], S.vistaFer, 'vf', function (x) { S.vistaFer = x; desenharFerias(); }));
        if (S.vistaFer === 'ano') {
          var g = P.anoGrelha(d, feriados()), sec = el('section', 'mv-sec'), h = el('div', 'mv-sec-h'); h.appendChild(el('h2', null, d.ano + ', dia a dia')); sec.appendChild(h);
          var w = el('div', 'mv-grupo mv-pes-cart'), an = el('div', 'mv-pes-ano'); an.setAttribute('role', 'img'); an.setAttribute('aria-label', g.aria);
          g.meses.forEach(function (m) { var l = el('div', 'mv-pes-ano-l'); l.appendChild(el('span', null, m.rot)); m.dias.forEach(function (x) { l.appendChild(el('i', (x.cls || '') + (x.hoje ? ' hoje' : ''))); }); an.appendChild(l); });
          w.appendChild(an);
          var lg = el('div', 'mv-leg linha'); lg.setAttribute('aria-hidden', 'true');
          [['goz', 'gozados'], ['mar', 'marcados, ainda por gozar'], ['pen', 'pendentes'], ['fer', 'feriado ou fecho'], ['liv', 'dia útil livre']].forEach(function (z) { var it = el('span'); it.appendChild(el('i', z[0])); it.appendChild(document.createTextNode(z[1])); lg.appendChild(it); });
          w.appendChild(lg); sec.appendChild(w); v.appendChild(sec);
        } else {
          var l = P.feriasLista(d, S.filtroFer), s2 = el('section', 'mv-sec'), h2 = el('div', 'mv-sec-h');
          h2.appendChild(el('h2', null, S.filtroFer === 'todos' ? 'Todos os pedidos' : 'A seguir'));
          var tg = bt('mv-link', S.filtroFer === 'todos' ? 'Só os por vir' : 'Ver todos'); tg.setAttribute('data-k', 'fer-filtro'); tg.addEventListener('click', function () { S.filtroFer = S.filtroFer === 'todos' ? 'seguir' : 'todos'; desenharFerias(); });
          h2.appendChild(tg); s2.appendChild(h2);
          var g2 = el('div', 'mv-grupo');
          if (l.length) l.forEach(function (p) { g2.appendChild(linhaPedido(p, d)); }); else g2.appendChild(linha({ ic: 'cal', t: S.filtroFer === 'todos' ? 'Sem pedidos de férias este ano' : 'Sem férias marcadas a seguir' }));
          s2.appendChild(g2); v.appendChild(s2);
        }
        var fx = P.feriadosEFechos(d, feriados(), 3);
        if (fx.length) v.appendChild(grupo('Feriados e fechos', fx.map(function (f) { return linhaFeriado(f, false); }).concat([linha({ ic: 'lista', t: 'Ver todos', k: 'fer-todos', fn: folhaFeriados })])));
        if (podeEscrever()) { var bp = bt('mv-btn pri mv-pes-acao', 'Pedir férias'); bp.setAttribute('data-k', 'fer-pedir'); bp.insertBefore(ic('mais'), bp.firstChild); bp.addEventListener('click', function () { abrirPedir('FERIAS'); }); v.appendChild(bp); }
      });
    }

    // ── Faltas e ausências ──
    function desenharFaltas() {
      var v = $('v-pes-faltas'); if (!v) return;
      comFoco(v, function () {
        var d = dadosVista();
        lead(v, 'As tuas faltas, teletrabalho e Out of Office');
        faixaErro(v);
        if (!d) { semDados(v); return; }
        v.appendChild(segm('Período', [['mes', 'Este mês'], ['ano', String(d.ano)]], S.filtroFt, 'ft', function (x) { S.filtroFt = x; desenharFaltas(); }));
        var gs = P.faltasPorMes(d, S.filtroFt);
        if (!gs.length) v.appendChild(el('p', 'mv-nada', S.filtroFt === 'mes' ? 'Sem faltas nem ausências este mês.' : 'Sem faltas nem ausências em ' + d.ano + '.'));
        gs.forEach(function (g) { v.appendChild(grupo(g.mes, g.itens.map(function (p) { return linhaFalta(p, d); }), String(g.itens.length))); });
        if (podeEscrever()) { var bp = bt('mv-btn pri mv-pes-acao', 'Registar falta ou ausência'); bp.setAttribute('data-k', 'ft-pedir'); bp.insertBefore(ic('mais'), bp.firstChild); bp.addEventListener('click', function () { abrirPedir(''); }); v.appendChild(bp); }
      });
    }

    // ── Despesas ──
    function desenharDespesas() {
      var v = $('v-pes-despesas'); if (!v) return;
      comFoco(v, function () {
        var d = dadosVista();   // F3: com os comandos por enviar por cima (uma despesa por enviar vê-se logo)
        lead(v, 'As tuas despesas e o reembolso');
        faixaErro(v);
        if (!d) { semDados(v); return; }
        var pr = d.porReembolsar || {}, n = Number(pr.n) || 0, cart = el('div', 'mv-grupo mv-pes-cart'), tot = el('div', 'mv-pes-tot');
        tot.appendChild(el('small', null, 'Por reembolsar')); tot.appendChild(el('b', null, P.eur(pr.valor))); tot.appendChild(el('small', null, n + (n === 1 ? ' despesa' : ' despesas') + ' · só as tuas'));
        cart.appendChild(tot); v.appendChild(cart);
        if (despPodeEscrever()) { var br = bt('mv-btn pri mv-pes-acao', 'Registar despesa'); br.setAttribute('data-k', 'dp-registar'); br.insertBefore(ic('mais'), br.firstChild); br.addEventListener('click', function () { abrirDespesa(); }); v.appendChild(br); }
        v.appendChild(segm('Estado', [['reemb', 'Por reembolsar'], ['pagas', 'Pagas'], ['anuladas', 'Anuladas']], S.filtroDp, 'dp', function (x) { S.filtroDp = x; desenharDespesas(); }));
        var gs = P.despesasGrupos(d, S.filtroDp);
        if (!gs.length) v.appendChild(el('p', 'mv-nada', S.filtroDp === 'pagas' ? 'Sem despesas pagas em ' + d.ano + '.' : (S.filtroDp === 'anuladas' ? 'Sem despesas anuladas em ' + d.ano + '.' : 'Nada por reembolsar.')));
        gs.forEach(function (g) { v.appendChild(grupo(g.titulo, g.itens.map(linhaDespesa), String(g.itens.length))); });
        v.appendChild(el('p', 'mv-pes-nota', 'A folha das despesas imprime-se e assina-se no computador, como as ajudas de custo.'));
      });
    }

    // ── Folhas (o detalhe; na F2, com Corrigir e Cancelar pelo `pode` do servidor) ──
    function historico(cc, h, ano) {
      var l = (h || []).slice().reverse();   // do mais recente
      if (!l.length) return;
      var s = el('section', 'mv-sec'), hh = el('div', 'mv-sec-h'); hh.appendChild(el('h3', 'mv-h2', 'Histórico')); s.appendChild(hh);
      var ul = el('ul', 'mv-hist');
      l.forEach(function (x) { var li = el('li'); li.appendChild(el('b', null, x.texto || '')); var q = P.quando(x.em, ano); if (q || x.porNome) li.appendChild(el('small', null, q + (x.porNome ? (q ? ' · ' : '') + x.porNome : ''))); ul.appendChild(li); });
      s.appendChild(ul); cc.appendChild(s);
    }
    function porId(l, id) { return (l || []).filter(function (x) { return x.id === id; })[0] || null; }
    /** O registo do servidor (a cópia, sem os comandos por cima): é o dele que leva a `versao` e o `pode`. */
    function registoBase(id) { var d = dados(); return d ? porId(d.pedidos, id) : null; }
    /** Porque é que não há botões (só quando a F2 está ligada e o servidor não deu acções): o que a pessoa pode fazer. */
    function porqueNao(p, d) {
      if (p.estado !== 'PENDING' && p.estado !== 'APPROVED') return '';
      if (AU.mesFechado(p.inicio, d.hoje)) return 'O mês deste pedido já passou: só o RH o corrige ou cancela.';
      if (P.ehFerias(p) && p.estado === 'APPROVED' && p.inicio <= d.hoje) return 'Já começou: para mudar, fala com a tua chefia ou com o RH.';
      if (!P.ehFerias(p) && !P.presenca(p) && p.estado === 'APPROVED') return 'Já validada pelo RH: para mudar, fala com o RH.';
      if (P.presenca(p) && p.inicio <= d.hoje) return 'Já começou: para cancelar, fala com o RH.';
      return '';
    }
    /** O pé da folha de um pedido: Corrigir e Cancelar (o `pode`), «Pedir outras datas» num rejeitado; nada sem a F2. */
    function peAcoes(p, d, rotCorrigir) {
      if (!podeEscrever() || p.porEnviar) return null;
      var raw = registoBase(p.id) || p, pode = raw.pode || [], bts = [];
      if (pode.indexOf('corrigir') >= 0) { var bc = bt('mv-btn', rotCorrigir); bc.id = 'b-pes-corrigir'; bc.addEventListener('click', function () { K.fecharFolha(); abrirForm(AU.formDoRegisto(raw)); }); bts.push(bc); }
      if (pode.indexOf('cancelar') >= 0) { var bx = bt('mv-btn neg', 'Cancelar'); bx.id = 'b-pes-cancelar'; bx.addEventListener('click', function () { folhaCancelar(raw); }); bts.push(bx); }
      if (!bts.length && P.ehFerias(p) && p.estado === 'REJECTED') { var bo = bt('mv-btn pri', 'Pedir outras datas'); bo.id = 'b-pes-outras'; bo.addEventListener('click', function () { K.fecharFolha(); abrirPedir('FERIAS'); }); bts.push(bo); }
      var txt = bts.length ? '' : porqueNao(p, d);
      if (!bts.length && !txt) return null;
      return function (pe) {
        if (txt) pe.appendChild(el('p', 'mv-folha-txt', txt));
        if (bts.length === 1) pe.appendChild(bts[0]); else if (bts.length) { var dois = el('div', 'mv-pe2'); bts.forEach(function (b) { dois.appendChild(b); }); pe.appendChild(dois); }
      };
    }
    /** Cancelar (o protótipo, pes-fer-cancelar e pes-falta-anular): pede confirmação; fica Cancelado, não se apaga, sem motivo
        (como no computador); segue com o Desfazer de 5 s. */
    function folhaCancelar(raw) {
      var fer = P.ehFerias(raw), quem = raw.estado === 'APPROVED' && !raw.registado ? ' A chefia e o RH vêem a mudança.' : '';
      K.folha({ titulo: fer ? 'Cancelar o pedido?' : 'Cancelar?', corpo: function (cc) {
        cc.appendChild(el('p', 'mv-folha-txt', (fer ? 'Férias' : raw.rotulo) + ' · ' + P.intervalo(raw.inicio, raw.fim) + '. ' + (fer ? 'Fica Cancelado' : 'Fica Cancelada') + ' (não se apaga) e o histórico diz que foste tu.' + quem));
      }, pe: function (p) {
        var dois = el('div', 'mv-pe2'), a = bt('mv-btn', 'Manter'), b = bt('mv-btn neg', fer ? 'Cancelar pedido' : 'Cancelar'); b.id = 'b-pes-cancelar-ok';
        a.addEventListener('click', function () { K.fecharFolha(); });
        b.addEventListener('click', function () {
          K.fecharFolha();
          var q = AU.itemComando({ accao: 'cancelar', registo: raw, contaId: K.contaId(), contaNome: contaNome(), novoId: K.novoId, adiarMs: ADIAR });
          porComando(q, fer ? 'Pedido cancelado' : 'Cancelada · fica no histórico');
        });
        dois.appendChild(a); dois.appendChild(b); p.appendChild(dois);
      } });
    }
    function faixaErroRegisto(cc, p) {
      if (!p.comErro) return;
      var f = faixa('neg', 'alerta', p.comErro, 'Não entrou'), q = itemDaFila(p.filaId);
      if (q) { var b = bt('mv-faixa-b', 'Ver'); b.addEventListener('click', function () { folhaItem(q); }); f.appendChild(b); }
      cc.appendChild(f);
    }
    function folhaPedido(id) {
      var d = dadosVista(), p = d && porId(d.pedidos, id); if (!p) return;
      var n = Number(p.diasUteis) || 0, e = estadoDe(p);
      K.folha({ titulo: 'Férias · ' + P.intervalo(p.inicio, p.fim), sub: n + (n === 1 ? ' dia útil' : ' dias úteis') + (String(p.inicio).slice(0, 4) !== String(d.ano) ? ' · conta em ' + String(p.inicio).slice(0, 4) : ''), alta: true, corpo: function (cc) {
        cc.appendChild(pilula(e));
        faixaErroRegisto(cc, p);
        var quem = p.estado === 'PENDING' ? (p.etapa === 'DEPT' ? (p.decideNome || 'A tua chefia') + ', depois o RH' : 'Recursos Humanos') : (p.decisao && p.decisao.porNome ? p.decisao.porNome : '');
        cc.appendChild(K.rlinha('Estado', P.estadoAusencia(p).t + (p.estado === 'PENDING' ? (p.etapa === 'RH' ? ' · aguarda o RH' : ' · aguarda a chefia') : '')));
        if (quem) cc.appendChild(K.rlinha(p.estado === 'PENDING' ? 'Decide' : 'Decidiu', quem));
        if (p.decisao && p.decisao.em) cc.appendChild(K.rlinha('Em', P.quando(p.decisao.em, d.ano)));
        if (p.estado === 'REJECTED' && p.decisao && p.decisao.nota) cc.appendChild(K.rlinha('Motivo', p.decisao.nota));
        if (p.nota) cc.appendChild(K.rlinha('Nota', p.nota));
        historico(cc, p.historico, d.ano);
      }, pe: AU ? peAcoes(p, d, 'Corrigir datas') : null });
    }
    function folhaFalta(id) {
      var d = dadosVista(), p = d && porId(d.pedidos, id); if (!p) return;
      var e = estadoDe(p), pres = P.presenca(p), n = Number(p.dias) || 0, det = P.detalheFalta(p, d);
      K.folha({ titulo: p.rotulo, sub: P.intervalo(p.inicio, p.fim) + (pres ? '' : ' · ' + n + (n === 1 ? ' dia' : ' dias')), alta: true, corpo: function (cc) {
        cc.appendChild(pilula(e));
        faixaErroRegisto(cc, p);
        cc.appendChild(K.rlinha('Tipo', p.rotulo));
        if (det && p.tipo !== 'OUT_OFFICE') cc.appendChild(K.rlinha('Motivo', det));
        if (p.horasCompleto === false && p.horaInicio && p.horaFim) cc.appendChild(K.rlinha('Horas', p.horaInicio + '–' + p.horaFim));
        if (p.tipo === 'OUT_OFFICE') { var ds = P.destinoOutOffice(p, d); if (ds) cc.appendChild(K.rlinha('Onde', ds)); }
        cc.appendChild(K.rlinha('Estado', P.estadoAusencia(p).t));
        cc.appendChild(K.rlinha('Valida', pres ? 'Ninguém · o RH é informado' : 'Recursos Humanos'));
        if (!pres) cc.appendChild(K.rlinha('Comprovativo', p.justificativos ? 'Justificativo no arquivo RH' : (p.anexo ? 'Com documento comprovativo (entregue ou a entregar ao RH)' : 'Sem comprovativo')));
        if (p.decisao && p.decisao.porNome) cc.appendChild(K.rlinha('Decidiu', p.decisao.porNome + (p.decisao.em ? ' · ' + P.quando(p.decisao.em, d.ano) : '')));
        if (p.estado === 'REJECTED' && p.decisao && p.decisao.nota) cc.appendChild(K.rlinha('Motivo da decisão', p.decisao.nota));
        if (p.nota) cc.appendChild(K.rlinha('Nota', p.nota));
        historico(cc, p.historico, d.ano);
      }, pe: AU ? peAcoes(p, d, 'Corrigir') : null });
    }
    function folhaDespesa(id) {
      var d = dadosVista(), x = d && porId(d.despesas, id); if (!x) return;
      var e = estadoDespDe(x);
      K.folha({ titulo: P.eur(x.valor), sub: (x.categoria || 'Despesa') + (x.data ? ' · ' + D.textoDiaCurto(x.data) : ''), alta: true, pe: DS ? peDespesa(x) : null, corpo: function (cc) {
        cc.appendChild(pilula(e));
        faixaErroRegisto(cc, x);
        if (x.estado !== 'ANULADA') {
          var ord = { PENDENTE: 0, IMPRESSA: 1, PAGA: 2 }[x.estado] || 0, ps = el('div', 'mv-pes-passos'); ps.setAttribute('role', 'img'); ps.setAttribute('aria-label', 'Reembolso: ' + e.t);
          ['Pendente', 'Na folha', 'Paga'].forEach(function (t, i) { ps.appendChild(el('span', i <= ord ? 'on' : null, t)); });
          cc.appendChild(ps);
        }
        cc.appendChild(K.rlinha('Categoria', x.categoria || '—'));
        cc.appendChild(K.rlinha('Valor', P.eur(x.valor)));
        if (x.data) cc.appendChild(K.rlinha('Data', D.textoDiaCurto(x.data)));
        cc.appendChild(K.rlinha('Imputar a', x.imputRotulo || '—'));
        cc.appendChild(K.rlinha('Fatura em papel', x.faturaPapel ? 'Sim' : 'Ainda não'));
        if (x.folha) cc.appendChild(K.rlinha('Folha', x.folha));
        if (x.estado === 'PAGA' && x.pagaEm) cc.appendChild(K.rlinha('Paga em', P.quando(x.pagaEm, d.ano)));
        if (x.anulada) cc.appendChild(K.rlinha('Motivo da anulação', x.anulada.motivo || '—'));
        if (x.notas) cc.appendChild(K.rlinha('Observações', x.notas));
        historico(cc, x.historico, d.ano);
      } });
    }
    function folhaFeriados() {
      var d = dados(); if (!d) return;
      K.folha({ titulo: 'Feriados e fechos', sub: 'Um fecho só desconta se um pedido de férias o cobrir; um feriado nunca conta.', alta: true, corpo: function (cc) {
        var g = el('div', 'mv-grupo'), l = P.feriadosEFechos(d, feriados());
        if (!l.length) g.appendChild(linha({ ic: 'cal', t: 'Sem feriados nem fechos à vista' }));
        l.forEach(function (f) { g.appendChild(linhaFeriado(f, false)); });
        cc.appendChild(g);
      } });
    }

    // ════════════════ F2: pedir, corrigir e cancelar (ausencias.js) ════════════════
    /** Os comandos desta conta na fila: os das ausências (tipo 'aus') e, desde a F3, os das despesas (tipo 'desp'). */
    function meusNaFila() { return (AU ? AU.meus(K.fila(), K.contaId()) : []).concat(DS ? DS.meus(K.fila(), K.contaId()) : []).filter(function (q) { return !K.apagar[q.id]; }); }
    /** A lógica de um item da fila: despesas.js para os 'desp', ausencias.js para os outros. */
    function logica(q) { return q && q.tipo === 'desp' && DS ? DS : AU; }
    function icItem(q) { return q.tipo === 'desp' ? 'etiqueta' : (AU && AU.cfg(q.tipoAus || (q.campos && q.campos.tipo)).ferias ? 'cal' : 'falta'); }
    function itemDaFila(id) { return id ? (K.fila().filter(function (q) { return q.id === id; })[0] || null) : null; }
    function agoraIso() { return new Date().toISOString(); }
    function estadoFila(q, emCurso) {
      if (q.estado === 'parado') return q.erro || 'Não entrou';
      if (emCurso) return 'A enviar…';
      if (q.adiadoAte && q.adiadoAte > agoraIso()) return 'Ainda dá para desfazer';
      if (!K.A.sessaoValida()) return 'À espera de entrares';
      if (!K.online()) return 'À espera de rede';
      if (q.tipo === 'desp' ? !despDisponivel() : !ausDisponivel()) return 'À espera do servidor';
      return q.erro || 'Na fila';
    }
    function tirarDaFila(q) { K.tirarDaFila(q); K.apagarItem(q.id); }
    /** Um comando novo na fila, com o Desfazer de 5 s (nada sai antes de o aviso acabar). o.desfeito: o que fazer ao desfazer. */
    function porComando(q, texto, o) {
      o = o || {};
      K.porNaFila(q); K.guardarItem(q); redesenhar();
      K.toast(texto + (K.online() ? '' : ' · segue quando houver rede'), { ms: ADIAR, itemId: q.id,
        desfazer: function () { tirarDaFila(q); redesenhar(); if (o.desfeito) o.desfeito(); },
        aoFim: function () { if (K.fila().indexOf(q) < 0) return; q.adiadoAte = ''; K.guardarItem(q); redesenhar(); K.drenar(false); } });
    }
    /** Um comando que já estava na fila (o «Mudar» de um que não entrou, ou de um que ainda não saiu), outra vez a seguir. */
    function reporComando(q, o, texto) {
      var antes = JSON.parse(JSON.stringify(q));
      if (!logica(q).reenviar(q, Object.assign({ novoId: K.novoId, adiarMs: ADIAR }, o))) { K.toast((q.tipo === 'desp' ? 'Isto' : 'Este pedido') + ' pode já ter seguido: espera pela resposta do servidor antes de o mudar.', { ms: 6000 }); return false; }
      K.guardarItem(q); redesenhar();
      K.toast(texto + (K.online() ? '' : ' · segue quando houver rede'), { ms: ADIAR, itemId: q.id,
        desfazer: function () { Object.keys(q).forEach(function (k) { delete q[k]; }); Object.assign(q, antes); K.guardarItem(q); redesenhar(); },
        aoFim: function () { if (K.fila().indexOf(q) < 0) return; q.adiadoAte = ''; K.guardarItem(q); redesenhar(); K.drenar(false); } });
    }
    function contaNome() { var s = K.sessao(); return (s && s.nome) || ''; }

    // ── Abrir um pedido novo, corrigir ──
    /** tipo: 'FERIAS' (Pedir férias) ou '' (Falta ou ausência: escolhe-se o tipo no 1.º passo). */
    function abrirPedir(tipo, o) {
      if (!podeEscrever()) { K.toast('Pedir pelo telemóvel ainda não está ligado no servidor. Por agora, no computador.'); return; }
      var d = dados(), f = AU.formNovo(tipo, (d && d.hoje) || K.hojeDia().dia);
      if (tipo === 'FERIAS' && d && d.hoje) { f.inicio = D.somarDias(d.hoje, 1); f.fim = f.inicio; }   // férias: do dia seguinte (um pedido de hoje para hoje é raro)
      abrirForm(f, o);
    }
    function abrirForm(f, o) { S.form = f; S.formErro = null; K.abrir('v-pes-form', !!(o && o.substituir), !!(o && o.daFolha)); }
    function tituloForm() {
      var f = S.form; if (!f) return 'Pedido';
      var c = AU.cfg(f.tipo);
      if (f.accao === 'corrigir') return c.ferias ? 'Corrigir datas' : 'Corrigir';
      return c.ferias ? 'Pedir férias' : 'Falta ou ausência';
    }
    function passos(f) { return AU.cfg(f.tipo).ferias ? 2 : 3; }
    function cabecalhoPasso(v, f, titulo, sub) {
      var p = el('p', 'mv-lead mv-pes-passo', 'Passo ' + f.passo + ' de ' + passos(f)); p.tabIndex = -1; p.setAttribute('data-foco-inicial', ''); v.appendChild(p);
      v.appendChild(el('h2', 'mv-h1 mv-pes-q', titulo));
      if (sub) v.appendChild(el('p', 'mv-lead', sub));
    }
    function rotulo(txt, para, obrig) { var l = el('label', 'mv-rot', txt); if (para) l.htmlFor = para; if (obrig) { var x = el('span', 'mv-obrig', ' *'); x.setAttribute('aria-hidden', 'true'); l.appendChild(x); } return l; }
    function campoData(id, k, valor, min, aoMudar) {
      var i = el('input', 'mv-in'); i.type = 'date'; i.id = id; i.value = valor || ''; if (min) i.min = min; i.setAttribute('data-k', k); i.required = true;
      i.addEventListener('change', function () { aoMudar(i.value); });
      return i;
    }
    function opcao(o) {   // { k, rot, desc, on, multi, fn }: a linha de escolha do kit (role radio ou checkbox)
      var b = bt('mv-op'); b.setAttribute('role', o.multi ? 'checkbox' : 'radio'); b.setAttribute('aria-checked', o.on ? 'true' : 'false'); b.setAttribute('data-k', o.k);
      var t = el('span', 'mv-op-t'); t.appendChild(el('span', 'mv-op-l', o.rot)); if (o.desc) t.appendChild(el('span', 'mv-op-d', o.desc)); b.appendChild(t);
      var r = el('span', 'mv-radio' + (o.multi ? ' mv-caixa' : '')); r.appendChild(ic('ok')); b.appendChild(r);
      b.addEventListener('click', o.fn);
      return b;
    }
    function chips(rotuloGrupo, ops, atual, k, fn) {
      var w = el('div', 'mv-chips envolve'); w.setAttribute('role', 'group'); w.setAttribute('aria-label', rotuloGrupo);
      ops.forEach(function (o) { var v = Array.isArray(o) ? o[0] : o, r = Array.isArray(o) ? o[1] : o, b = bt('mv-chip', r); b.setAttribute('aria-pressed', String(atual === v)); b.setAttribute('data-k', k + '-' + v); b.addEventListener('click', function () { fn(v); }); w.appendChild(b); });
      return w;
    }
    function erroForm(v) {
      var e = el('p', 'mv-erro'); e.id = 'pes-f-erro'; e.setAttribute('role', 'alert');
      if (S.formErro) { e.appendChild(ic('alerta')); e.appendChild(el('span', null, S.formErro.texto)); } else e.hidden = true;
      v.appendChild(e);
    }
    function nota(v, f, ph) {
      v.appendChild(rotulo('Nota (opcional)', 'pes-f-nota'));
      var t = el('textarea', 'mv-campo curto'); t.id = 'pes-f-nota'; t.maxLength = AU.LIMITES.nota; t.value = f.nota || ''; t.placeholder = ph; t.setAttribute('data-k', 'f-nota'); t.setAttribute('autocapitalize', 'sentences');
      t.addEventListener('input', function () { f.nota = t.value; });
      v.appendChild(t);
    }
    /** O mês do início, só para ler: o que já está marcado, pendente, os feriados riscados e os fechos com contorno. */
    function calMes(f, d) {
      var a = f.inicio || (d && d.hoje), y = Number(String(a).slice(0, 4)), mo = Number(String(a).slice(5, 7)) - 1, fer = feriados();
      if (!y || mo < 0) return null;
      var w = el('div', 'mv-pes-cal'), pri = y + '-' + ('0' + (mo + 1)).slice(-2) + '-01', off = (D.diaDaSemana(pri) + 6) % 7, nm = 0;
      ['S', 'T', 'Q', 'Q', 'S', 'S', 'D'].forEach(function (x) { w.appendChild(el('b', null, x)); });
      for (var i = 0; i < off; i++) w.appendChild(el('span'));
      var peds = d ? (d.pedidos || []).filter(function (p) { return P.ehFerias(p) && p.id !== f.id && (p.estado === 'APPROVED' || p.estado === 'PENDING'); }) : [];
      var fechos = d ? (d.fechos || []) : [];
      for (var s = pri; Number(s.slice(5, 7)) - 1 === mo && nm < 31; s = D.somarDias(s, 1), nm++) {
        var cl = [];
        if (D.fimDeSemana(s)) cl.push('fs'); else if (fer[s]) cl.push('fer');
        if (fechos.some(function (x) { return s >= x.inicio && s <= x.fim; })) cl.push('fec');
        peds.forEach(function (p) { if (s >= p.inicio && s <= p.fim && !D.fimDeSemana(s) && !fer[s]) cl.push(p.estado === 'APPROVED' ? 'mar' : 'pen'); });
        if (f.inicio && f.fim && s >= f.inicio && s <= f.fim) cl.push('sel');
        w.appendChild(el('span', cl.join(' ') || null, String(Number(s.slice(8, 10)))));
      }
      var nPed = 0; peds.forEach(function (p) { if (p.inicio.slice(0, 7) <= pri.slice(0, 7) && p.fim.slice(0, 7) >= pri.slice(0, 7)) nPed++; });
      w.setAttribute('role', 'img');
      w.setAttribute('aria-label', P.MESES_L[mo] + ' de ' + y + (f.inicio && f.fim ? ': escolhido ' + P.intervalo(f.inicio, f.fim) : '') + (nPed ? '; ' + nPed + (nPed === 1 ? ' pedido teu' : ' pedidos teus') + ' neste mês' : ''));
      return w;
    }

    // ── Férias: 1. Datas · 2. Rever e enviar ──
    /** No «Mudar» de um corrigir que mudou entretanto: o formulário parte do pedido de agora e diz o que mudou (revisão da F3, C2). */
    function faixaMudou(v, f) { if (f.servidorMudou && f.servidorMudou.length) v.appendChild(faixa('ama', 'alerta', 'No computador (ou noutro telemóvel) mudou ' + AU.textoMudou(f.servidorMudou) + '. O formulário tem o pedido de agora, com o que mudaste por cima: revê e envia.', 'Mudou entretanto')); }
    function feriasDatas(v, f, d) {
      var fer = feriados(), raw = f.id ? registoBase(f.id) : null;
      cabecalhoPasso(v, f, 'Que dias?', f.accao === 'corrigir' && raw ? 'Pedido de ' + P.intervalo(raw.inicio, raw.fim) : 'Férias' + (d ? ' ' + d.ano : ''));
      faixaMudou(v, f);
      if (raw && raw.estado === 'APPROVED') v.appendChild(faixa('ama', 'alerta', 'Este pedido já está aprovado. Se mudares as datas, volta a Pendente e a chefia decide de novo.'));
      var cart = el('div', 'mv-grupo mv-pes-cart'), cm = calMes(f, d); if (cm) cart.appendChild(cm);
      var lg = el('div', 'mv-leg linha'); lg.setAttribute('aria-hidden', 'true');
      [['sel', 'escolhido'], ['mar', 'marcado'], ['pen', 'pendente']].forEach(function (z) { var it = el('span'); it.appendChild(el('i', z[0])); it.appendChild(document.createTextNode(z[1])); lg.appendChild(it); });
      lg.appendChild(el('span', null, 'feriado riscado · fecho com contorno'));
      cart.appendChild(lg); v.appendChild(cart);
      v.appendChild(rotulo('Início', 'pes-f-ini', true));
      v.appendChild(campoData('pes-f-ini', 'f-ini', f.inicio, null, function (x) { f.inicio = x; if (!f.fim || f.fim < x) f.fim = x; S.formErro = null; desenharForm(); }));
      v.appendChild(rotulo('Fim', 'pes-f-fim', true));
      v.appendChild(campoData('pes-f-fim', 'f-fim', f.fim, f.inicio, function (x) { f.fim = x; S.formErro = null; desenharForm(); }));
      var n = AU.uteis(f.inicio, f.fim, fer), fp = AU.feriadosNoPeriodo(f.inicio, f.fim, fer), liv = AU.livresDepois(d, f, fer);
      var sc = el('section', 'mv-sec'), hc = el('div', 'mv-sec-h'); hc.appendChild(el('h2', null, 'Contas')); sc.appendChild(hc);
      var g = el('div', 'mv-grupo mv-pes-cart');
      g.appendChild(K.rlinha('Dias úteis', n + (n === 1 ? ' dia' : ' dias')));
      g.appendChild(K.rlinha('Fora da conta', (fp.length ? fp.map(function (x) { return D.textoDiaMes(x.dia) + ' (' + x.nome + ')'; }).join(', ') + ' e o fim-de-semana' : 'o fim-de-semana')));
      if (liv != null) g.appendChild(K.rlinha('Livres depois', liv + (Math.abs(liv) === 1 ? ' dia' : ' dias')));
      sc.appendChild(g); v.appendChild(sc);
      avisosFerias(v, f, d, false);
      nota(v, f, 'Ex.: viagem já marcada, cobertura combinada com…');
      erroForm(v);
    }
    function avisosFerias(v, f, d, rever) {
      var fer = feriados(), ex = AU.excesso(d, f, fer), nEx = ex.reduce(function (s, x) { return s + x.dias; }, 0);
      if (d && AU.mesFechado(f.inicio, d.hoje)) v.appendChild(faixa('ama', 'alerta', 'Este mês já fechou: só o RH marca ou corrige ausências nele. O servidor não vai aceitar estas datas.'));
      if (rever) { var so = AU.sobreposicao(d, f); if (so) v.appendChild(faixa('neg', 'alerta', 'Sobrepõe o teu pedido de ' + P.intervalo(so.inicio, so.fim) + ' (' + P.estadoAusencia(so).t.toLowerCase() + '). O servidor não o vai aceitar: muda as datas.', 'Sobreposição')); }
      if (nEx) v.appendChild(faixa('ama', 'alerta', rever ? 'Fica ' + nEx + (nEx === 1 ? ' dia' : ' dias') + ' acima do saldo. Se for validado, desconta nas férias de ' + (ex[0].ano + 1) + '.'
        : 'Passas o saldo em ' + nEx + (nEx === 1 ? ' dia' : ' dias') + ' (contando com os pedidos ainda por aprovar). Podes pedir na mesma: a chefia e o RH vêem este aviso, e se for validado os dias a mais descontam nas férias de ' + (ex[0].ano + 1) + '.', 'Acima do saldo'));
      if (rever && AU.foraDoAno(d, f)) v.appendChild(el('p', 'mv-pes-nota', 'Este pedido toca outro ano: o saldo desse ano confere-o o servidor ao enviar (se passar, pede a tua confirmação).'));
    }
    function feriasRever(v, f, d) {
      var fer = feriados(), n = AU.uteis(f.inicio, f.fim, fer), liv = AU.livresDepois(d, f, fer), ch = d && d.chefia;
      cabecalhoPasso(v, f, 'Confere e envia', null);
      var g = el('div', 'mv-grupo mv-pes-cart');
      g.appendChild(K.rlinha('Tipo', 'Férias')); g.appendChild(K.rlinha('Dias', P.intervalo(f.inicio, f.fim))); g.appendChild(K.rlinha('Dias úteis', String(n)));
      g.appendChild(K.rlinha('Nota', String(f.nota || '').trim() || '—')); if (liv != null) g.appendChild(K.rlinha('Livres depois', String(liv)));
      v.appendChild(g);
      var sq = el('section', 'mv-sec'), hq = el('div', 'mv-sec-h'); hq.appendChild(el('h2', null, 'Quem decide')); sq.appendChild(hq);
      var gq = el('div', 'mv-grupo');
      if (ch) gq.appendChild(linha({ ic: 'pessoa', t: ch.nome, s: 'Chefia directa · decide primeiro' }));
      gq.appendChild(linha({ ic: 'pessoa', cls: '', t: 'Recursos Humanos', s: ch ? 'Confirma depois da chefia' : 'Sem chefia directa: vai directo ao RH' }));
      sq.appendChild(gq); v.appendChild(sq);
      avisosFerias(v, f, d, true);
      if (!K.online()) v.appendChild(faixa('ama', 'alerta', 'Sem rede: o pedido fica guardado neste telemóvel e envia-se sozinho quando houver rede.'));
      erroForm(v);
    }

    // ── Faltas: 1. Tipo · 2. Dias e detalhe · 3. Comprovativo e envio ──
    function descTipo(t) { return t.motivos ? t.motivos.join(' · ') : (t.parentesco ? 'Pede o parentesco' : (t.especificar ? 'Pede o que é (ex.: tribunal, júri)' : (t.oo ? 'Obra, visitas a clientes ou Sede DOE · dia completo ou umas horas' : (t.horas ? 'Dia completo ou só umas horas' : (t.presenca ? 'Dia completo' : ''))))); }
    function faltaTipo(v, f) {
      cabecalhoPasso(v, f, 'Que tipo?', null);
      [['Faltas · valida o RH', AU.TIPOS.filter(function (t) { return !t.presenca; })], ['Fora do escritório · sem aprovação, o RH é informado', AU.TIPOS.filter(function (t) { return t.presenca; })]].forEach(function (gr) {
        var s = el('section', 'mv-sec'), h = el('div', 'mv-sec-h'), h2 = el('h2', null, gr[0]); h.appendChild(h2); s.appendChild(h);
        var g = el('div', 'mv-grupo'); g.setAttribute('role', 'radiogroup'); g.setAttribute('aria-label', gr[0]);
        gr[1].forEach(function (t) { g.appendChild(opcao({ k: 'tp-' + t.k, rot: t.l, desc: descTipo(t), on: f.tipo === t.k, fn: function () { if (f.tipo !== t.k) { f.tipo = t.k; f.motivo = ''; f.horasCompleto = true; } S.formErro = null; desenharForm(); } })); });
        s.appendChild(g); v.appendChild(s);
      });
      erroForm(v);
    }
    function obrasOO(d) { return ((d && d.obras) || []).filter(function (o) { return o.estado === 'ACTIVE'; }); }   // o servidor só aceita obras com status ACTIVE (vacationOutOfficeObraOptions do computador)
    function faltaDados(v, f, d) {
      var t = AU.cfg(f.tipo), raw = f.id ? registoBase(f.id) : null, nD = AU.corridos(f.inicio, f.fim) || 1;
      cabecalhoPasso(v, f, f.accao === 'corrigir' ? t.l : 'Dias e detalhe', f.accao === 'corrigir' && raw ? P.intervalo(raw.inicio, raw.fim) : t.l);
      faixaMudou(v, f);
      if (f.accao === 'corrigir' && raw) v.appendChild(faixa('nav', 'lapis', 'Corriges até ' + D.textoDiaCurto(AU.fimDoMes(raw.inicio)) + (raw.estado === 'PENDING' && !t.presenca ? ', enquanto o RH não a validar' : '') + '. O histórico do pedido guarda o que mudou.'));
      v.appendChild(rotulo('Início', 'pes-f-ini', true));
      v.appendChild(campoData('pes-f-ini', 'f-ini', f.inicio, null, function (x) { f.inicio = x; f.fim = x ? D.somarDias(x, nD - 1) : x; S.formErro = null; desenharForm(); }));
      // Quantos dias (o fim calcula-se), como o protótipo; as faltas contam dias corridos
      v.appendChild(rotulo(t.presenca ? 'Dias' : 'Dias corridos', null));
      var eq = el('div', 'mv-eq'), nome = el('span', 'mv-eq-n', f.inicio ? 'Fim: ' + D.textoDiaCurto(f.fim) : 'Fim: —');
      var menos = bt('mv-passo'); menos.setAttribute('aria-label', 'Menos um dia'); menos.appendChild(ic('menos')); menos.setAttribute('data-k', 'f-menos'); menos.disabled = nD <= 1 || !f.inicio;
      var val = el('span', 'mv-eq-v', String(nD)); val.setAttribute('aria-live', 'polite');
      var mais = bt('mv-passo'); mais.setAttribute('aria-label', 'Mais um dia'); mais.appendChild(ic('mais')); mais.setAttribute('data-k', 'f-mais'); mais.disabled = !f.inicio || nD >= AU.LIMITES.diasMax;
      menos.addEventListener('click', function () { if (nD > 1) { f.fim = D.somarDias(f.inicio, nD - 2); desenharForm(); } });
      mais.addEventListener('click', function () { f.fim = D.somarDias(f.inicio, nD); desenharForm(); });
      eq.appendChild(nome); eq.appendChild(menos); eq.appendChild(val); eq.appendChild(mais); v.appendChild(eq);
      if (t.horas) {
        v.appendChild(rotulo('Horas', null));
        var gh = el('div', 'mv-grupo'); gh.setAttribute('role', 'radiogroup'); gh.setAttribute('aria-label', 'Horas');
        gh.appendChild(opcao({ k: 'h-completo', rot: 'Dia completo', on: f.horasCompleto !== false, fn: function () { f.horasCompleto = true; desenharForm(); } }));
        gh.appendChild(opcao({ k: 'h-parcial', rot: 'Só umas horas', desc: f.horasCompleto === false && f.horaInicio && f.horaFim ? 'Das ' + f.horaInicio + ' às ' + f.horaFim : 'Das … às …', on: f.horasCompleto === false, fn: function () { f.horasCompleto = false; desenharForm(); } }));
        v.appendChild(gh);
        if (f.horasCompleto === false) {
          var hh = el('div', 'mv-pe2 mv-pes-horas');
          [['pes-f-hi', 'Das', 'horaInicio'], ['pes-f-hf', 'Às', 'horaFim']].forEach(function (z) { var w = el('div'); w.appendChild(rotulo(z[1], z[0])); var i = el('input', 'mv-in'); i.type = 'time'; i.id = z[0]; i.value = f[z[2]] || ''; i.setAttribute('data-k', 'f-' + z[2]); i.addEventListener('change', function () { f[z[2]] = i.value; S.formErro = null; }); w.appendChild(i); hh.appendChild(w); });
          v.appendChild(hh);
        }
      }
      if (t.motivos) { v.appendChild(rotulo('Motivo', null, true)); v.appendChild(chips('Motivo', t.motivos, f.motivo, 'f-mot', function (x) { f.motivo = x; S.formErro = null; desenharForm(); })); }
      if (t.parentesco || t.especificar) {
        var k = t.parentesco ? 'parentesco' : 'especificar';
        v.appendChild(rotulo(t.parentesco ? 'Parentesco' : 'Especificar', 'pes-f-' + k, true));
        var i2 = el('input', 'mv-in'); i2.id = 'pes-f-' + k; i2.value = f[k] || ''; i2.maxLength = AU.LIMITES.texto; i2.placeholder = t.parentesco ? 'ex.: pai, filho(a), cônjuge…' : 'ex.: júri, tribunal, recenseamento…'; i2.setAttribute('data-k', 'f-' + k);
        i2.addEventListener('input', function () { f[k] = i2.value; }); v.appendChild(i2);
      }
      if (t.oo) zonaOO(v, f, d);
      nota(v, f, 'Ex.: cobertura combinada com…');
      erroForm(v);
    }
    /** Out of Office, «Onde»: Obra (uma ou mais das activas), Visitas (empresa e contacto, só da lista: D3) ou Sede DOE. */
    function zonaOO(v, f, d) {
      var oo = f.oo || (f.oo = { modo: 'OBRA', obras: [], visitas: [] });
      v.appendChild(rotulo('Onde', null, true));
      v.appendChild(chips('Onde', AU.MODOS_OO, oo.modo, 'f-oo', function (x) { oo.modo = x; S.formErro = null; desenharForm(); }));
      if (oo.modo === 'SEDE') { v.appendChild(el('p', 'mv-pes-nota', 'Deslocação à Sede DOE. Não há nada para escolher: se for preciso dizer com quem ou para quê, usa a nota.')); return; }
      var g = el('div', 'mv-grupo mv-pes-oo');
      if (oo.modo === 'OBRA') {
        var os = obrasOO(d);
        g.setAttribute('role', 'group'); g.setAttribute('aria-label', 'Obras (pode ser mais do que uma)');
        if (!os.length) g.appendChild(linha({ ic: 'obra', t: 'Sem obras activas na leitura', s: 'Com rede, a lista atualiza-se' }));
        os.forEach(function (o) { var on = oo.obras.indexOf(o.id) >= 0; g.appendChild(opcao({ k: 'oo-o-' + o.id, rot: (o.codigo ? o.codigo + ' · ' : '') + o.nome, multi: true, on: on, fn: function () { oo.obras = on ? oo.obras.filter(function (x) { return x !== o.id; }) : oo.obras.concat([o.id]); S.formErro = null; desenharForm(); } })); });
        v.appendChild(g); v.appendChild(el('p', 'mv-pes-nota', 'Pode ser mais do que uma.'));
        return;
      }
      var emp = (d && d.visitas && d.visitas.empresas) || [];
      oo.visitas.forEach(function (x, i) {
        var e = emp.filter(function (y) { return y.id === x.clienteId; })[0], c = e ? (e.contactos || []).filter(function (y) { return y.id === x.contactoId; })[0] : null;
        var l = el('div', 'mv-pes-l leve'), ii = el('span', 'mv-pes-ic'); ii.setAttribute('aria-hidden', 'true'); ii.appendChild(ic('pessoa')); l.appendChild(ii);
        var tt = el('span', 'mv-pes-lt'); tt.appendChild(el('b', null, (e ? e.nome : 'Empresa que já não está na lista') + (c ? ' (' + c.nome + ')' : ''))); if (e) tt.appendChild(el('small', null, TIPO_EMPRESA[e.tipo] || e.tipo || '')); l.appendChild(tt);
        var x2 = bt('mv-icb'); x2.setAttribute('aria-label', 'Tirar esta visita'); x2.setAttribute('data-k', 'oo-v-x-' + i); x2.appendChild(ic('x')); x2.addEventListener('click', function () { oo.visitas.splice(i, 1); desenharForm(); }); l.appendChild(x2);
        g.appendChild(l);
      });
      var add = bt('mv-pes-l'), ai = el('span', 'mv-pes-ic nav'); ai.setAttribute('aria-hidden', 'true'); ai.appendChild(ic('mais')); add.appendChild(ai);
      var at = el('span', 'mv-pes-lt'); at.appendChild(el('b', null, 'Adicionar visita')); at.appendChild(el('small', null, 'Primeiro a empresa, depois o contacto')); add.appendChild(at); add.setAttribute('data-k', 'oo-v-add');
      add.addEventListener('click', function () { folhaVisita(f, d); });
      g.appendChild(add); v.appendChild(g);
    }
    function folhaVisita(f, d) {
      var emp = (d && d.visitas && d.visitas.empresas) || [], esc = { emp: '', ct: '', q: '' }, ccRef = null, peRef = null;
      var desenha = function () {
        var cc = limpar(ccRef);
        var w = el('div', 'mv-pesq'); w.appendChild(ic('lista')); var q = el('input', 'mv-in'); q.type = 'search'; q.placeholder = 'Procurar a empresa'; q.value = esc.q; q.setAttribute('aria-label', 'Procurar a empresa'); q.id = 'pes-v-q';
        q.addEventListener('input', function () { esc.q = q.value; desenhaLista(); }); w.appendChild(q); cc.appendChild(w);
        var box = el('div'); box.id = 'pes-v-lista'; cc.appendChild(box); desenhaLista();
        desenhaPe();
      };
      var desenhaLista = function () {
        var box = $('pes-v-lista'); if (!box) return;
        var ae = document.activeElement, kf = ae && box.contains(ae) ? ae.getAttribute('data-k') : null;
        limpar(box); var n = String(esc.q || '').trim().toLowerCase(), grupos = {}, ordem = [];
        emp.filter(function (x) { return !n || String(x.nome).toLowerCase().indexOf(n) >= 0 || x.id === esc.emp; }).forEach(function (x) { var g = TIPO_EMPRESA[x.tipo] || x.tipo || 'Outras'; if (!grupos[g]) { grupos[g] = []; ordem.push(g); } grupos[g].push(x); });
        if (!ordem.length) box.appendChild(el('p', 'mv-folha-txt', emp.length ? 'Nenhuma empresa com esse nome.' : 'Ainda não tenho a lista das empresas neste telemóvel: aparece quando houver rede.'));
        ordem.forEach(function (g) {
          box.appendChild(el('p', 'mv-lh', g));
          var gg = el('div', 'mv-grupo'); gg.setAttribute('role', 'radiogroup'); gg.setAttribute('aria-label', g);
          grupos[g].slice(0, 60).forEach(function (x) { var nc = (x.contactos || []).length; gg.appendChild(opcao({ k: 'v-e-' + x.id, rot: x.nome, desc: nc + (nc === 1 ? ' contacto' : ' contactos'), on: esc.emp === x.id, fn: function () { esc.emp = x.id; esc.ct = ''; desenhaLista(); desenhaPe(); } })); });
          box.appendChild(gg);
        });
        var e = emp.filter(function (x) { return x.id === esc.emp; })[0];
        if (e) {
          box.appendChild(el('p', 'mv-lh', 'Contacto · ' + e.nome));
          var gc = el('div', 'mv-grupo'); gc.setAttribute('role', 'radiogroup'); gc.setAttribute('aria-label', 'Contacto');
          (e.contactos || []).forEach(function (c) { gc.appendChild(opcao({ k: 'v-c-' + c.id, rot: c.nome, on: esc.ct === c.id, fn: function () { esc.ct = c.id; desenhaLista(); desenhaPe(); } })); });
          if ((e.contactos || []).length) box.appendChild(gc);
          box.appendChild(el('p', 'mv-folha-txt', (e.contactos || []).length ? 'Sem o contacto na lista? Regista esta visita no computador, onde podes criar o contacto.' : 'Esta empresa ainda não tem contactos: regista a visita no computador, onde podes criar o contacto.'));
        }
        if (kf) { var y = box.querySelector('[data-k="' + kf + '"]'); if (y) K.A.focar(y); }
      };
      var desenhaPe = function () {
        var p = limpar(peRef), pronta = !!(esc.emp && esc.ct), b = bt('mv-btn pri', 'Adicionar'); b.id = 'b-pes-v-ok'; b.setAttribute('aria-disabled', String(!pronta));
        b.addEventListener('click', function () { if (!esc.emp || !esc.ct) { K.toast('Escolhe a empresa e o contacto.'); return; } if (!f.oo.visitas.some(function (x) { return x.clienteId === esc.emp && x.contactoId === esc.ct; })) f.oo.visitas.push({ clienteId: esc.emp, contactoId: esc.ct }); S.formErro = null; K.fecharFolha(); desenharForm(); });
        p.appendChild(b);
      };
      K.folha({ titulo: 'Adicionar visita', sub: 'Primeiro a empresa, depois o contacto.', alta: true, corpo: function (cc) { ccRef = cc; }, pe: function (p) { peRef = p; }, foco: function () { return $('fx-t'); } });
      desenha();
    }
    function faltaRever(v, f, d) {
      var t = AU.cfg(f.tipo), just = !t.presenca, n = AU.corridos(f.inicio, f.fim);
      cabecalhoPasso(v, f, 'Confere e envia', just ? 'O comprovativo (atestado, declaração…) entrega-se como hoje' : 'Este tipo não leva comprovativo');
      if (just) {
        var gc = el('div', 'mv-grupo');
        gc.appendChild(opcao({ k: 'f-anexo', rot: 'Tenho documento comprovativo', desc: '(entregue ou a entregar ao RH)', multi: true, on: !!f.anexo, fn: function () { f.anexo = !f.anexo; desenharForm(); } }));
        v.appendChild(gc);
        v.appendChild(el('p', 'mv-pes-nota', 'O documento não passa pelo telemóvel: entrega o papel ao RH, que o anexa, ou anexa-o no computador («Anexar justificativo», em Eu › Assiduidade). Fica no arquivo RH.'));
      }
      var g = el('div', 'mv-grupo mv-pes-cart');
      g.appendChild(K.rlinha('Tipo', t.l));
      var det = AU.motivoDe(AU.camposDe(f), d); if (det) g.appendChild(K.rlinha(t.oo ? 'Onde' : 'Detalhe', det));
      g.appendChild(K.rlinha('Dias', P.intervalo(f.inicio, f.fim) + (t.presenca ? '' : ' · ' + n + (n === 1 ? ' dia' : ' dias'))));
      if (t.horas) g.appendChild(K.rlinha('Horas', f.horasCompleto === false ? f.horaInicio + '–' + f.horaFim : 'Dia completo'));
      if (String(f.nota || '').trim()) g.appendChild(K.rlinha('Nota', String(f.nota).trim()));
      g.appendChild(K.rlinha('Quem valida', t.presenca ? 'Ninguém · o RH é informado' : 'Recursos Humanos'));
      v.appendChild(g);
      // quem vê (D1, revisão da F1): o colega só as datas, o tipo e o estado
      v.appendChild(faixa('nav', 'chave', just ? 'O motivo e o comprovativo vê-os só tu e o RH. A tua chefia vê o tipo (por exemplo «Doença»); os colegas vêem «Ausência» e as datas.'
        : 'Os colegas vêem o tipo e as datas; a nota e o destino, só a tua chefia e o RH.'));
      if (d && AU.mesFechado(f.inicio, d.hoje)) v.appendChild(faixa('ama', 'alerta', 'Este mês já fechou: só o RH marca ou corrige ausências nele. O servidor não vai aceitar estas datas.'));
      var so = AU.sobreposicao(d, f); if (so) v.appendChild(faixa('neg', 'alerta', 'Sobrepõe o teu pedido de ' + P.intervalo(so.inicio, so.fim) + ' (' + so.rotulo + ', ' + P.estadoAusencia(so).t.toLowerCase() + '). O servidor não o vai aceitar: muda as datas.', 'Sobreposição'));
      if (!K.online()) v.appendChild(faixa('ama', 'alerta', 'Sem rede: o registo fica neste telemóvel e envia-se quando houver rede.'));
      erroForm(v);
    }

    // ── O formulário (um só ecrã com os passos; a barra em baixo diz o passo seguinte) ──
    function desenharForm() {
      var v = $('v-pes-form'); if (!v || !S.form || !AU) return;
      var f = S.form;
      comFoco(v, function () {
        var d = dadosVista(), c = AU.cfg(f.tipo);
        if (!f.tipo || (!c.ferias && f.passo === 1)) faltaTipo(v, f);
        else if (c.ferias) { if (f.passo >= 2) feriasRever(v, f, d); else feriasDatas(v, f, d); }
        else if (f.passo === 2) faltaDados(v, f, d);
        else faltaRever(v, f, d);
      });
      barraForm();
    }
    function barraForm() {
      var bb = $('barra-pes'); if (!bb || !S.form) return; limpar(bb);
      var f = S.form, c = AU.cfg(f.tipo), ultimo = f.passo >= passos(f), dois = el('div', 'mv-pe2');
      var rotPri = !ultimo ? (f.passo === 1 && c.ferias ? 'Rever' : 'Seguinte') : (f.accao === 'corrigir' ? 'Guardar' : (c.ferias ? 'Enviar pedido' : (c.presenca ? 'Registar' : 'Enviar ao RH')));
      var pri = bt('mv-btn pri', rotPri); pri.id = 'b-pes-seguinte';
      pri.addEventListener('click', function () { seguinte(); });
      var podeVoltar = f.passo > 1 && !(f.accao === 'corrigir' && !c.ferias && f.passo === 2);
      if (podeVoltar) { var vb = bt('mv-btn', 'Voltar'); vb.id = 'b-pes-voltar'; vb.addEventListener('click', function () { f.passo--; S.formErro = null; desenharForm(); window.scrollTo(0, 0); }); dois.appendChild(vb); dois.appendChild(pri); bb.appendChild(dois); }
      else bb.appendChild(pri);
      K.A.medirBarra();
    }
    function seguinte() {
      var f = S.form; if (!f) return;
      var ultimo = f.passo >= passos(f), falta = AU.faltaNoForm(f, feriados(), ultimo ? 99 : f.passo);
      if (falta) { S.formErro = falta; desenharForm(); var e = $('pes-f-erro'); if (e) K.A.focar(e); return; }
      S.formErro = null;
      if (!ultimo) { f.passo++; desenharForm(); window.scrollTo(0, 0); var t = document.querySelector('#v-pes-form [data-foco-inicial]'); if (t) K.A.focar(t); return; }
      var d = dadosVista(), ex = AU.excesso(d, f, feriados());
      if (ex.length) { folhaAcima(ex, function () { enviarForm(ex); }); return; }
      enviarForm(null);
    }
    /** Acima do saldo: a confirmação do computador (saveVacationRequest), que fica no histórico do pedido. */
    function folhaAcima(ex, aoConfirmar) {
      var n = ex.reduce(function (s, x) { return s + (Number(x.dias) || 0); }, 0), anos = ex.map(function (x) { return x.ano; }).join(' e '), seg = ex.map(function (x) { return x.ano + 1; }).join(' e ');
      K.folha({ titulo: 'Acima do saldo', corpo: function (cc) {
        cc.appendChild(el('p', 'mv-folha-txt', 'Estás a marcar mais férias do que os dias disponíveis: ' + n + (n === 1 ? ' dia' : ' dias') + ' a mais em ' + anos + ' (contando com os pedidos ainda por aprovar).'));
        cc.appendChild(el('p', 'mv-folha-txt', 'A chefia e o RH vão ver este aviso ao decidir. Se o pedido for validado, os dias a mais são descontados das férias de ' + seg + '.'));
        cc.appendChild(el('p', 'mv-folha-txt', 'Queres enviar o pedido mesmo assim?'));
      }, pe: function (p) {
        var dois = el('div', 'mv-pe2'), a = bt('mv-btn', 'Rever as datas'), b = bt('mv-btn pri', 'Enviar mesmo assim'); b.id = 'b-pes-acima-ok';
        a.addEventListener('click', function () { K.fecharFolha(); }); b.addEventListener('click', function () { K.fecharFolha(); aoConfirmar(); });
        dois.appendChild(a); dois.appendChild(b); p.appendChild(dois);
      } });
    }
    function textoEnviado(f) { var c = AU.cfg(f.tipo); return f.accao === 'corrigir' ? 'Corrigido · fica no histórico' : (c.ferias ? 'Pedido de férias enviado' : (c.presenca ? c.l + ' registado' : 'Enviada ao RH')); }
    function enviarForm(excessoVisto) {
      var f = S.form; if (!f) return;
      var q0 = f.deItem ? itemDaFila(f.deItem) : null, raw = f.accao === 'corrigir' ? registoBase(f.id) : null;
      if (f.accao === 'corrigir' && !raw && !q0) { K.toast('Este pedido já não está na tua lista: lê o Pessoal outra vez.'); return; }
      var fCopia = JSON.parse(JSON.stringify(f)), item;
      if (q0 && K.fila().indexOf(q0) >= 0 && (q0.estado === 'parado' || !q0.tentou)) {   // «Mudar» um que não entrou (ou que ainda não tinha saído): o mesmo item, outra intenção
        item = q0;
        reporComando(q0, { campos: AU.camposDe(f, excessoVisto), versao: f.accao === 'corrigir' && raw ? raw.versao : undefined, base: f.accao === 'corrigir' && raw ? AU.baseDe(raw) : undefined }, textoEnviado(f));
      } else {
        item = AU.itemComando({ accao: f.accao, registo: raw, form: f, excessoVisto: excessoVisto, contaId: K.contaId(), contaNome: contaNome(), novoId: K.novoId, adiarMs: ADIAR, id: f.accao === 'pedir' && f.id ? f.id : undefined });
        porComando(item, textoEnviado(f), { desfeito: function () { S.feito = null; var g = JSON.parse(JSON.stringify(fCopia)); g.deItem = ''; abrirForm(g, { substituir: K.vista() === 'v-pes-feito' }); } });
      }
      S.form = null;
      if (f.accao === 'corrigir') { K.voltar(); return; }
      S.feito = { itemId: item.id, form: fCopia, entregue: false, registo: null };
      K.abrir('v-pes-feito', true);
    }

    // ── O «Feito»: o estado do envio (a enviar, guardado, enviado, não foi aceite) ──
    function faseFeito() {
      var x = S.feito; if (!x) return '';
      if (x.entregue) return 'feito';
      var q = itemDaFila(x.itemId);
      if (!q) return 'feito';
      if (q.estado === 'parado') return 'parado';
      if (q.adiadoAte && q.adiadoAte > agoraIso()) return 'desfazer';
      if (!K.online() || !K.A.sessaoValida() || !ausDisponivel()) return 'guardado';
      return 'a-enviar';
    }
    function desenharFeito() {
      var v = $('v-pes-feito'); if (!v || !S.feito || !AU) return;
      limpar(v);
      // depois de entregue, o que se mostra é o registo do SERVIDOR (revisão da F2: um pedido que já tinha entrado com outras
      // datas devolve as de lá, e o formulário que não foi aplicado nunca aparece como se tivesse sido)
      var x = S.feito, r0 = x.registo, f = r0 ? { tipo: r0.tipo, inicio: r0.inicio, fim: r0.fim, anexo: r0.anexo } : x.form, c = AU.cfg(f.tipo), fase = faseFeito(), q = itemDaFila(x.itemId), d = dadosVista(), ch = d && d.chefia, fer = feriados();
      var selo = el('div', 'mv-selo' + (fase === 'parado' ? ' neg' : (fase === 'feito' ? '' : (fase === 'guardado' ? ' ama' : ' nav')))); selo.setAttribute('aria-hidden', 'true');
      selo.appendChild(ic(fase === 'parado' ? 'alerta' : (fase === 'feito' ? 'ok' : (fase === 'guardado' ? 'subir' : 'enviar'))));
      v.appendChild(selo);
      var titulo = fase === 'parado' ? 'Não foi aceite' : (fase === 'guardado' ? 'Guardado' : (fase === 'feito' ? (x.jaEntrou ? 'Já tinha entrado' : (c.ferias ? 'Pedido enviado' : (c.presenca ? 'Registado' : 'Enviada ao RH'))) : 'A enviar…'));
      var est = el('div', 'mv-env-estado'); est.setAttribute('aria-live', 'polite'); est.setAttribute('aria-atomic', 'true');
      var h = el('h1', 'mv-env-t', titulo); h.id = 'pes-e-titulo'; h.tabIndex = -1; h.setAttribute('data-foco-inicial', ''); est.appendChild(h);
      var o = c.ferias ? AU.uteis(f.inicio, f.fim, fer) : AU.corridos(f.inicio, f.fim);
      var resumo = (c.ferias ? '' : c.l + ' · ') + P.intervalo(f.inicio, f.fim) + ' · ' + o + (c.ferias ? (o === 1 ? ' dia útil' : ' dias úteis') : (o === 1 ? ' dia' : ' dias')) + '.';
      var depois = c.ferias ? ' Aguarda ' + (ch ? ch.nome + ' e depois o RH' : 'o RH') + '; és avisado da decisão.' : (c.presenca ? ' Não carece de aprovação: o RH é informado.' : ' O RH valida; és avisado.' + (f.anexo ? ' Entrega o comprovativo ao RH ou anexa-o no computador.' : '') + ' Corriges ou cancelas até ' + D.textoDiaCurto(AU.fimDoMes(f.inicio)) + ', enquanto o RH não a validar.');
      var sub = fase === 'parado' ? resumo + ' Ficou em «Por enviar», com o motivo.' : (fase === 'guardado' ? 'Envia-se sozinho quando houver rede, com a app aberta. ' + resumo : (fase === 'desfazer' ? resumo + ' Ainda dá para desfazer (no aviso em baixo).' : resumo + (fase === 'feito' ? depois : '')));
      est.appendChild(el('p', 'mv-env-s', sub));
      v.appendChild(est);
      if (fase === 'parado' && q) v.appendChild(faixa('neg', 'alerta', q.erro || 'Não entrou', 'O motivo do servidor'));
      if (fase === 'feito' && x.jaEntrou && x.aviso) v.appendChild(faixa('ama', 'alerta', x.aviso));
      if (fase === 'feito' || fase === 'guardado' || fase === 'desfazer') v.appendChild(el('p', 'mv-pes-nota', 'Para levar a assinar: a «Comunicação de Faltas e Férias» imprime-se no computador (Eu › Assiduidade › Imprimir Folha).'));
      var bb = $('barra-pes-feito'); if (bb) {
        limpar(bb);
        if (fase === 'parado' && q) {
          if (q.mudar) { var bm = bt('mv-btn pri', q.confirmar ? 'Confirmar e enviar' : (c.ferias ? 'Mudar datas' : 'Mudar')); bm.id = 'b-pes-mudar'; bm.addEventListener('click', function () { mudar(q, { substituir: true }); }); bb.appendChild(bm); }
          var bd = bt('mv-btn ghost', 'Deixar'); bd.id = 'b-pes-deixar'; bd.addEventListener('click', function () { S.feito = null; K.irPessoal(); K.toast('Fica em «Por enviar», com o motivo.'); }); bb.appendChild(bd);
        } else {
          var bf = bt('mv-btn pri', 'Feito'); bf.id = 'b-pes-feito'; bf.addEventListener('click', function () { S.feito = null; K.irPessoal(); }); bb.appendChild(bf);
          var reg = x.registo || null;
          if (reg) { var bv = bt('mv-btn ghost', 'Ver o pedido'); bv.id = 'b-pes-ver'; bv.addEventListener('click', function () { if (P.ehFerias(reg)) folhaPedido(reg.id); else folhaFalta(reg.id); }); bb.appendChild(bv); }
        }
        K.A.medirBarra();
      }
    }

    // ── «Por enviar»: um comando desta conta (a folha, e a linha do «Por enviar» da casca) ──
    /** Um comando à espera tem «Mudar»? (o de uma despesa só quando é um formulário: registar ou corrigir) */
    function mudavel(q) { return q.tipo !== 'desp' || q.accao === 'registar' || q.accao === 'corrigir'; }
    function rotMudar(q) {
      if (q.tipo === 'desp') return q.confirmarFolha ? 'Confirmar e gravar' : (q.accao === 'registar' || q.accao === 'corrigir' ? 'Mudar' : 'Tentar outra vez');
      return q.confirmar ? 'Confirmar e enviar' : (q.accao === 'cancelar' ? 'Cancelar outra vez' : 'Mudar');
    }
    function folhaItem(q) {
      var par = q.estado === 'parado', saiu = !par && !!q.tentou, L = logica(q);
      K.folha({ titulo: L.tituloItem(q), sub: L.resumoItem(q) || q.resumo || '', corpo: function (cc) {
        if (par) cc.appendChild(faixa('neg', 'alerta', q.erro || 'Não entrou', 'Não foi aceite'));
        else cc.appendChild(el('p', 'mv-folha-txt', saiu ? 'Pode já ter seguido: a resposta do servidor ainda não chegou. Tenta outra vez quando houver rede.' : estadoFila(q, false) + '. Segue sozinho quando houver rede, com a app aberta.'));
        if (par && !q.mudar) cc.appendChild(el('p', 'mv-folha-txt', q.tipo === 'desp' ? 'Isto não se resolve a mudar a despesa. Desiste aqui; se precisares, trata dela no computador.' : 'Isto não se resolve a mudar o pedido. Desiste dele aqui; se precisares, fala com o RH ou com a tua chefia.'));
      }, pe: function (p) {
        var bts = [];
        if (par && q.mudar) { var bm = bt('mv-btn pri', rotMudar(q)); bm.id = 'b-pes-mudar'; bm.addEventListener('click', function () { K.fecharFolha(); mudar(q); }); bts.push(bm); }
        if (!par && !saiu && mudavel(q)) { var bm2 = bt('mv-btn', 'Mudar'); bm2.id = 'b-pes-mudar'; bm2.addEventListener('click', function () { K.fecharFolha(); mudar(q); }); bts.push(bm2); }
        if (!saiu) { var bx = bt('mv-btn neg', par ? 'Desistir' : 'Apagar'); bx.id = 'b-pes-desistir'; bx.addEventListener('click', function () { K.fecharFolha(); desistir(q); }); bts.push(bx); }
        else { var bt2 = bt('mv-btn', 'Tentar agora'); bt2.addEventListener('click', function () { K.fecharFolha(); K.drenar(true); }); bts.push(bt2); }
        if (bts.length === 1) p.appendChild(bts[0]); else { var dois = el('div', 'mv-pe2'); bts.forEach(function (b) { dois.appendChild(b); }); p.appendChild(dois); }
      } });
    }
    /** «Mudar»: o formulário com o que se tinha (um pedidoId novo ao reenviar); no acima do saldo, a confirmação com o excesso
        do servidor; num cancelar que mudou, outra vez com a versão de agora. */
    function mudar(q, o) {
      if (q.tipo === 'desp') { mudarDesp(q, o); return; }
      var raw = registoBase(q.registoId);
      if (q.estado === 'parado' && q.confirmar) {
        var ex = (q.details && q.details.excesso) || [];
        folhaAcima(ex.length ? ex : [{ ano: Number((q.campos && q.campos.inicio || '').slice(0, 4)), dias: 1 }], function () { reporComando(q, { excessoVisto: ex }, 'Confirmado · segue já'); if (S.feito && S.feito.itemId === q.id) desenharFeito(); });
        return;
      }
      if (q.accao === 'cancelar') {
        if (!raw) { K.toast('Este pedido já não está na tua lista: lê o Pessoal outra vez.'); return; }
        reporComando(q, { versao: raw.versao }, 'Cancelar outra vez · segue já'); return;
      }
      if (!AU) return;
      var f = AU.formDoItem(q, q.accao === 'corrigir' ? raw : null);
      if (S.feito && S.feito.itemId === q.id) S.feito = null;
      abrirForm(f, o);
    }
    function desistir(q) {
      K.tirarDaFila(q); K.apagar[q.id] = true; redesenhar();
      K.toast('Apagado · ' + logica(q).tituloItem(q).toLowerCase(), { desfazer: function () { delete K.apagar[q.id]; K.porNaFila(q); redesenhar(); }, aoFim: function () { if (K.apagar[q.id]) { delete K.apagar[q.id]; K.apagarItem(q.id); } } });
    }
    function linhaFila(q, emCurso) {
      var par = q.estado === 'parado', saiu = !par && (emCurso || !!q.tentou), acoes = [];
      if (par && q.mudar) acoes.push(['lapis', q.tipo === 'desp' ? (q.confirmarFolha ? 'Confirmar' : rotMudar(q)) : (q.confirmar ? 'Confirmar' : (q.accao === 'cancelar' ? 'Cancelar outra vez' : 'Mudar')), function () { mudar(q); }]);
      else if (!par && !saiu) { if (mudavel(q)) acoes.push(['lapis', 'Mudar', function () { mudar(q); }]); acoes.push(['atual', 'Tentar agora', function () { if (!K.A.sessaoValida()) { K.A.pedirLogin('Entra outra vez: o que tens por enviar segue logo a seguir.'); return; } q.adiadoAte = ''; K.drenar(true); }]); }
      else if (!par) acoes.push(['atual', 'Tentar agora', function () { K.drenar(true); }]);
      var L = logica(q);
      return { ic: icItem(q), titulo: L.tituloItem(q), resumo: L.resumoItem(q) || q.resumo || '', estado: estadoFila(q, emCurso) + (saiu && !emCurso ? ' · pode já ter seguido' : ''), cls: par ? 'neg' : null, acoes: acoes, apagar: par || !saiu };
    }
    /** O comando que se está a mudar não sai enquanto o formulário dele está aberto (só nesta abertura, em memória). */
    function retido(q) { return !!(S.form && S.form.deItem === q.id && K.vista() === 'v-pes-form') || !!(S.dform && S.dform.deItem === q.id && K.vista() === 'v-pes-desp-form'); }

    // ── O envio (chamado pelo drenar da casca, item a item) ──
    function processar(q) { return logica(q).processar(q, K.deps()); }
    async function aoResultado(q, res) {
      if (q.tipo === 'desp') { aoResultadoDesp(q, res); return; }
      var noFeito = S.feito && S.feito.itemId === q.id && K.vista() === 'v-pes-feito';
      if (res.estado === 'entregue' && q.registo) {
        atualizarCopia(q.registo);
        if (S.feito && S.feito.itemId === q.id) { S.feito.entregue = true; S.feito.registo = q.registo; S.feito.jaEntrou = !!q.jaEntrou; S.feito.aviso = (q.avisos || [])[0] || ''; }
        if (!noFeito) K.toast(q.jaEntrou ? (q.avisos || [])[0] : AU.tituloItem(q) + ': enviado', { ms: q.jaEntrou ? 8000 : 3500 });
      }
      if (res.estado === 'parar') {
        if (q.code === 'MUDOU' && q.details && q.details.registo) atualizarCopia(q.details.registo);   // o registo de agora: é sobre ele que se decide outra vez
        if (!noFeito) K.toast(AU.tituloItem(q) + ': não entrou. ' + (q.erro || ''), { ms: 6000, acao: { rot: 'Ver', fn: function () { folhaItem(q); } } });
      }
      redesenhar();
    }

    // ════════════════ F3: registar, corrigir, anular, «Paga» e desfazer (despesas.js) ════════════════
    /** A despesa do servidor (a cópia, sem os comandos por cima): é a dela que leva a `versao` e o `pode`. */
    function registoDespBase(id) { var d = dados(); return d ? porId(d.despesas, id) : null; }
    var TEXTO_DESP = { registar: 'Despesa registada', corrigir: 'Corrigida · fica no histórico', anular: 'Despesa anulada · fica no histórico', paga: 'Marcada como paga', despagar: '«Paga» desfeita' };
    /** O pé da folha de uma despesa: as acções do `pode` (Corrigir, Marcar paga, Desfazer «Paga», Anular); nada sem a F3. */
    function peDespesa(x) {
      if (!despPodeEscrever() || x.porEnviar) return null;
      var raw = registoDespBase(x.id) || x, pode = raw.pode || [], bts = [], anular = null;
      if (pode.indexOf('corrigir') >= 0) { var bc = bt('mv-btn', 'Corrigir'); bc.id = 'b-desp-corrigir'; bc.addEventListener('click', function () { K.fecharFolha(); abrirDespForm(DS.formDoRegisto(raw)); }); bts.push(bc); }
      if (pode.indexOf('paga') >= 0) { var bp = bt('mv-btn pri', 'Marcar paga'); bp.id = 'b-desp-paga'; bp.addEventListener('click', function () { K.fecharFolha(); comandoDesp(raw, 'paga'); }); bts.push(bp); }
      if (pode.indexOf('despagar') >= 0) { var bd = bt('mv-btn', 'Desfazer «Paga»'); bd.id = 'b-desp-despagar'; bd.addEventListener('click', function () { K.fecharFolha(); comandoDesp(raw, 'despagar'); }); bts.push(bd); }
      if (pode.indexOf('anular') >= 0) { anular = bt('mv-btn neg', 'Anular'); anular.id = 'b-desp-anular'; anular.addEventListener('click', function () { folhaAnular(raw); }); }
      if (!bts.length && !anular) return null;
      return function (pe) {
        var w = el('div', 'mv-btns');
        if (bts.length === 1) w.appendChild(bts[0]); else if (bts.length) { var dois = el('div', 'mv-pe2'); bts.forEach(function (b) { dois.appendChild(b); }); w.appendChild(dois); }
        if (anular) w.appendChild(anular);
        pe.appendChild(w);
      };
    }
    /** Marcar paga ou desfazer «Paga»: segue já com o Desfazer de 5 s (nada se perde; o servidor decide pelo estado de agora). */
    function comandoDesp(raw, accao) {
      var q = DS.itemComando({ accao: accao, registo: raw, contaId: K.contaId(), contaNome: contaNome(), novoId: K.novoId, adiarMs: ADIAR });
      porComando(q, TEXTO_DESP[accao]);
    }
    /** Anular (só Pendente, pelo `pode`): o motivo é obrigatório, como no computador (deleteExpenseRow); fica Anulada, não se apaga. */
    function folhaAnular(raw) {
      var erro = function (t) { var e = $('pes-d-motivo-erro'); if (!e) return; limpar(e); e.hidden = !t; if (t) { e.appendChild(ic('alerta')); e.appendChild(el('span', null, t)); } };
      K.folha({ titulo: 'Anular a despesa?', foco: function () { return $('pes-d-motivo'); }, corpo: function (cc) {
        cc.appendChild(el('p', 'mv-folha-txt', [raw.categoria, P.eur(raw.valor), raw.data ? D.textoDiaCurto(raw.data) : ''].filter(Boolean).join(' · ') + '. Fica Anulada (não se apaga), com o motivo, e o histórico diz que foste tu.'));
        cc.appendChild(rotulo('Motivo', 'pes-d-motivo', true));
        var t = el('textarea', 'mv-campo curto'); t.id = 'pes-d-motivo'; t.maxLength = DS.LIMITES.motivo; t.placeholder = 'Ex.: registada em duplicado'; t.setAttribute('autocapitalize', 'sentences'); t.setAttribute('aria-describedby', 'pes-d-motivo-erro');
        t.addEventListener('input', function () { erro(''); });
        cc.appendChild(t);
        var e = el('p', 'mv-erro'); e.id = 'pes-d-motivo-erro'; e.setAttribute('role', 'alert'); e.hidden = true; cc.appendChild(e);
      }, pe: function (p) {
        var dois = el('div', 'mv-pe2'), a = bt('mv-btn', 'Manter'), b = bt('mv-btn neg', 'Anular despesa'); b.id = 'b-desp-anular-ok';
        a.addEventListener('click', function () { K.fecharFolha(); });
        b.addEventListener('click', function () {
          var m = String(($('pes-d-motivo') || {}).value || '').trim();
          if (!m) { erro('Escreve o motivo.'); K.A.focar($('pes-d-motivo')); return; }
          K.fecharFolha();
          porComando(DS.itemComando({ accao: 'anular', registo: raw, motivo: m, contaId: K.contaId(), contaNome: contaNome(), novoId: K.novoId, adiarMs: ADIAR }), TEXTO_DESP.anular);
        });
        dois.appendChild(a); dois.appendChild(b); p.appendChild(dois);
      } });
    }
    /** Já foi para a folha (decisão 4): avisa antes de gravar; também o 409 JA_NA_FOLHA leva aqui. info: { vai (o que vai
        mudar na despesa de agora), mudou (o que mudou entretanto no servidor) } — revisão da F3, C1: quem confirma vê a
        despesa de agora e só manda o que mudou. */
    function folhaConfirmarFolha(ref, aoConfirmar, info) {
      info = info || {};
      var d = dadosVista(), lista_ = function (cc, titulo, l) { if (!l || !l.length) return; cc.appendChild(el('p', 'mv-lh', titulo)); var ul = el('ul', 'mv-hist'); l.forEach(function (x) { ul.appendChild(el('li', null, DS.textoDiferenca(x, d))); }); cc.appendChild(ul); };
      K.folha({ titulo: 'Já foi para a folha', corpo: function (cc) {
        cc.appendChild(el('p', 'mv-folha-txt', DS.textoFolha(ref)));
        lista_(cc, 'Mudou entretanto (no computador ou noutro telemóvel)', info.mudou);
        if (info.vai) { if (info.vai.length) lista_(cc, 'O que vais mudar', info.vai); else cc.appendChild(el('p', 'mv-folha-txt', 'A despesa já está como a querias: não muda nada.')); }
        cc.appendChild(el('p', 'mv-folha-txt', 'O histórico da despesa vai dizer que foi corrigida depois de ir para a folha.'));
      }, pe: function (p) {
        var dois = el('div', 'mv-pe2'), a = bt('mv-btn', 'Rever'), b = bt('mv-btn pri', 'Confirmar e gravar'); b.id = 'b-desp-folha-ok';
        a.addEventListener('click', function () { K.fecharFolha(); }); b.addEventListener('click', function () { K.fecharFolha(); aoConfirmar(); });
        dois.appendChild(a); dois.appendChild(b); p.appendChild(dois);
      } });
    }
    function abrirDespesa(o) {
      if (!despPodeEscrever()) { K.toast('Registar despesas pelo telemóvel ainda não está ligado no servidor. Por agora, no computador.'); return; }
      var d = dados();
      abrirDespForm(DS.formNovo((d && d.hoje) || K.hojeDia().dia), o);
    }
    function abrirDespForm(f, o) { S.dform = f; S.dformErro = null; K.abrir('v-pes-desp-form', !!(o && o.substituir), !!(o && o.daFolha)); }
    /** O formulário da despesa: um só ecrã (data, categoria, valor, imputação, fatura em papel, observações). Registar com a
        imputação são 5 toques a partir do Pessoal (Despesa, a categoria, o valor, a obra, Registar); sem ela, 4. */
    function desenharDespForm() {
      var v = $('v-pes-desp-form'); if (!v || !S.dform || !DS) return;
      var f = S.dform;
      comFoco(v, function () {
        var d = dadosVista(), raw = f.accao === 'corrigir' ? registoDespBase(f.id) : null;
        var ld = el('p', 'mv-lead', f.accao === 'corrigir' ? 'Corriges a despesa; o histórico guarda o que mudou.' : 'Só as tuas · entra na próxima folha de despesas.'); ld.tabIndex = -1; ld.setAttribute('data-foco-inicial', ''); v.appendChild(ld);
        if (f.servidorMudou && f.servidorMudou.length) v.appendChild(faixa('ama', 'alerta', f.servidorMudou.map(function (x) { return DS.textoDiferenca(x, d); }).join(' · ') + '. O que mudaste fica por cima: revê e envia.', 'Mudou entretanto'));
        if (raw && DS.naFolha(raw)) v.appendChild(faixa('ama', 'alerta', 'Esta despesa já foi para a folha' + (raw.folha ? ' ' + raw.folha : '') + '. Podes corrigi-la: a folha em papel não muda, e confirmas antes de gravar.', 'Na folha'));
        v.appendChild(rotulo('Data', 'pes-d-data', true));
        v.appendChild(campoData('pes-d-data', 'd-data', f.data, null, function (x) { f.data = x; S.dformErro = null; }));
        v.appendChild(rotulo('Categoria', null, true));
        var cs = chips('Categoria', DS.CATEGORIAS, f.categoria, 'd-cat', function (x) { f.categoria = x; S.dformErro = null; desenharDespForm(); var y = $('pes-d-valor'); if (y && !String(f.valor || '').trim()) K.A.focar(y); });
        v.appendChild(cs);
        v.appendChild(rotulo('Ou escreve outra', 'pes-d-cat'));
        var ci = el('input', 'mv-in'); ci.id = 'pes-d-cat'; ci.value = f.categoria || ''; ci.maxLength = DS.LIMITES.categoria; ci.placeholder = 'Ex.: Parque da obra'; ci.setAttribute('data-k', 'd-cat-txt'); ci.setAttribute('autocapitalize', 'sentences'); ci.setAttribute('enterkeyhint', 'next');
        ci.addEventListener('input', function () { f.categoria = ci.value; S.dformErro = null; [].forEach.call(cs.querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', String(b.textContent === ci.value.trim())); }); });
        v.appendChild(ci);
        v.appendChild(rotulo('Valor (€)', 'pes-d-valor', true));
        var vi = el('input', 'mv-in'); vi.id = 'pes-d-valor'; vi.value = f.valor || ''; vi.setAttribute('inputmode', 'decimal'); vi.setAttribute('autocomplete', 'off'); vi.setAttribute('enterkeyhint', 'done'); vi.placeholder = '0,00'; vi.setAttribute('data-k', 'd-valor');
        vi.addEventListener('input', function () { f.valor = vi.value; S.dformErro = null; });
        v.appendChild(vi);
        zonaImput(v, f, d);
        v.appendChild(rotulo('Comprovativo', null));
        var gf = el('div', 'mv-grupo');
        gf.appendChild(opcao({ k: 'd-fatura', rot: 'Fatura em papel', desc: 'Já tenho o talão ou a fatura em papel', multi: true, on: !!f.faturaPapel, fn: function () { f.faturaPapel = !f.faturaPapel; desenharDespForm(); } }));
        v.appendChild(gf);
        v.appendChild(rotulo('Observações (opcional)', 'pes-d-notas'));
        var t = el('textarea', 'mv-campo curto'); t.id = 'pes-d-notas'; t.maxLength = DS.LIMITES.notas; t.value = f.notas || ''; t.placeholder = 'Ex.: jantar com a equipa de montagem'; t.setAttribute('data-k', 'd-notas'); t.setAttribute('autocapitalize', 'sentences');
        t.addEventListener('input', function () { f.notas = t.value; });
        v.appendChild(t);
        if (!K.online()) v.appendChild(faixa('ama', 'alerta', 'Sem rede: a despesa fica guardada neste telemóvel e envia-se sozinha quando houver rede.'));
        var e = el('p', 'mv-erro'); e.id = 'pes-d-erro'; e.setAttribute('role', 'alert');
        if (S.dformErro) { e.appendChild(ic('alerta')); e.appendChild(el('span', null, S.dformErro.texto)); } else e.hidden = true;
        v.appendChild(e);
      });
      barraDespForm();
    }
    /** Imputar a: uma obra (as da leitura, também as pausadas) ou um departamento; «Sem imputação» é uma escolha. */
    function zonaImput(v, f, d) {
      v.appendChild(rotulo('Imputar a', null));
      v.appendChild(segm('Imputar a', [['PROJETO', 'Obra'], ['DEPARTAMENTO', 'Departamento']], f.imputModo, 'd-imp', function (x) { f.imputModo = x; desenharDespForm(); }));
      var modo = f.imputModo, g = el('div', 'mv-grupo mv-pes-oo'); g.setAttribute('role', 'radiogroup'); g.setAttribute('aria-label', modo === 'PROJETO' ? 'Imputar a uma obra' : 'Imputar a um departamento');
      var por = function (tipo, id) { return function () { f.imputTipo = tipo; f.imputId = id; S.dformErro = null; desenharDespForm(); }; };
      g.appendChild(opcao({ k: 'd-imp-sem', rot: 'Sem imputação', on: !f.imputTipo, fn: por('', '') }));
      if (modo === 'PROJETO') {
        var os = DS.obrasImput(d);
        if (f.imputTipo === 'PROJETO' && f.imputId && !os.some(function (o) { return o.id === f.imputId; })) g.appendChild(opcao({ k: 'd-o-' + f.imputId, rot: String(f.imputRotuloAntes || f.imputId).replace(/^Obra — /, ''), desc: 'Já não está entre as obras activas', on: true, fn: por('PROJETO', f.imputId) }));
        if (!os.length) g.appendChild(linha({ ic: 'obra', t: 'Sem obras na leitura', s: 'Com rede, a lista atualiza-se' }));
        os.forEach(function (o) { g.appendChild(opcao({ k: 'd-o-' + o.id, rot: (o.codigo ? o.codigo + ' · ' : '') + o.nome, desc: o.estado === 'PAUSED' ? 'Pausada' : '', on: f.imputTipo === 'PROJETO' && f.imputId === o.id, fn: por('PROJETO', o.id) })); });
      } else {
        ((d && d.departamentos) || []).forEach(function (x) { g.appendChild(opcao({ k: 'd-dp-' + x.codigo, rot: x.nome, on: f.imputTipo === 'DEPARTAMENTO' && f.imputId === x.codigo, fn: por('DEPARTAMENTO', x.codigo) })); });
      }
      v.appendChild(g);
      if (f.imputTipo && f.imputTipo !== modo) v.appendChild(el('p', 'mv-pes-nota', 'Escolhido: ' + DS.imputRotulo(f.imputTipo, f.imputId, d)));
    }
    function barraDespForm() {
      var bb = $('barra-pes-desp'); if (!bb || !S.dform) return; limpar(bb);
      var pri = bt('mv-btn pri', S.dform.accao === 'corrigir' ? 'Guardar' : 'Registar'); pri.id = 'b-desp-enviar';
      pri.addEventListener('click', function () { enviarDespForm(); });
      bb.appendChild(pri);
      K.A.medirBarra();
    }
    function enviarDespForm() {
      var f = S.dform; if (!f) return;
      var falta = DS.faltaNoForm(f);
      if (falta) { S.dformErro = falta; desenharDespForm(); var e = $('pes-d-erro'); if (e) K.A.focar(e); return; }
      S.dformErro = null;
      var q0 = f.deItem ? itemDaFila(f.deItem) : null, raw = f.accao === 'corrigir' ? registoDespBase(f.id) : null;
      if (f.accao === 'corrigir' && !raw && !q0) { K.toast('Esta despesa já não está na tua lista: lê o Pessoal outra vez.'); return; }
      // corrigir manda só o que a pessoa mudou em relação ao que leu (f.base; no «Mudar», a despesa de agora)
      if (f.accao === 'corrigir' && !DS.temMudancas(DS.camposDe(f))) { K.toast('Nada mudou: a despesa já estava assim.'); return; }
      var segue = function (confirmou) {
        var fCopia = JSON.parse(JSON.stringify(f));
        if (q0 && K.fila().indexOf(q0) >= 0 && (q0.estado === 'parado' || !q0.tentou)) {   // «Mudar» um que não entrou (ou que ainda não saiu): o mesmo item, outra intenção
          if (reporComando(q0, { campos: DS.camposDe(f, { confirmouFolha: confirmou }), versao: f.accao === 'corrigir' && raw ? raw.versao : undefined, base: f.accao === 'corrigir' ? (f.base || null) : undefined, registo: raw || undefined }, TEXTO_DESP[f.accao]) === false) return;
        } else {
          var item = DS.itemComando({ accao: f.accao, registo: raw, form: f, confirmouFolha: confirmou, contaId: K.contaId(), contaNome: contaNome(), novoId: K.novoId, adiarMs: ADIAR, id: f.accao === 'registar' && f.id ? f.id : undefined });
          porComando(item, TEXTO_DESP[f.accao], { desfeito: function () { var g = JSON.parse(JSON.stringify(fCopia)); g.deItem = ''; abrirDespForm(g); } });
        }
        S.dform = null;
        K.voltar();
      };
      if (raw && DS.naFolha(raw)) { folhaConfirmarFolha(raw.folha, function () { segue(true); }, { vai: DS.vaiMudar(DS.camposDe(f), raw) }); return; }
      segue(false);
    }
    /** «Mudar» um comando de despesa: a confirmação da folha (JA_NA_FOLHA), outra vez com a versão de agora (anular, pagar e
        desfazer que mudaram), ou o formulário com o que se tinha (registar, corrigir). */
    function mudarDesp(q, o) {
      var raw = registoDespBase(q.registoId), agora = (q.details && q.details.registo) || raw, versaoAgora = (agora && agora.versao) || q.versao;
      if (q.estado === 'parado' && q.confirmarFolha) {
        // a despesa de AGORA (details.registo) e só os campos que a pessoa mudou: o que o computador corrigiu entretanto fica
        var info = agora ? { vai: DS.vaiMudar(q.campos, agora), mudou: q.base ? DS.diferencas(q.base, DS.baseDe(agora)) : [] } : {};
        folhaConfirmarFolha(q.folha || (q.details && q.details.folha) || (agora && agora.folha) || '', function () { reporComando(q, { versao: versaoAgora, confirmouFolha: true, base: agora ? DS.baseDe(agora) : undefined, registo: agora || undefined }, 'Confirmado · segue já'); }, info);
        return;
      }
      if (q.accao === 'anular' || q.accao === 'paga' || q.accao === 'despagar') {
        if (!raw) { K.toast('Esta despesa já não está na tua lista: lê o Pessoal outra vez.'); return; }
        reporComando(q, { versao: raw.versao }, 'Outra vez · segue já'); return;
      }
      abrirDespForm(DS.formDoItem(q, q.accao === 'corrigir' ? raw : null), o);
    }
    function aoResultadoDesp(q, res) {
      if (res.estado === 'entregue' && q.registo) {
        atualizarCopia(q.registo, DS);
        var av = (q.avisos || [])[0];
        K.toast(q.jaEntrou ? av : (av || DS.tituloItem(q) + ': enviado'), { ms: q.jaEntrou ? 8000 : 3500 });
      }
      if (res.estado === 'parar') {
        if (q.details && q.details.registo) atualizarCopia(q.details.registo, DS);   // a despesa de agora: é sobre ela que se decide outra vez
        K.toast(DS.tituloItem(q) + ': não entrou. ' + (q.erro || ''), { ms: 6000, acao: { rot: 'Ver', fn: function () { folhaItem(q); } } });
      }
      redesenhar();
    }

    function desenhar(v) { if (v === 'v-pessoal') desenharTopo(); else if (v === 'v-pes-ferias') desenharFerias(); else if (v === 'v-pes-faltas') desenharFaltas(); else if (v === 'v-pes-despesas') desenharDespesas(); else if (v === 'v-pes-form') desenharForm(); else if (v === 'v-pes-feito') desenharFeito(); else if (v === 'v-pes-desp-form') desenharDespForm(); }
    function redesenhar() {
      var v = K.vista(); if (!naVista() || K.A.vista() !== v) return;
      if (v === 'v-pes-form' || v === 'v-pes-desp-form') return;   // os formulários não se redesenham por fora (perdiam o que se está a escrever)
      desenhar(v);
    }
    function aoSair() { clearTimeout(S.timer); S = estadoNovo(); }   // a cópia guardada apaga-a a casca (apagarCache), com as outras leituras

    return {
      VISTAS: VISTAS, ROTULO: { 'v-pessoal': 'Pessoal', 'v-pes-ferias': 'Férias', 'v-pes-faltas': 'Faltas', 'v-pes-despesas': 'Despesas', 'v-pes-form': 'Pedido', 'v-pes-feito': 'Pessoal', 'v-pes-desp-form': 'Despesa' },
      TITULO: { 'v-pessoal': 'Pessoal', 'v-pes-ferias': 'Férias', 'v-pes-faltas': 'Faltas e ausências', 'v-pes-despesas': 'Despesas', 'v-pes-form': 'Pedido', 'v-pes-feito': 'Pessoal', 'v-pes-desp-form': 'Despesa' },
      titulo: function (v) { if (v === 'v-pes-form' && S.form && AU) return tituloForm(); if (v === 'v-pes-desp-form' && S.dform) return S.dform.accao === 'corrigir' ? 'Corrigir despesa' : 'Registar despesa'; return ''; },
      ativo: ativo, recusado: recusado, ler: ler,
      /** Porque é que o Pessoal não abre, com as palavras do servidor (a recusa ou o «em breve» desta abertura); '' = não se sabe. */
      motivo: function () { return S.recusa ? (S.erro || '') : (S.fora ? (S.foraTexto || '') : ''); }, desenhar: desenhar, redesenhar: redesenhar, aoSair: aoSair,
      aoMudarRede: function () { S.semLigacao = false; if (naVista()) { if (K.online()) ler(true); else redesenhar(); } },
      // F2: os pedidos (a casca chama-os: o «+», o drenar e o «Por enviar»)
      ausDisponivel: ausDisponivel, podeEscrever: podeEscrever, abrirPedir: abrirPedir, retido: retido,
      processar: processar, aoResultado: aoResultado, linhaFila: linhaFila,
      temForm: function () { return !!S.form; }, temFeito: function () { return !!S.feito; },
      // F3: as despesas (a casca chama-as: o «+», o drenar e o «Por enviar»)
      despDisponivel: despDisponivel, despPodeEscrever: despPodeEscrever, abrirDespesa: abrirDespesa, temDespForm: function () { return !!S.dform; },
      _estado: function () { return S; },
    };
  }
  self.DoeMovelPesEcra = { criar: criar, EM_BREVE: P.EM_BREVE };
}());
