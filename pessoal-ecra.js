/* DOE · Telemóvel — os ecrãs do Pessoal, fase 1 (16 nov 2026): SÓ PARA LER. O separador Pessoal (o saldo de férias com a
   barra, «A seguir», «À espera de decisão», as entradas de Férias, Faltas e ausências, Horas e atrasos e Despesas), o ecrã
   Férias (de onde vêm os dias, os pedidos, o ano dia a dia, os feriados e fechos), o das Faltas e ausências (por mês) e o
   das Despesas (por reembolsar, pagas, anuladas); cada pedido, falta e despesa abre numa folha com o estado e o histórico.
   Desenho: o protótipo validado pelo Pedro (docs/prototipos/telemovel-perfis/pessoal.js), SEM as acções: nesta fase o
   `pode` vem sempre vazio, por isso não há botões de pedir, corrigir, cancelar nem marcar paga (uma só frase diz que
   chegam a seguir). A lógica é a de pessoal.js (pura, testada em Node e contra o servidor real); a casca dá o kit (`K`).
   Regras:
   - tudo o que vem do servidor entra por textContent;
   - quem tem Pessoal decide-o o servidor (`pessoal` nas funcionalidades); a Edge de antes da F1 (403 TOKEN_DE_AMBITO)
     deixa o separador «Em breve» nesta abertura, sem pedir o login e sem tocar na fila;
   - a leitura é a pedido (ao abrir o separador, ao voltar a rede, ao tocar na linha da data), em memória, e a cópia fica na
     localStorage, numa chave própria com a conta dentro (`doeMovel.pessoal`, revisão de f673e387, P1), para abrir sem rede
     («a cópia é das 08:12»); se não couber, fica só em memória e nada mais deixa de se gravar. Com o telemóvel desligado
     (TOKEN_REVOGADO), ao Sair e quando entra outra conta, a casca apaga-a com as outras leituras. */
(function () {
  'use strict';
  var P = self.DoeMovelPessoal, D = self.DoeMovelDiario;
  if (!P || !D) return;
  var MS_RELER = 30 * 1000, ESPERAS = self.DOE_MOVEL_ESPERAS_LER || [5000, 30000, 120000];
  var VISTAS = ['v-pessoal', 'v-pes-ferias', 'v-pes-faltas', 'v-pes-despesas'];

  function criar(K) {
    var S = estadoNovo();
    var el = K.el, bt = K.bt, ic = K.ic, limpar = K.limpar, $ = function (id) { return document.getElementById(id); };
    function estadoNovo() { return { lendo: false, erro: '', fora: false, recusa: '', semLigacao: false, lidoMs: 0, falhas: 0, timer: null, filtroFer: 'seguir', vistaFer: 'lista', filtroFt: 'mes', filtroDp: 'reemb', copia: null, soMemoria: false }; }
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
    function guardarCopia(data) {
      var conta = K.contaId(), lidoEm = new Date().toISOString(), g = P.paraGuardar(conta, data, lidoEm), ok = false;
      S.copia = { contaId: conta, data: data, lidoEm: lidoEm, cortada: false };   // o ecrã mostra sempre a leitura inteira
      if (g) { try { localStorage.setItem(P.LS_PESSOAL, g.texto); ok = true; } catch (e) { ok = false; } }
      if (!ok) lsApagar();   // não coube: fica só em memória (uma cópia velha não fica a fingir que é a de agora)
      S.soMemoria = !ok;
    }
    function apagarCopia() { S.copia = null; lsApagar(); }
    function dados() { var c = copia(); return c ? c.data : null; }
    function naVista() { return VISTAS.indexOf(K.vista()) >= 0; }

    // ── Quem tem Pessoal (o servidor decide; a casca junta o quemVe()) ──
    /** A funcionalidade vem do servidor e o servidor não disse «não» nesta abertura. */
    function ativo() { return !S.fora && !S.recusa && P.temFuncionalidade(K.funcsPessoal()); }
    /** O servidor disse que esta conta não tem Pessoal (só de telemóvel, externa): o separador sai nesta abertura. */
    function recusado() { return S.recusa === 'SEM_PESSOAL' || S.recusa === 'CONTA_EXTERNA' || S.recusa === 'PAPEL_SEM_ESCRITA'; }   // revisão (C1): a conta que passou a só leitura perde-o

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
      if (f.tipo === 'embreve') { S.fora = true; sair(f.texto); return; }
      if (f.tipo === 'recusa') {
        apagarCopia();   // a conta deixou de ter Pessoal: a cópia não fica no telemóvel
        S.recusa = f.code;
        if (f.tirar) { sair(f.texto); return; }
        S.erro = f.texto; redesenhar(); return;
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
    function linha(o) {   // { ic, cls, t, s, est: {t, cls}, fn, k }
      var b = o.fn ? bt('mv-pes-l') : el('div', 'mv-pes-l leve');
      var i = el('span', 'mv-pes-ic' + (o.cls ? ' ' + o.cls : '')); i.setAttribute('aria-hidden', 'true'); i.appendChild(ic(o.ic)); b.appendChild(i);
      var t = el('span', 'mv-pes-lt'); t.appendChild(el('b', null, o.t)); if (o.s) t.appendChild(el('small', null, o.s)); b.appendChild(t);
      if (o.est) b.appendChild(el('span', 'mv-pes-est' + (o.est.cls ? ' ' + o.est.cls : ''), o.est.t));
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
    function linhaPedido(p, d) {
      var n = Number(p.diasUteis) || 0, e = P.estadoAusencia(p), et = P.etapaTexto(p);
      return linha({ ic: 'cal', cls: e.cls === 'neg' ? 'neg' : (e.cls === 'ama' ? 'ama' : (e.cls === 'pos' ? 'pos' : '')), t: P.intervalo(p.inicio, p.fim),
        s: 'Férias · ' + n + (n === 1 ? ' dia útil' : ' dias úteis') + (et ? ' · ' + et : '') + (String(p.inicio).slice(0, 4) !== String(d.ano) ? ' · conta em ' + String(p.inicio).slice(0, 4) : ''),
        est: e, k: 'ped-' + p.id, fn: function () { folhaPedido(p.id); } });
    }
    function linhaFalta(p, d) {
      var e = P.estadoAusencia(p), det = P.detalheFalta(p, d), pres = P.presenca(p), n = Number(p.dias) || 0;
      var s = P.intervalo(p.inicio, p.fim) + (pres ? '' : ' · ' + n + (n === 1 ? ' dia' : ' dias')) + (p.justificativos ? ' · justificativo no arquivo RH' : (p.anexo ? ' · com comprovativo' : ''));
      return linha({ ic: pres ? 'obra' : 'falta', cls: e.cls, t: p.rotulo + (det ? ' · ' + det : ''), s: s, est: e, k: 'ft-' + p.id, fn: function () { folhaFalta(p.id); } });
    }
    function linhaDespesa(x) {
      var e = P.estadoDespesa(x), im = P.imputCurta(x);
      return linha({ ic: 'etiqueta', cls: e.cls === 'nav' ? '' : e.cls, t: (x.categoria || 'Despesa') + ' · ' + P.eur(x.valor), s: (x.data ? D.textoDiaCurto(x.data) : '') + (im ? ' · ' + im : ''), est: e, k: 'dp-' + x.id, fn: function () { folhaDespesa(x.id); } });
    }
    function linhaFeriado(f, comToque) {
      var s = f.fecho ? f.nome + ' · conta se um pedido teu o cobrir' : f.nome + ' · não conta como dia de férias';
      return linha({ ic: 'cal', cls: '', t: P.intervalo(f.inicio, f.fim), s: s, k: comToque ? 'fer-' + f.inicio : null, fn: comToque ? folhaFeriados : null });
    }

    // ── O separador Pessoal ──
    function desenharTopo() {
      var v = $('v-pessoal'); if (!v) return;
      comFoco(v, function () {
        var cab = el('div', 'mv-hcab'), l = el('div', 'mv-hcab-l'), h1 = el('h1', 'mv-hola', 'Pessoal'); h1.id = 'pes-h1'; h1.tabIndex = -1; h1.setAttribute('data-foco-inicial', '');
        l.appendChild(h1); cab.appendChild(l); cab.appendChild(linhaData()); v.appendChild(cab);
        faixaErro(v);
        var d = dados(); if (!d) { semDados(v); return; }
        var r = P.resumoSaldo(d), sd = el('section', 'mv-pes-saldo'); sd.setAttribute('aria-label', 'Férias ' + r.ano + ': ' + r.n + ' ' + r.unidade + ' ' + r.sub);
        sd.appendChild(pilula({ t: 'Férias ' + r.ano, cls: 'nav' }));
        var nb = el('div', 'mv-num', String(r.n)); nb.appendChild(el('small', null, r.unidade)); sd.appendChild(nb);
        sd.appendChild(el('p', null, r.sub));
        v.appendChild(sd);
        barraEl(d.saldo).forEach(function (x) { v.appendChild(x); });
        if (r.prox) v.appendChild(el('p', 'mv-pes-prox', r.prox));
        v.appendChild(el('p', 'mv-pes-nota', 'Pedir férias, registar faltas e despesas pelo telemóvel chega a seguir. Por agora, no computador.'));
        var a = P.aSeguir(d, feriados());
        v.appendChild(grupo('A seguir', a.pedido || a.feriado ? [a.pedido ? linhaPedido(a.pedido, d) : null, a.feriado ? linhaFeriado(a.feriado, true) : null] : [linha({ ic: 'cal', t: 'Nada marcado a seguir' })]));
        var esp = P.esperaDecisao(d);
        if (esp.length) v.appendChild(grupo('À espera de decisão', esp.map(function (p) { return P.ehFerias(p) ? linhaPedido(p, d) : linhaFalta(p, d); }), String(esp.length)));
        var fm = P.faltasDoMes(d), s = d.saldo || {}, pr = d.porReembolsar || {};
        v.appendChild(grupo('Férias', [linha({ ic: 'cal', t: 'As minhas férias', s: (Number(s.direito) || 0) + ' de direito · os pedidos, o ano e os feriados', k: 'ir-ferias', fn: function () { K.abrir('v-pes-ferias'); } })]));
        v.appendChild(grupo('Faltas e ausências', [linha({ ic: 'falta', t: fm.mes + ': ' + fm.faltas + (fm.faltas === 1 ? ' falta' : ' faltas') + ' · ' + fm.fora + ' fora do escritório', s: 'Teletrabalho e Out of Office contam à parte', k: 'ir-faltas', fn: function () { K.abrir('v-pes-faltas'); } })]));
        v.appendChild(grupo('Horas e atrasos', [linha({ ic: 'relogio', t: 'O meu registo de horas e os atrasos', s: 'Chega em breve' })]));
        v.appendChild(grupo('Despesas', [linha({ ic: 'etiqueta', t: 'Por reembolsar: ' + P.eur(pr.valor), s: (Number(pr.n) || 0) + ((Number(pr.n) || 0) === 1 ? ' despesa' : ' despesas') + ' · pendentes ou a aguardar assinatura', k: 'ir-despesas', fn: function () { K.abrir('v-pes-despesas'); } })]));
      });
    }

    // ── Férias ──
    function desenharFerias() {
      var v = $('v-pes-ferias'); if (!v) return;
      comFoco(v, function () {
        var d = dados();
        lead(v, 'Férias' + (d ? ' de ' + d.ano : '') + ' · só as tuas');
        faixaErro(v);
        if (!d) { semDados(v); return; }
        var cart = el('div', 'mv-grupo mv-pes-cart');
        barraEl(d.saldo).forEach(function (x) { cart.appendChild(x); });
        P.contasSaldo(d).forEach(function (z) { cart.appendChild(K.rlinha(z[0], z[1])); });
        v.appendChild(cart);
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
      });
    }

    // ── Faltas e ausências ──
    function desenharFaltas() {
      var v = $('v-pes-faltas'); if (!v) return;
      comFoco(v, function () {
        var d = dados();
        lead(v, 'As tuas faltas, teletrabalho e Out of Office');
        faixaErro(v);
        if (!d) { semDados(v); return; }
        v.appendChild(segm('Período', [['mes', 'Este mês'], ['ano', String(d.ano)]], S.filtroFt, 'ft', function (x) { S.filtroFt = x; desenharFaltas(); }));
        var gs = P.faltasPorMes(d, S.filtroFt);
        if (!gs.length) v.appendChild(el('p', 'mv-nada', S.filtroFt === 'mes' ? 'Sem faltas nem ausências este mês.' : 'Sem faltas nem ausências em ' + d.ano + '.'));
        gs.forEach(function (g) { v.appendChild(grupo(g.mes, g.itens.map(function (p) { return linhaFalta(p, d); }), String(g.itens.length))); });
      });
    }

    // ── Despesas ──
    function desenharDespesas() {
      var v = $('v-pes-despesas'); if (!v) return;
      comFoco(v, function () {
        var d = dados();
        lead(v, 'As tuas despesas e o reembolso');
        faixaErro(v);
        if (!d) { semDados(v); return; }
        var pr = d.porReembolsar || {}, n = Number(pr.n) || 0, cart = el('div', 'mv-grupo mv-pes-cart'), tot = el('div', 'mv-pes-tot');
        tot.appendChild(el('small', null, 'Por reembolsar')); tot.appendChild(el('b', null, P.eur(pr.valor))); tot.appendChild(el('small', null, n + (n === 1 ? ' despesa' : ' despesas') + ' · só as tuas'));
        cart.appendChild(tot); v.appendChild(cart);
        v.appendChild(segm('Estado', [['reemb', 'Por reembolsar'], ['pagas', 'Pagas'], ['anuladas', 'Anuladas']], S.filtroDp, 'dp', function (x) { S.filtroDp = x; desenharDespesas(); }));
        var gs = P.despesasGrupos(d, S.filtroDp);
        if (!gs.length) v.appendChild(el('p', 'mv-nada', S.filtroDp === 'pagas' ? 'Sem despesas pagas em ' + d.ano + '.' : (S.filtroDp === 'anuladas' ? 'Sem despesas anuladas em ' + d.ano + '.' : 'Nada por reembolsar.')));
        gs.forEach(function (g) { v.appendChild(grupo(g.titulo, g.itens.map(linhaDespesa), String(g.itens.length))); });
        v.appendChild(el('p', 'mv-pes-nota', 'A folha das despesas imprime-se e assina-se no computador, como as ajudas de custo.'));
      });
    }

    // ── Folhas (o detalhe, só para ler) ──
    function historico(cc, h, ano) {
      var l = (h || []).slice().reverse();   // do mais recente
      if (!l.length) return;
      var s = el('section', 'mv-sec'), hh = el('div', 'mv-sec-h'); hh.appendChild(el('h3', 'mv-h2', 'Histórico')); s.appendChild(hh);
      var ul = el('ul', 'mv-hist');
      l.forEach(function (x) { var li = el('li'); li.appendChild(el('b', null, x.texto || '')); var q = P.quando(x.em, ano); if (q || x.porNome) li.appendChild(el('small', null, q + (x.porNome ? (q ? ' · ' : '') + x.porNome : ''))); ul.appendChild(li); });
      s.appendChild(ul); cc.appendChild(s);
    }
    function porId(l, id) { return (l || []).filter(function (x) { return x.id === id; })[0] || null; }
    function folhaPedido(id) {
      var d = dados(), p = d && porId(d.pedidos, id); if (!p) return;
      var n = Number(p.diasUteis) || 0, e = P.estadoAusencia(p);
      K.folha({ titulo: 'Férias · ' + P.intervalo(p.inicio, p.fim), sub: n + (n === 1 ? ' dia útil' : ' dias úteis') + (String(p.inicio).slice(0, 4) !== String(d.ano) ? ' · conta em ' + String(p.inicio).slice(0, 4) : ''), alta: true, corpo: function (cc) {
        cc.appendChild(pilula(e));
        var quem = p.estado === 'PENDING' ? (p.etapa === 'DEPT' ? (p.decideNome || 'A tua chefia') + ', depois o RH' : 'Recursos Humanos') : (p.decisao && p.decisao.porNome ? p.decisao.porNome : '');
        cc.appendChild(K.rlinha('Estado', e.t + (p.estado === 'PENDING' ? (p.etapa === 'RH' ? ' · aguarda o RH' : ' · aguarda a chefia') : '')));
        if (quem) cc.appendChild(K.rlinha(p.estado === 'PENDING' ? 'Decide' : 'Decidiu', quem));
        if (p.decisao && p.decisao.em) cc.appendChild(K.rlinha('Em', P.quando(p.decisao.em, d.ano)));
        if (p.estado === 'REJECTED' && p.decisao && p.decisao.nota) cc.appendChild(K.rlinha('Motivo', p.decisao.nota));
        if (p.nota) cc.appendChild(K.rlinha('Nota', p.nota));
        historico(cc, p.historico, d.ano);
      } });
    }
    function folhaFalta(id) {
      var d = dados(), p = d && porId(d.pedidos, id); if (!p) return;
      var e = P.estadoAusencia(p), pres = P.presenca(p), n = Number(p.dias) || 0, det = P.detalheFalta(p, d);
      K.folha({ titulo: p.rotulo, sub: P.intervalo(p.inicio, p.fim) + (pres ? '' : ' · ' + n + (n === 1 ? ' dia' : ' dias')), alta: true, corpo: function (cc) {
        cc.appendChild(pilula(e));
        cc.appendChild(K.rlinha('Tipo', p.rotulo));
        if (det && p.tipo !== 'OUT_OFFICE') cc.appendChild(K.rlinha('Motivo', det));
        if (p.horasCompleto === false && p.horaInicio && p.horaFim) cc.appendChild(K.rlinha('Horas', p.horaInicio + '–' + p.horaFim));
        if (p.tipo === 'OUT_OFFICE') { var ds = P.destinoOutOffice(p, d); if (ds) cc.appendChild(K.rlinha('Onde', ds)); }
        cc.appendChild(K.rlinha('Estado', e.t));
        cc.appendChild(K.rlinha('Valida', pres ? 'Ninguém · o RH é informado' : 'Recursos Humanos'));
        if (!pres) cc.appendChild(K.rlinha('Comprovativo', p.justificativos ? 'Justificativo no arquivo RH' : (p.anexo ? 'Com documento comprovativo (entregue ou a entregar ao RH)' : 'Sem comprovativo')));
        if (p.decisao && p.decisao.porNome) cc.appendChild(K.rlinha('Decidiu', p.decisao.porNome + (p.decisao.em ? ' · ' + P.quando(p.decisao.em, d.ano) : '')));
        if (p.estado === 'REJECTED' && p.decisao && p.decisao.nota) cc.appendChild(K.rlinha('Motivo da decisão', p.decisao.nota));
        if (p.nota) cc.appendChild(K.rlinha('Nota', p.nota));
        historico(cc, p.historico, d.ano);
      } });
    }
    function folhaDespesa(id) {
      var d = dados(), x = d && porId(d.despesas, id); if (!x) return;
      var e = P.estadoDespesa(x);
      K.folha({ titulo: P.eur(x.valor), sub: (x.categoria || 'Despesa') + (x.data ? ' · ' + D.textoDiaCurto(x.data) : ''), alta: true, corpo: function (cc) {
        cc.appendChild(pilula(e));
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

    function desenhar(v) { if (v === 'v-pessoal') desenharTopo(); else if (v === 'v-pes-ferias') desenharFerias(); else if (v === 'v-pes-faltas') desenharFaltas(); else if (v === 'v-pes-despesas') desenharDespesas(); }
    function redesenhar() { var v = K.vista(); if (naVista() && K.A.vista() === v) desenhar(v); }
    function aoSair() { clearTimeout(S.timer); S = estadoNovo(); }   // a cópia guardada apaga-a a casca (apagarCache), com as outras leituras

    return {
      VISTAS: VISTAS, ROTULO: { 'v-pessoal': 'Pessoal', 'v-pes-ferias': 'Férias', 'v-pes-faltas': 'Faltas', 'v-pes-despesas': 'Despesas' },
      TITULO: { 'v-pessoal': 'Pessoal', 'v-pes-ferias': 'Férias', 'v-pes-faltas': 'Faltas e ausências', 'v-pes-despesas': 'Despesas' },
      ativo: ativo, recusado: recusado, ler: ler, desenhar: desenhar, redesenhar: redesenhar, aoSair: aoSair,
      aoMudarRede: function () { S.semLigacao = false; if (naVista()) { if (K.online()) ler(true); else redesenhar(); } },
      _estado: function () { return S; },
    };
  }
  self.DoeMovelPesEcra = { criar: criar, EM_BREVE: P.EM_BREVE };
}());
