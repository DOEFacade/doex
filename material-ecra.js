/* DOE · Telemóvel — os ecrãs dos Pedidos de material (fatia 2b, entrega 1, 24 nov 2026): a lista da obra (Abertos ·
   Fechados, uma caixa por pedido com o estado de cada linha e a régua de 4 passos), o pedido aberto numa folha (decidir,
   linha a linha ou «Aceitar tudo», com o motivo da recusa em frases de um toque; receber, linha a linha ou «Recebi tudo o
   que chegou»; «Há um problema» com as frases; corrigir, tirar e repor o que se pediu; o histórico), o formulário «Pedir
   material» (obra, materiais com quantidade e unidade, «Pedidos antes nesta obra», «Preciso até», nota; «Vai para Nome, GP
   da obra») e, no Hoje, o bloco Material e as faixas «N materiais por decidir» e «Chega hoje». Desenho:
   docs/prototipos/DOEX-Movel-Material-Prototipo.html (validado pelo Pedro). A lógica é a de material.js; a casca dá-me o kit
   (`K`), o mesmo dos trabalhos. Regras: tudo o que vem do servidor entra por textContent; os botões são os do `pode` do
   servidor; cada acção é um COMANDO na fila da conta, as que têm Desfazer só seguem depois de o aviso acabar; sem rede ficam
   «por enviar». «A caminho» e a data marcam-se no computador (decisão P1/P2 do Pedro): aqui só se lêem. Sem fotos (P4). */
(function () {
  'use strict';
  var P = self.DoeMovelPm, T = self.DoeMovelTf, D = self.DoeMovelDiario;
  if (!P || !T || !D) return;
  var ADIAR = self.DOE_MOVEL_TF_ADIAR || 5000;   // o Desfazer (o mesmo dos trabalhos; os testes encurtam-no)
  function pl(n, um, varios) { return n + ' ' + (n === 1 ? um : varios); }

  function criar(K) {
    var novo = function () { return { obra: '', filtro: 'abertos', lendo: false, erro: '', fora: '', form: null, sel: '', prob: null }; };
    var S = novo(), lidosFaixa = {};
    var el = K.el, bt = K.bt, ic = K.ic, junta = K.junta, limpar = K.limpar, $ = function (id) { return document.getElementById(id); };
    function hoje() { return K.hojeDia().dia; }
    function eu() { var s = K.sessao(); return { nome: (s && s.nome) || '' }; }
    function minhaFila() { return K.fila().filter(function (q) { return q.contaId === K.contaId() && q.estado !== 'entregue' && !K.apagar[q.id]; }); }
    function deps() {
      var dp = K.deps(), conta = K.contaId();
      dp.aoGravado = function (item, data) { if (K.contaId() !== conta || !data.registo) return; P.porRegisto(K.cache(), data.registo); K.gravarCache(); };
      return dp;
    }
    /** Pode entrar? A funcionalidade no servidor (Edge ∩ SQL), o Hoje novo a responder e o servidor sem ter dito «não» nesta
        abertura (uma conta que não vê os pedidos desta obra recebe-o na primeira leitura e a entrada sai). */
    function disponivel() { return K.tem('material') && K.temHojeMv() && !S.fora; }

    // ── Leitura ──
    async function lerLista(ob) {
      if (!ob || !K.A.sessaoValida() || !K.online()) { redesenharLista(); return false; }
      var conta = K.contaId();
      S.lendo = true; redesenharLista();
      try {
        var r = await P.lerLista(deps(), ob);
        if (K.contaId() !== conta) return false;
        if (r.ok) { P.guardarLista(K.cache(), ob, r.data); K.gravarCache(); S.erro = ''; return true; }
        return falhou(r);
      } finally { S.lendo = false; redesenharLista(); redesenharFolha(); if (K.vista() === 'v-pm-form') desenharForm(); }
    }
    function falhou(r) {
      var m = P.mensagemPm(r);
      if (r.code === 'TOKEN_DE_AMBITO') { S.fora = m.texto; S.erro = ''; return false; }
      if (K.talvezLogin(D.mensagemDiario(r))) return false;
      if (r.code === 'CONTA_EXTERNA' || r.code === 'MATERIAL_POR_INSTALAR') S.fora = m.texto;   // a entrada sai nesta abertura
      S.erro = r.rede ? '' : m.texto;
      return false;
    }
    function lista(ob) { var x = P.listaDe(K.cache(), ob); return x ? x : null; }
    function pedidos(ob) { var x = lista(ob || S.obra); return P.comPendentes(x ? (x.data.pedidos || []) : [], minhaFila(), ob || S.obra, hoje(), eu()); }
    function pedidoDe(id, ob) { return pedidos(ob).filter(function (p) { return p.id === id; })[0] || null; }
    function pode(x, a) { return (x.pode || []).indexOf(a) >= 0; }

    // ── A régua de 4 passos (Pedido · Aceite · A caminho · Recebido) ──
    function regua(w) {
      var r = el('span', 'pm-reg' + (w.tom ? ' ' + w.tom : '')); r.setAttribute('aria-hidden', 'true');
      for (var i = 0; i < 4; i++) r.appendChild(el('i', i <= w.passo ? 'f' : null));
      return r;
    }

    // ── A lista (v-pm) ──
    function abrirLista(ob, substituir) {
      if (!ob) return;
      S.obra = ob; S.filtro = 'abertos';
      K.abrir('v-pm', !!substituir);
      lerLista(ob);
    }
    function redesenharLista() { if (K.vista() === 'v-pm' && K.A.vista() === 'v-pm') desenharLista(); }
    function desenharLista() {
      var v = $('v-pm'); if (!v) return;
      var ae = document.activeElement, k = ae && v.contains(ae) ? ae.getAttribute('data-k') : null;
      limpar(v);
      var o = K.obraDe(S.obra), x = lista(S.obra);
      var lead = el('p', 'mv-lead'); lead.tabIndex = -1; lead.setAttribute('data-foco-inicial', '');
      if (o) junta(lead, el('code', null, o.codigo || ''), ' · ' + o.nome);
      var est = S.lendo ? (x ? ' · a atualizar…' : ' · a ler…') : (x && (!K.online() || /^de /.test(D.textoDados(x.lidoEm, new Date()))) ? ' · dados ' + D.textoDados(x.lidoEm, new Date()) : '');
      if (est) lead.appendChild(document.createTextNode(est));
      v.appendChild(lead);
      if (S.erro) { var fe = el('div', 'mv-faixa ama'); fe.setAttribute('role', 'status'); fe.appendChild(ic('alerta')); fe.appendChild(el('span', 'mv-faixa-t', S.erro)); v.appendChild(fe); }
      desenharBarraLista();
      if (!x) { v.appendChild(el('p', 'mv-nada', S.lendo || (K.online() && K.A.sessaoValida()) ? 'A ler os pedidos de material desta obra…' : 'Ainda não tenho os pedidos de material desta obra neste telemóvel: aparecem quando houver rede.')); return; }
      var lst = pedidos(), s = P.contas(lst, hoje());
      var sec = el('section', 'mv-sec pri mv-tf-segm'), seg = el('div', 'mv-segm'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Estado');
      [['abertos', 'Abertos', s.abertos], ['fechados', 'Fechados', s.fechados]].forEach(function (f) {
        var b = bt('', f[1] + (f[2] ? ' · ' + f[2] : '')); b.setAttribute('aria-pressed', String(S.filtro === f[0])); b.setAttribute('data-k', 'f-' + f[0]);
        b.addEventListener('click', function () { S.filtro = f[0]; desenharLista(); }); seg.appendChild(b);
      });
      sec.appendChild(seg); v.appendChild(sec);
      var fl = P.filtrar(lst, S.filtro, hoje());
      if (!fl.length) v.appendChild(el('p', 'mv-nada', S.filtro === 'fechados' ? 'Nenhum pedido fechado nos últimos 30 dias.' : 'Sem pedidos de material por receber nesta obra.'));
      fl.forEach(function (p) { v.appendChild(caixaPedido(p)); });
      if (x.data.cortado) v.appendChild(el('p', 'mv-folha-txt', 'A mostrar ' + (x.data.pedidos || []).length + ' de ' + x.data.total + '. Os outros vêem-se no computador.'));
      if (k) { var y = v.querySelector('[data-k="' + k + '"]'); if (y) K.A.focar(y); }
    }
    function caixaPedido(p) {
      var x = lista(p.obraId), c = P.cabecalho(p, hoje(), x && x.data.paraQuem);
      var b = bt('pm-ped'); b.setAttribute('data-k', 'p-' + p.id); b.setAttribute('data-pm', p.id);
      var h = el('span', 'pm-ped-h'); h.appendChild(el('b', null, c.t)); h.appendChild(el('span', null, p.comErro ? 'não entrou' : (p.porEnviar ? 'por enviar' : c.ate))); b.appendChild(h);
      (p.linhas || []).forEach(function (l) { b.appendChild(linhaLista(p, l)); });
      b.setAttribute('aria-label', c.t + '. ' + (p.linhas || []).map(function (l) { var w = P.palavra(l, p, hoje()); return l.texto + ', ' + P.qtdUn(l) + ': ' + w.p; }).join('; ') + '. Abrir o pedido');
      b.addEventListener('click', function () { abrirPedido(p.id); });
      return b;
    }
    function linhaLista(p, l) {
      var w = P.palavra(l, p, hoje()), d = el('span', 'pm-l' + (l.estado === 'ANULADO' || l.estado === 'RECUSADO' ? ' apagada' : ''));
      var n = el('span', 'pm-l-n', l.texto); n.appendChild(el('span', null, ' · ' + P.qtdUn(l))); d.appendChild(n);
      d.appendChild(el('span', 'pm-l-e ' + w.c, w.p));
      var s = el('span', 'pm-l-s'); if (w.passo >= 0) s.appendChild(regua(w)); s.appendChild(el('span', null, w.f)); d.appendChild(s);
      return d;
    }
    function desenharBarraLista() {
      var box = $('barra-pm-l'); if (!box) return;
      limpar(box);
      var x = lista(S.obra);
      if (x && x.data.podePedir === false) return;
      var b = bt('mv-btn pri'); b.id = 'b-pm-pedir'; b.appendChild(ic('mais')); b.appendChild(document.createTextNode('Pedir material'));
      b.addEventListener('click', function () { abrirForm(S.obra, {}); }); box.appendChild(b);
      K.A.medirBarra();
    }

    // ── O pedido aberto (a folha) ──
    function abrirPedido(id, ob) {
      if (ob && ob !== S.obra) { S.obra = ob; if (!lista(ob)) lerLista(ob); }
      var p = pedidoDe(id); if (!p) { if (ob) lerLista(ob).then(function () { if (pedidoDe(id)) abrirPedido(id); }); return; }
      S.sel = id; S.prob = null;
      var d = K.folha({ alta: true, titulo: tituloFolha(p), sub: subFolha(p), corpo: function (cc) { corpoPedido(cc, p); }, pe: function (pe) { pePedido(pe, p); } });
      if (d) d.setAttribute('data-dono', 'pm:' + id);
    }
    function tituloFolha(p) { var o = K.obraDe(p.obraId); return ((o && o.codigo) ? o.codigo + ' · ' : '') + 'pedido de ' + (p.dia === hoje() ? 'hoje' + (p.criadoEm ? ', ' + D.horaDe(p.criadoEm) : '') : D.textoDiaCurto(p.dia || hoje())); }
    function subFolha(p) {
      var partes = [];
      if (p.autor && p.autor.nome) partes.push(p.autor.eu ? 'Pediste tu' : 'De ' + p.autor.nome + (p.autor.soTelemovel ? ' (encarregado)' : ''));
      if (p.precisoAte) partes.push('preciso até ' + D.textoDiaCurto(p.precisoAte));
      var s = P.contas([p], hoje()); if (s.porReceber) partes.push(s.porReceber + ' por receber');
      return partes.join(' · ');
    }
    function redesenharFolha() {
      var d = $('folha-casca'); if (!d || !d.open || d.getAttribute('data-dono') !== 'pm:' + S.sel) return;
      var p = pedidoDe(S.sel), c = $('fx-c'), pe = $('fx-p'); if (!p || !c || !pe) return;
      $('fx-t').textContent = tituloFolha(p); var s = $('fx-s'); if (s) { s.textContent = subFolha(p); s.hidden = !s.textContent; }
      limpar(c); corpoPedido(c, p); limpar(pe); pePedido(pe, p);
    }
    function botao(cls, txt, fn, nomeIc) { var b = bt('mv-btn' + (cls ? ' ' + cls : '')); if (nomeIc) b.appendChild(ic(nomeIc)); b.appendChild(document.createTextNode(txt)); b.addEventListener('click', fn); return b; }
    function link(txt, nomeIc, fn) { var b = bt('mv-link'); if (nomeIc) b.appendChild(ic(nomeIc)); b.appendChild(document.createTextNode(txt)); b.addEventListener('click', fn); return b; }
    function corpoPedido(cc, p) {
      if (p.comErro) { var fe = el('p', 'mv-erro'); fe.setAttribute('role', 'alert'); fe.appendChild(ic('alerta')); fe.appendChild(el('span', null, p.comErro)); cc.appendChild(fe); }
      (p.linhas || []).forEach(function (l) { cc.appendChild(linhaFolha(p, l)); });
      if (p.nota) cc.appendChild(el('p', 'pm-nota', 'Nota: ' + p.nota));
      if (!p.porEnviar && pode(p, 'anular')) { var an = link('Anular o pedido', 'lixo', function () { var te = K.tf(); if (!te) return; te.folhaConfirmar({ titulo: 'Anular este pedido?', sub: P.cabecalho(p, hoje()).t, texto: 'Os materiais ainda por decidir saem do pedido. Podes repô-los durante 7 dias.', botao: 'Anular o pedido', fazer: function () { comando(p, 'anular', {}, 'Pedido anulado'); } }); }); an.id = 'b-pm-anular'; an.classList.add('mv-link-anular'); cc.appendChild(an); }
      var hs = (p.historico || []).slice().reverse();
      if (hs.length) {
        cc.appendChild(el('p', 'mv-lh', 'Histórico'));
        var ul = el('ul', 'mv-hist'), porN = {}; (p.linhas || []).forEach(function (l) { porN[l.n] = l.texto; });
        hs.forEach(function (x) { var li = el('li'); li.appendChild(el('b', null, P.nomeAccao(x.accao) + (x.n && porN[x.n] ? ' · ' + porN[x.n] : '') + (x.nome ? ' · ' + x.nome : '') + (x.motivo ? ' («' + x.motivo + '»)' : ''))); li.appendChild(el('small', null, T.diaDe(x.em) === hoje() ? 'hoje' + (x.em ? ', ' + D.horaDe(x.em) : '') : D.textoDiaMes(T.diaDe(x.em) || hoje()))); ul.appendChild(li); });
        cc.appendChild(ul);
      }
    }
    function linhaFolha(p, l) {
      var w = P.palavra(l, p, hoje()), d = el('div', 'pm-l' + (l.estado === 'ANULADO' || l.estado === 'RECUSADO' || l.estado === 'CANCELADO' ? ' apagada' : '')); d.setAttribute('data-n', String(l.n));
      var n = el('span', 'pm-l-n', l.texto); n.appendChild(el('span', null, ' · ' + P.qtdUn(l))); d.appendChild(n);
      var dec = !p.porEnviar && (pode(l, 'aceitar') || pode(l, 'recusar'));
      if (dec) {   // decidir: ✕ recusa (com motivo), ✓ aceita
        var rd = el('span', 'pm-rds');
        if (pode(l, 'recusar')) { var no = bt('pm-rd nao'); no.appendChild(ic('x')); no.setAttribute('aria-label', 'Recusar ' + l.texto); no.setAttribute('data-k', 'rec-' + l.n); no.addEventListener('click', function () { folhaMotivo(p, l, 'recusar'); }); rd.appendChild(no); }
        if (pode(l, 'aceitar')) { var si = bt('pm-rd sim'); si.appendChild(ic('ok')); si.setAttribute('aria-label', 'Aceitar ' + l.texto); si.setAttribute('data-k', 'ace-' + l.n); si.addEventListener('click', function () { K.fecharFolha(); comando(p, 'aceitar', { linhas: [l.n] }, 'Aceite · ' + l.texto); }); rd.appendChild(si); }
        d.appendChild(rd);
      } else d.appendChild(el('span', 'pm-l-e ' + w.c, w.p));
      var s = el('span', 'pm-l-s'); if (w.passo >= 0) s.appendChild(regua(w)); s.appendChild(el('span', null, w.f));
      d.appendChild(s);
      if (p.porEnviar) return d;
      var acc = el('div', 'pm-acc');
      if (pode(l, 'recebi')) { var rb = botao('peq', 'Recebi', function () { K.fecharFolha(); comando(p, 'recebi', { linhas: [l.n] }, 'Recebido · ' + l.texto); }, 'ok'); rb.setAttribute('data-k', 'recebi-' + l.n); acc.appendChild(rb); }
      if (pode(l, 'problema')) { var pb = botao('peq ghost', 'Há um problema', function () { S.prob = S.prob && S.prob.n === l.n ? null : { n: l.n, tipo: (l.problema && l.problema.tipo) || '', nota: (l.problema && l.problema.nota) || '' }; redesenharFolha();
        // revisão (8): a 320 px ou com o texto grande a caixa abre abaixo da dobra; traz-se à vista (o Guardar incluído)
        var cx = document.querySelector('#fx-c .pm-prob'); pmTrazerAVista(cx, $('fx-c'));
        // 2.ª revisão (8): o foco vai para o campo da nota (o teclado abre já onde se escreve); as frases ficam por cima, à vista
        var cn = document.getElementById('c-pm-prob'); if (cx && cn && typeof cn.focus === 'function') cn.focus({ preventScroll: true }); }); pb.setAttribute('data-k', 'prob-' + l.n); pb.setAttribute('aria-expanded', String(!!(S.prob && S.prob.n === l.n))); acc.appendChild(pb); }
      if (pode(l, 'linha-editar')) { var ce = link('Corrigir', 'lapis', function () { folhaCorrigir(p, l); }); ce.setAttribute('data-k', 'corr-' + l.n); acc.appendChild(ce); }
      if (pode(l, 'linha-tirar')) { var ti = link('Tirar', 'lixo', function () { K.fecharFolha(); comando(p, 'linha-tirar', { n: l.n }, 'Tirado · ' + l.texto); }); ti.setAttribute('data-k', 'tirar-' + l.n); acc.appendChild(ti); }
      if (pode(l, 'linha-repor')) acc.appendChild(link('Repor', 'atual', function () { K.fecharFolha(); comando(p, 'linha-repor', { n: l.n }, 'Reposto · ' + l.texto); }));
      if (pode(l, 'cancelar')) { var cn = link('Cancelar · não vem', 'x', function () { folhaMotivo(p, l, 'cancelar'); }); cn.setAttribute('data-k', 'canc-' + l.n); acc.appendChild(cn); }
      if (pode(l, 'reabrir')) { var ra = l.estado === 'CANCELADO'; var rl = link(ra ? 'Reabrir (volta a Aceite)' : 'Reabrir a decisão', 'atual', function () { K.fecharFolha(); comando(p, 'reabrir', { n: l.n }, (ra ? 'Reaberto · ' : 'Decisão reaberta · ') + l.texto); }); rl.setAttribute('data-k', 'reab-' + l.n); acc.appendChild(rl); }
      if (pode(l, 'desfazer-rececao')) acc.appendChild(link('Desfazer a receção', 'atual', function () { K.fecharFolha(); comando(p, 'desfazer-rececao', { n: l.n }, 'Receção desfeita · ' + l.texto); }));
      if (acc.firstChild) d.appendChild(acc);
      if (S.prob && S.prob.n === l.n) d.appendChild(caixaProblema(p, l));
      return d;
    }
    /** Traz a caixa à vista rolando SÓ o corpo da folha (#fx-c): o scrollIntoView rolava também a folha (overflow:hidden) e
        deixava-a cortada a meio no Edge (2.ª revisão, 8; visto em captura). O fundo da caixa fica à vista; se não couber, o topo. */
    function pmTrazerAVista(cx, fc) {
      if (!cx || !fc || typeof cx.getBoundingClientRect !== 'function') return;
      var rb = cx.getBoundingClientRect(), rc = fc.getBoundingClientRect();
      if (rb.bottom > rc.bottom) fc.scrollTop += Math.min(rb.bottom - rc.bottom, Math.max(0, rb.top - rc.top));
    }
    /** «Há um problema»: Chegou menos · Veio danificado · Veio errado + o que aconteceu (opcional). A linha fica por receber. */
    function caixaProblema(p, l) {
      var x = el('div', 'pm-prob'), ch = el('div', 'mv-chips'); ch.setAttribute('role', 'group'); ch.setAttribute('aria-label', 'O problema');
      P.PROBLEMAS.forEach(function (pr) {
        var b = bt('mv-chip', pr[1]); b.setAttribute('aria-pressed', String(S.prob.tipo === pr[0])); b.setAttribute('data-k', 'pt-' + pr[0]);
        b.addEventListener('click', function () { S.prob.tipo = pr[0]; Array.prototype.forEach.call(ch.children, function (y) { y.setAttribute('aria-pressed', String(y === b)); }); var g = $('b-pm-prob'); if (g) g.setAttribute('aria-disabled', 'false'); });
        ch.appendChild(b);
      });
      x.appendChild(ch);
      var inp = el('input', 'mv-in'); inp.type = 'text'; inp.id = 'c-pm-prob'; inp.maxLength = P.LIMITES.nota; inp.placeholder = 'Ex.: vieram 16 m'; inp.value = S.prob.nota || ''; inp.setAttribute('aria-label', 'O que aconteceu (opcional)');
      inp.addEventListener('input', function () { S.prob.nota = inp.value; });
      x.appendChild(inp);
      x.appendChild(el('p', null, 'A linha fica por receber, com esta nota. A GP e o Aprovisionamento vêem-na.'));
      // o «Guardar» vive no pé da folha (pePedido), sempre à vista acima do teclado (2.ª revisão, 8)
      return x;
    }
    function guardarProblema(p, l) {
      if (!S.prob || !S.prob.tipo) { K.toast('Escolhe o que aconteceu.', { ms: 2500 }); return; }
      var c = { n: l.n, tipo: S.prob.tipo }, nt = String(S.prob.nota || '').trim(); if (nt) c.nota = nt;
      var pg = P.avisoPerigoso('A nota', nt); if (pg) { K.toast(pg, { ms: 4000 }); return; }   // antes da fila (revisão, 14)
      S.prob = null; K.fecharFolha(); comando(p, 'problema', c, P.nomeProblema(c.tipo) + ' · ' + l.texto);
    }
    function pePedido(pe, p) {
      // a escrever um problema (2.ª revisão, 8): o pé fica só com uma frase curta, para a caixa caber acima do teclado
      if (!p.porEnviar && S.prob) {
        var lp = (p.linhas || []).filter(function (x) { return x.n === S.prob.n; })[0];
        if (lp) {
          var g = botao('pri', 'Guardar o problema', function () { guardarProblema(p, lp); }, 'ok'); g.id = 'b-pm-prob'; g.setAttribute('aria-disabled', S.prob.tipo ? 'false' : 'true'); pe.appendChild(g);
          var fe = link('Cancelar', null, function () { S.prob = null; redesenharFolha(); }); fe.id = 'b-pm-prob-fechar'; pe.appendChild(fe);
          return;
        }
      }
      if (p.porEnviar) { pe.appendChild(el('p', 'mv-folha-txt mv-folha-txt-0', K.online() ? 'A enviar: as acções voltam quando o servidor responder.' : 'Por enviar: segue quando houver rede. As acções voltam depois.')); return; }
      var ac = (p.linhas || []).filter(function (l) { return pode(l, 'aceitar'); }), rc = (p.linhas || []).filter(function (l) { return pode(l, 'recebi') && !l.problema; });
      if (ac.length) { var a = botao('pri', ac.length > 1 ? 'Aceitar tudo (' + ac.length + ')' : 'Aceitar ' + ac[0].texto, function () { K.fecharFolha(); comando(p, 'aceitar', { linhas: ac.map(function (l) { return l.n; }) }, ac.length > 1 ? pl(ac.length, 'material aceite', 'materiais aceites') : 'Aceite · ' + ac[0].texto); }, 'ok'); a.id = 'b-pm-aceitar'; pe.appendChild(a); }
      else if (rc.length) { var r = botao('pri', 'Recebi tudo o que chegou (' + rc.length + ')', function () { K.fecharFolha(); comando(p, 'recebi', { linhas: rc.map(function (l) { return l.n; }) }, pl(rc.length, 'material recebido', 'materiais recebidos')); }, 'ok'); r.id = 'b-pm-recebi'; pe.appendChild(r); }
      var txt = ac.length ? '✕ numa linha pede o motivo. O DO vê o pedido, mas não decide.'
        : (rc.length ? 'Desfazer durante 5 s; depois, no próprio pedido.' : ((p.linhas || []).some(function (l) { return l.estado === 'ACEITE'; }) ? '«A caminho» e a data marca-os o Aprovisionamento ou a GP, no computador.' : (P.aberto(p) ? 'À espera da decisão da GP.' : 'Fechado.')));
      pe.appendChild(el('small', 'mv-folha-txt mv-folha-txt-0', txt));
    }
    /** Recusar (uma linha pedida) ou cancelar (uma aceite ou a caminho que não vem; revisão de 24 nov): o motivo em frases de um
        toque (o do protótipo) e, opcional, mais alguma coisa. O motivo é obrigatório nos dois. */
    function folhaMotivo(p, l, accao) {
      var canc = accao === 'cancelar', esc = { m: '', extra: '' };
      var pe = function (box) {
        var b = botao('neg', canc ? 'Cancelar a linha' : 'Recusar', function () {
          var outro = esc.m === 'Outro…', m = (outro ? String(esc.extra || '').trim() : esc.m + (String(esc.extra || '').trim() ? '. ' + String(esc.extra).trim() : '')).slice(0, P.LIMITES.motivo);
          if (!m) { K.toast(outro ? 'Escreve o motivo.' : 'Escolhe o motivo.', { ms: 2500 }); return; }
          var pg = P.avisoPerigoso('O motivo', m); if (pg) { K.toast(pg, { ms: 4000 }); return; }   // antes da fila (revisão, 14)
          K.fecharFolha(); comando(p, accao, { linhas: [l.n], motivo: m }, (canc ? 'Cancelado · ' : 'Recusado · ') + l.texto);
        }); b.id = canc ? 'b-pm-cancelar' : 'b-pm-recusar';
        var c = botao('ghost', canc ? 'Voltar' : 'Cancelar', function () { K.fecharFolha(); });
        var w = el('div', 'mv-btns'); w.appendChild(b); w.appendChild(c); box.appendChild(w);
      };
      var quem = p.autor && !p.autor.eu ? P.primeiro(p.autor.nome) + ' vê o motivo no pedido dele.' : 'Quem pediu vê o motivo no pedido.';
      K.folha({ titulo: (canc ? 'Cancelar «' : 'Recusar «') + l.texto + ' · ' + P.qtdUn(l) + '»?', sub: canc ? 'Para o que não vem. ' + quem + ' Reabre-se depois, se vier.' : quem, corpo: function (cc) {
        cc.appendChild(el('p', 'mv-lh', 'Porquê'));
        var ch = el('div', 'mv-chips'); ch.setAttribute('role', 'group'); ch.setAttribute('aria-label', 'O motivo');
        (canc ? P.MOTIVOS_CANCELA : P.MOTIVOS_RECUSA).concat(['Outro…']).forEach(function (m, i) { var b = bt('mv-chip', m); b.setAttribute('aria-pressed', 'false'); b.setAttribute('data-k', 'mot-' + i); b.addEventListener('click', function () { esc.m = m; Array.prototype.forEach.call(ch.children, function (y) { y.setAttribute('aria-pressed', String(y === b)); }); }); ch.appendChild(b); });
        cc.appendChild(ch);
        cc.appendChild(el('p', 'mv-lh', 'Mais alguma coisa? · Opcional'));
        var inp = el('input', 'mv-in'); inp.type = 'text'; inp.id = 'c-pm-motivo'; inp.maxLength = P.LIMITES.motivo; inp.placeholder = 'Ex.: pede ao Rui, no contentor';
        inp.addEventListener('input', function () { esc.extra = inp.value; }); cc.appendChild(inp);
      }, pe: pe });
    }
    /** Corrigir uma linha ainda pedida: o material, a quantidade e a unidade (só o que mudou segue). */
    function folhaCorrigir(p, l) {
      var e = { texto: l.texto, qtd: P.textoQtd(l.quantidade), unidade: l.unidade };
      K.folha({ titulo: 'Corrigir o material', sub: P.cabecalho(p, hoje()).t, corpo: function (cc) {
        var t = el('input', 'mv-in'); t.type = 'text'; t.id = 'c-pm-corr-t'; t.value = e.texto; t.maxLength = P.LIMITES.texto; t.setAttribute('aria-label', 'O material'); t.addEventListener('input', function () { e.texto = t.value; }); cc.appendChild(t);
        var q = el('input', 'mv-in pm-qin'); q.type = 'text'; q.inputMode = 'decimal'; q.id = 'c-pm-corr-q'; q.value = e.qtd; q.setAttribute('aria-label', 'A quantidade'); q.addEventListener('input', function () { e.qtd = q.value; }); cc.appendChild(q);
        cc.appendChild(chipsUnidade(e.unidade, function (u) { e.unidade = u; }));
      }, pe: function (box) {
        var b = botao('pri', 'Guardar', function () {
          var c = { n: l.n }, txt = String(e.texto || '').trim().replace(/\s+/g, ' '), qn = P.lerQtd(e.qtd);
          if (!txt) { K.toast('Escreve o material.', { ms: 2500 }); return; }
          if (qn === null) { K.toast('A quantidade não é um número.', { ms: 2500 }); return; }
          var pg = P.avisoPerigoso('O material', txt); if (pg) { K.toast(pg, { ms: 4000 }); return; }   // antes da fila (revisão, 14)
          if (txt !== l.texto) c.texto = txt; if (qn !== Number(l.quantidade)) c.quantidade = qn; if (e.unidade !== l.unidade) c.unidade = e.unidade;
          K.fecharFolha(); if (Object.keys(c).length === 1) return;
          comando(p, 'linha-editar', c, 'Corrigido · ' + txt);
        }); b.id = 'b-pm-corr'; box.appendChild(b);
      } });
    }
    function chipsUnidade(atual, aoEscolher) {
      var ch = el('div', 'mv-chips'); ch.setAttribute('role', 'group'); ch.setAttribute('aria-label', 'A unidade');
      P.UNIDADES.forEach(function (u) { var b = bt('mv-chip', P.unidade(u)); b.setAttribute('aria-pressed', String(u === atual)); b.setAttribute('data-k', 'un-' + u); b.addEventListener('click', function () { aoEscolher(u); Array.prototype.forEach.call(ch.children, function (y) { y.setAttribute('aria-pressed', String(y === b)); }); }); ch.appendChild(b); });
      return ch;
    }

    // ── Os comandos: um item na fila da conta; com Desfazer, só segue depois de o aviso acabar ──
    function base(p) { var x = lista(p.obraId); return x ? (x.data.pedidos || []).filter(function (y) { return y.id === p.id; })[0] || p : p; }
    function itemDe(p, accao, campos, o) { var s = K.sessao(); return P.itemComando(Object.assign({ accao: accao, pm: base(p), campos: campos, contaId: K.contaId(), contaNome: s && s.nome, novoId: K.novoId }, o || {})); }
    async function porNaFila(item) { K.porNaFila(item); await K.guardarItem(item); }
    function tirarDaFila(item) { K.tirarDaFila(item); K.apagarItem(item.id); }
    function comando(p, accao, campos, texto) {
      var it = itemDe(p, accao, campos, { adiarMs: ADIAR });
      porNaFila(it); redesenharLista(); K.redesenharHoje();
      K.toast(texto + (K.online() ? '' : ' · segue quando houver rede'), { ms: ADIAR,
        desfazer: function () { tirarDaFila(it); redesenharLista(); K.redesenharHoje(); },
        aoFim: function () { if (K.fila().indexOf(it) < 0) return; it.adiadoAte = ''; K.guardarItem(it); K.soltarConflitos([it]); K.drenar(false); } });
    }

    // ── O formulário (v-pm-form) ──
    function abrirForm(ob, o) {
      o = o || {};
      if (!ob) { K.toast('Ainda não estás em nenhuma obra. Fala com o GP ou com o Diretor de Obra.'); return; }
      S.form = P.formNovo({ obraId: ob }); S.form.uid = K.novoId(); S.form.conta = K.contaId();
      if (!lista(ob) || K.online()) lerLista(ob);   // para quem vai e os «Pedidos antes nesta obra»
      K.abrir('v-pm-form', !!o.substituir, !!o.daFolha);
    }
    function desenharForm() {
      var v = $('v-pm-form'); if (!v || !S.form) return;
      var ae = document.activeElement, k = ae && v.contains(ae) ? ae.getAttribute('data-k') : null, pos = ae && typeof ae.selectionStart === 'number' ? ae.selectionStart : null;
      limpar(v);
      var f = S.form, o = K.obraDe(f.obraId), x = lista(f.obraId);
      // a obra (Mudar abre a lista das minhas obras)
      var so = el('section', 'mv-sec pri'), bo = bt('mv-obra' + (o ? '' : ' vazia')); bo.id = 'c-obra-pm'; bo.setAttribute('data-k', 'obra');
      var oi = el('span', 'mv-obra-ic'); oi.appendChild(ic('obra')); bo.appendChild(oi);
      var tt = el('span', 'mv-obra-t'); if (o) { var oc = el('span', 'mv-obra-cod'); if (o.codigo) oc.appendChild(el('code', null, o.codigo)); tt.appendChild(oc); tt.appendChild(el('span', 'mv-obra-n', o.nome)); } else tt.appendChild(el('span', 'mv-obra-n', 'Escolher a obra'));
      bo.appendChild(tt); var oa = el('span', 'mv-obra-acc', K.obras().length > 1 ? 'Mudar' : ''); bo.appendChild(oa);
      if (K.obras().length > 1) bo.addEventListener('click', folhaObraForm); else bo.disabled = true;
      so.appendChild(bo); v.appendChild(so);
      // o que precisas
      var cheias = f.linhas.filter(function (l) { return String(l.texto || '').trim(); }).length;
      var sm = K.seccao('O que precisas', pl(Math.max(cheias, 1), 'material', 'materiais'), 'h-pm-mat');
      f.linhas.forEach(function (l, i) {
        var bx = el('div', 'pm-lin'); bx.setAttribute('data-i', String(i));
        var t = el('input', 'mv-in' + (f.tentou && i === 0 && !cheias ? ' tentou' : '')); t.type = 'text'; t.id = 'c-pm-t-' + i; t.setAttribute('data-k', 't-' + i); t.value = l.texto; t.maxLength = P.LIMITES.texto; t.placeholder = 'Ex.: silicone estrutural preto'; t.setAttribute('aria-label', 'Material ' + (i + 1)); t.setAttribute('autocapitalize', 'sentences');
        t.addEventListener('input', function () { l.texto = t.value; t.classList.remove('tentou'); desenharBarraForm(); });
        bx.appendChild(t);
        var qd = el('div', 'pm-qtd'), st = el('span', 'pm-step');
        var menos = bt('pm-st'); menos.appendChild(ic('menos')); menos.setAttribute('aria-label', 'Menos'); menos.setAttribute('data-k', 'm-' + i);
        var q = el('input', 'pm-qin'); q.type = 'text'; q.inputMode = 'decimal'; q.id = 'c-pm-q-' + i; q.setAttribute('data-k', 'q-' + i); q.value = l.qtd; q.setAttribute('aria-label', 'Quantidade de ' + (l.texto || 'material ' + (i + 1)));
        var mais = bt('pm-st'); mais.appendChild(ic('mais')); mais.setAttribute('aria-label', 'Mais'); mais.setAttribute('data-k', 'p-' + i);
        menos.addEventListener('click', function () { l.qtd = P.passoQtd(l.qtd, -1); q.value = l.qtd; desenharBarraForm(); });
        mais.addEventListener('click', function () { l.qtd = P.passoQtd(l.qtd, 1); q.value = l.qtd; desenharBarraForm(); });
        q.addEventListener('input', function () { l.qtd = q.value; desenharBarraForm(); });
        st.appendChild(menos); st.appendChild(q); st.appendChild(mais); qd.appendChild(st);
        var un = bt('mv-chip pm-un', P.unidade(l.unidade) + ' ▾'); un.setAttribute('aria-pressed', 'true'); un.setAttribute('data-k', 'u-' + i); un.setAttribute('aria-label', 'Unidade: ' + P.unidade(l.unidade) + '. Mudar');
        un.addEventListener('click', function () { K.folha({ titulo: 'Unidade', sub: l.texto || 'Material ' + (i + 1), corpo: function (cc) { cc.appendChild(chipsUnidade(l.unidade, function (u) { l.unidade = u; K.fecharFolha(); desenharForm(); })); } }); });
        qd.appendChild(un);
        if (f.linhas.length > 1) { var xb = bt('mv-link pm-tira'); xb.appendChild(ic('x')); xb.setAttribute('aria-label', 'Tirar o material ' + (i + 1)); xb.setAttribute('data-k', 'x-' + i); xb.addEventListener('click', function () { f.linhas.splice(i, 1); desenharForm(); }); qd.appendChild(xb); }
        else qd.appendChild(el('small', null, 'ou escreve o número'));
        bx.appendChild(qd); sm.appendChild(bx);
      });
      if (f.linhas.length < P.LIMITES.linhas) { var ac = link('Acrescentar material', 'mais', function () { var u = f.linhas[f.linhas.length - 1]; f.linhas.push(P.linhaNova(u && u.unidade)); desenharForm(); var y = $('c-pm-t-' + (f.linhas.length - 1)); if (y) y.focus(); }); ac.id = 'b-pm-mais'; sm.appendChild(ac); }
      var sug = P.sugestoes(x && x.data.sugestoes, f);
      if (sug.length) {
        sm.appendChild(el('p', 'mv-lh', 'Pedidos antes na ' + ((o && o.codigo) || 'obra')));
        var sc = el('div', 'mv-chips pm-fila'); sc.setAttribute('role', 'group'); sc.setAttribute('aria-label', 'Pedidos antes nesta obra');
        sug.forEach(function (s, i) { var b = bt('mv-chip sug', '+ ' + s.texto); b.setAttribute('data-k', 'sug-' + i); b.addEventListener('click', function () { P.juntarSugestao(f, s); desenharForm(); }); sc.appendChild(b); });
        sm.appendChild(sc);
      }
      v.appendChild(sm);
      // preciso até
      var ops = P.opcoesPreciso(hoje()), sp = K.seccao('Preciso até', f.precisoAte ? D.textoDiaCurto(f.precisoAte) : 'Opcional', 'h-pm-ate'), pc = el('div', 'mv-chips pm-fila'); pc.setAttribute('role', 'group'); pc.setAttribute('aria-label', 'Preciso até');
      ops.forEach(function (op) {
        var b = bt('mv-chip', op[1]); b.setAttribute('aria-pressed', String(f.precisoOp === op[0])); b.setAttribute('data-k', 'ate-' + op[0]);
        b.addEventListener('click', function () { if (f.precisoOp === op[0]) { f.precisoOp = ''; f.precisoAte = null; } else { f.precisoOp = op[0]; f.precisoAte = op[2] || (f.precisoOp === 'escolher' ? f.precisoAte : null); } desenharForm(); });
        pc.appendChild(b);
      });
      sp.appendChild(pc);
      if (f.precisoOp === 'escolher') { var di = el('input', 'mv-in'); di.type = 'date'; di.id = 'c-pm-ate'; di.setAttribute('data-k', 'ate-dia'); di.min = hoje(); di.value = f.precisoAte || ''; di.setAttribute('aria-label', 'O dia'); di.addEventListener('change', function () { f.precisoAte = T.RE_DIA.test(di.value) ? di.value : null; desenharForm(); }); sp.appendChild(di); }
      v.appendChild(sp);
      // a nota
      var sn = el('section', 'mv-sec'), hn = el('div', 'mv-sec-h'), ln = el('label', 'mv-h2', 'Nota'); ln.htmlFor = 'c-pm-nota'; hn.appendChild(ln); hn.appendChild(el('span', 'mv-sec-m', 'Opcional')); sn.appendChild(hn);
      var ta = el('textarea', 'mv-campo curto'); ta.id = 'c-pm-nota'; ta.setAttribute('data-k', 'nota'); ta.value = f.nota; ta.maxLength = P.LIMITES.nota; ta.placeholder = 'Para quê, onde descarregar'; ta.addEventListener('input', function () { f.nota = ta.value; desenharBarraForm(); });
      sn.appendChild(ta); v.appendChild(sn);
      if (k) { var y = v.querySelector('[data-k="' + k + '"]'); if (y) { K.A.focar(y); if (pos != null && typeof y.setSelectionRange === 'function') try { y.setSelectionRange(pos, pos); } catch (e) { /* nada */ } } }
      desenharBarraForm();
    }
    function folhaObraForm() {
      var f = S.form;
      K.folha({ titulo: 'Escolher a obra', alta: K.obras().length > 6, corpo: function (cc) {
        K.obras().forEach(function (o) {
          var b = bt('mv-lo'); b.setAttribute('aria-pressed', String(o.id === f.obraId)); junta(b, el('code', null, o.codigo || ''), el('span', 'mv-lo-n', o.nome), ic('ok'));
          b.addEventListener('click', function () { K.fecharFolha(); if (o.id === f.obraId) return; f.obraId = o.id; if (!lista(o.id)) lerLista(o.id); desenharForm(); });
          cc.appendChild(b);
        });
      } });
    }
    function desenharBarraForm() {
      var box = $('barra-pm'); if (!box || !S.form) return;
      limpar(box);
      var f = S.form, x = lista(f.obraId), o = K.obraDe(f.obraId), fl = P.faltaForm(f, !!o), nota = el('p', 'mv-barra-nota'), pq = x ? x.data.paraQuem : undefined;
      if (K.semArmazem()) { nota.appendChild(ic('alerta')); nota.appendChild(el('span', null, 'Neste telemóvel não consigo guardar: não feches esta página')); nota.classList.add('falta'); }
      else if (fl && f.tentou) { nota.appendChild(ic('alerta')); nota.appendChild(el('span', null, fl.texto)); nota.classList.add('falta', 'tentou'); }
      else if (!K.online()) { nota.appendChild(ic('semrede')); nota.appendChild(el('span', null, 'Sem rede: fica guardado e segue sozinho')); }
      else if (pq !== undefined) nota.appendChild(el('span', null, P.textoParaQuem(pq, o && o.codigo)));
      if (nota.firstChild) box.appendChild(nota);
      var n = f.linhas.filter(function (l) { return String(l.texto || '').trim(); }).length;
      var b = bt('mv-btn pri', fl ? fl.texto : 'Pedir ' + pl(n, 'material', 'materiais') + (pq && pq.nome ? ' a ' + P.primeiro(pq.nome) : '')); b.id = 'b-pm';
      b.setAttribute('aria-disabled', fl ? 'true' : 'false'); b.addEventListener('click', pedir); box.appendChild(b);
      K.A.medirBarra();
    }
    var aPedir = false;
    async function pedir() {
      var f = S.form; if (!f || aPedir) return;
      var fl = P.faltaForm(f, !!K.obraDe(f.obraId));
      if (fl) { f.tentou = true; desenharBarraForm(); if (fl.campo === 'obra') folhaObraForm(); else { var y = $(fl.campo === 'qtd' ? 'c-pm-q-' + (fl.i || 0) : (fl.campo === 'texto' ? 'c-pm-t-' + (fl.i || 0) : 'c-pm-ate')); if (y) y.focus(); } return; }
      aPedir = true;
      try {
        var s = K.sessao(), c = P.camposCriar(f);
        var item = P.itemComando({ accao: 'criar', pm: { id: P.novoIdPm(K.novoId), obraId: f.obraId }, obraId: f.obraId, campos: c, contaId: K.contaId(), contaNome: s && s.nome, novoId: K.novoId, resumo: c.linhas[0].texto });
        await porNaFila(item);
        var ob = f.obraId; S.form = null;
        if (!K.A.sessaoValida()) { K.A.pedirLogin('Guardado no telemóvel · entra outra vez para seguir.'); }
        abrirLista(ob, true);
        K.toast((c.linhas.length > 1 ? pl(c.linhas.length, 'material pedido', 'materiais pedidos') : 'Pedido · ' + c.linhas[0].texto) + (K.online() ? '' : ' · segue quando houver rede'), { ms: 3500 });
        K.drenar(true);
      } finally { aPedir = false; }
    }

    // ── O envio (chamado pelo drenar da casca, item a item) ──
    function processar(q) { return P.processarPm(q, deps()); }
    async function aoResultado(q, res) {
      if (res.estado === 'entregue' && q.registo) {
        P.porRegisto(K.cache(), q.registo); K.gravarCache(); K.marcarReler();
        if (q.avisos && q.avisos.length) K.toast(q.avisos[0], { ms: 5000 });
      }
      if (res.estado === 'conflito') {   // o pedido relê-se; diz-se o que mudou e quem (o comando fica na fila, parado)
        await lerLista(q.obraId);
        var reg = (lista(q.obraId) ? (lista(q.obraId).data.pedidos || []) : []).filter(function (p) { return p.id === q.registoId; })[0];
        q.erro = P.textoConflito(reg); K.guardarItem(q);
        K.toast((q.resumo ? q.resumo + ': ' : '') + q.erro, { ms: 6000 });
      }
      redesenharLista(); redesenharFolha(); K.redesenharHoje();
    }
    function linhaFila(q, emCurso) {
      var o = K.obraDe(q.obraId), parado = q.estado === 'parado', adiado = q.adiadoAte && q.adiadoAte > new Date().toISOString();
      var est = parado ? (q.erro || 'Não entrou') : (emCurso ? 'A enviar…' : (adiado ? 'Segue daqui a nada' : (!K.A.sessaoValida() ? 'À espera de entrares' : (!K.online() ? 'À espera de rede' : (q.erro || 'Na fila')))));
      var acoes = [];
      if (parado && q.motivo === 'conflito') acoes.push(['chev', 'Ver o pedido', function () { abrirLista(q.obraId); }]);
      else if (parado && q.motivo !== 'dia-fechado' && q.motivo !== 'externa') acoes.push(['atual', 'Tentar de novo', function () { q.estado = 'a-enviar'; q.erro = ''; K.guardarItem(q); K.drenar(true); }]);
      else if (!parado) acoes.push(['atual', 'Tentar agora', function () { if (!K.A.sessaoValida()) { K.A.pedirLogin('Entra outra vez: o que tens por enviar segue logo a seguir.'); return; } q.adiadoAte = ''; K.drenar(true); }]);
      return { ic: 'caixa', titulo: P.tituloItem(q) + (o ? ' · ' + o.codigo : ''), resumo: P.resumoItem(q), estado: est, cls: parado ? 'neg' : null, acoes: acoes, apagar: parado };
    }

    // ── O Hoje: o bloco Material e as faixas ──
    /** O bloco do mosaico a partir do `material` do Hoje (de uma obra, ou da soma): o número por receber e o percurso. */
    function bloco(mat) {
      if (!mat) return null;
      var n = Number(mat.porReceber) || 0;
      return { n: String(n), leg: n === 1 ? 'por receber' : 'por receber', est: Number(mat.atrasados) ? 'neg' : (Number(mat.porDecidir) ? 'ama' : ''),
        perc: [['', 'Pedido', Number(mat.porDecidir) || 0], ['ace', 'Aceite', Number(mat.aceites) || 0], ['cam', 'A caminho' + (Number(mat.chegaHoje) ? ' · ' + mat.chegaHoje + ' hoje' : ''), Number(mat.aCaminho) || 0], ['', 'Recebido', Number(mat.recebidosSemana) || 0]],
        aria: 'Material: ' + pl(n, 'material', 'materiais') + ' por receber' + (Number(mat.atrasados) ? ', ' + mat.atrasados + ' atrasado' + (Number(mat.atrasados) === 1 ? '' : 's') : '') + (Number(mat.porDecidir) ? ', ' + mat.porDecidir + ' por decidir' : '') + '. Ver os pedidos' };
    }
    /** A faixa de acção do Hoje: «N materiais por decidir» (só ao decisor: o servidor só lha dá a ele) e «Chega hoje». */
    function faixa(mat, ob) {
      if (!disponivel() || !mat) return null;
      var d = mat.decidir, ch = mat.chega, alvo = ob || (d && d.obraId) || (ch && ch.obraId);
      if (d && d.n > 0 && !pendenteSobre(d.pedidoId)) {
        var o = K.obraDe(d.obraId || ob);
        return { ic: 'caixa', t: pl(d.n, 'material por decidir', 'materiais por decidir'), s: ((o && o.codigo) || d.obraCodigo || '') + ' · de ' + P.primeiro(d.autorNome) + (d.precisoAte ? ' · preciso até ' + (d.precisoAte === hoje() ? 'hoje' : D.textoDiaCurto(d.precisoAte)) : ''), b: 'Ver', bl: 'Ver e decidir o pedido de material', fn: function () { abrirPedido(d.pedidoId, d.obraId || alvo); } };
      }
      if (ch && ch.n > 0 && !pendenteSobre(ch.pedidoId)) {
        return { ic: 'camiao', nav: true, t: ch.n > 1 ? pl(ch.n, 'material chega hoje', 'materiais chegam hoje') : 'Chega hoje', s: ch.texto + ' · ' + P.qtdUn(ch), b: 'Ver', bl: 'Ver o pedido do material que chega hoje', fn: function () { abrirPedido(ch.pedidoId, ch.obraId || alvo); } };
      }
      return null;
    }
    /** Um comando por enviar sobre esse pedido (no Desfazer, ou na fila): a faixa sai já. */
    function pendenteSobre(id) { return minhaFila().some(function (q) { return q.tipo === 'pm' && q.registoId === id && (q.accao === 'aceitar' || q.accao === 'recusar' || q.accao === 'recebi'); }); }
    function folhaObras(ms) {
      var l = (ms || []).filter(function (m) { return m.material; });
      if (l.length === 1) { abrirLista(l[0].id); return; }
      K.folha({ titulo: 'Material', sub: 'Escolhe a obra', corpo: function (cc) {
        l.forEach(function (m) {
          var b = bt('mv-lo mv-lo-ir'); b.setAttribute('data-obra', m.id);
          var n = el('span', 'mv-lo-n', m.nome), x = m.material, pc = [pl(Number(x.porReceber) || 0, 'por receber', 'por receber')];
          if (x.porDecidir) pc.push(x.porDecidir + ' por decidir'); if (x.atrasados) pc.push(x.atrasados + (Number(x.atrasados) === 1 ? ' atrasado' : ' atrasados'));
          n.appendChild(el('small', null, pc.join(' · ')));
          junta(b, el('code', null, m.codigo), n, ic('chev'));
          b.addEventListener('click', function () { K.A.fecharFolhas(true); abrirLista(m.id); });
          cc.appendChild(b);
        });
      } });
    }

    function aoSair() { lidosFaixa = {}; S = novo(); }

    return {
      VISTAS: ['v-pm', 'v-pm-form'], ROTULO: { 'v-pm': 'Material', 'v-pm-form': 'Pedir' }, TITULO: { 'v-pm': 'Material', 'v-pm-form': 'Pedir material' },
      disponivel: disponivel, motivoFora: function () { return S.fora; }, abrirLista: abrirLista, abrirForm: abrirForm, abrirPedido: abrirPedido, folhaObras: folhaObras,
      bloco: bloco, faixa: faixa,
      desenhar: function (v) { if (v === 'v-pm') desenharLista(); else if (v === 'v-pm-form') desenharForm(); },
      temForm: function () { return !!S.form; },
      processar: processar, aoResultado: aoResultado, linhaFila: linhaFila, redesenhar: function () { redesenharLista(); },
      aoSair: aoSair, _estado: function () { return S; },
    };
  }
  self.DoeMovelPmEcra = { criar: criar };
}());
