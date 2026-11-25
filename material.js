/* DOE · Telemóvel — Pedidos de material (fatia 2b, entrega 1, 24 nov 2026): lógica pura (sem DOM), UMD como trabalhos.js
   (self.DoeMovelPm no browser, require em Node), testada em Node e contra o servidor real. Contrato: docs/analises/
   Movel-Material-Desenho.md («Entrega 1 construída»). Desenho: docs/prototipos/DOEX-Movel-Material-Prototipo.html (validado).
   Regras que cumpre (as dos trabalhos em falta):
   - as escritas são COMANDOS (`accao`) com o id do pedido e um `pedidoId` gerados aqui, na fila única da conta (itens com
     tipo 'pm'); sem rede ficam «por enviar» e seguem sozinhos, com o MESMO pedidoId (idempotência); o motor é o dos
     trabalhos (DoeMovelTf.processarComando), sem fotos (a divisão em entrega 1, sem fotos, e entrega 2, a Entrega com a
     foto da guia que o Pedro quis em P4, foi acordada com o Pedro em 24 nov);
   - o texto perigoso recusa-se AQUI, antes de entrar na fila (revisão, 14): os mesmos padrões do servidor
     (ocorrenciaEntrada.js › PADROES_PERIGOSOS, paridade em movel-material-dom.test.js); o servidor volta a recusá-lo;
   - a página NÃO tem regra de permissões própria: os botões de cada pedido e de cada linha são os do `pode` do servidor;
   - o estado é POR LINHA (Pedido · Aceite · A caminho · Recebido, ou Recusado, ou Cancelado: a que não vem, cancelada pelo
     Aprovisionamento ou pela GP, com motivo; revisão de 24 nov); «Atrasado» deriva-se pela regra do
     servidor (atrasada, a mesma de regrasMaterial.js, conferida pela tabela partilhada); «Há um problema» é uma frase;
   - 409 TRANSICAO_INVALIDA: o pedido relê-se e diz-se em linguagem de obra o que mudou;
   - o que se lê guarda-se na cache da conta (cache.pm): sai ao Sair e com o token revogado. */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica(require('./diario.js'), require('./trabalhos.js'));
  else raiz.DoeMovelPm = fabrica(raiz.DoeMovelDiario, raiz.DoeMovelTf);
}(typeof self !== 'undefined' ? self : this, function (D, T) {
  'use strict';
  var LIMITES = { linhas: 20, texto: 120, quantidadeMax: 999999, nota: 300, motivo: 300, sugestoes: 6 };
  // A lista fechada do protótipo de 14 nov (o servidor, regrasMaterial.js › UNIDADES): m2 lê-se m².
  var UNIDADES = ['un', 'm', 'm2', 'kg', 'cx', 'rolo', 'saco'];
  var UNIDADE_ROTULO = { un: 'un', m: 'm', m2: 'm²', kg: 'kg', cx: 'cx', rolo: 'rolo', saco: 'saco' };
  var PROBLEMAS = [['MENOS', 'Chegou menos'], ['DANIFICADO', 'Veio danificado'], ['ERRADO', 'Veio errado']];
  var MOTIVOS_RECUSA = ['Há no armazém da obra', 'Já foi pedido', 'Fala comigo'];
  var MOTIVOS_CANCELA = ['O fornecedor já não tem', 'Já não é preciso', 'Vai noutro pedido'];
  // Os padrões do servidor (ocorrenciaEntrada.js › PADROES_PERIGOSOS = js/src/core/01c-texto-seguro.js): iguais, com teste.
  var PADROES_PERIGOSOS = [
    { re: /<\s*script\b/i, o: 'etiqueta <script>' },
    { re: /<\s*iframe\b/i, o: 'etiqueta <iframe>' },
    { re: /<\s*object\b|<\s*embed\b/i, o: 'etiqueta <object>/<embed>' },
    { re: /<\s*svg\b/i, o: 'etiqueta <svg>' },
    { re: /<[a-z!\/](?:"[^"]*"|'[^']*'|[^>"'])*(?:[\s\/"']|"[^"]*"|'[^']*')on\w+\s*=/i, o: 'atributo de evento (onerror, onload, onclick…)' },
    { re: /javascript\s*:/i, o: 'endereço javascript:' },
    { re: /data\s*:\s*text\/html/i, o: 'endereço data:text/html' },
  ];
  /** O que o servidor recusaria neste texto (a descrição), ou null. «L < 2000mm» passa. */
  function textoPerigoso(v) {
    if (typeof v !== 'string' || v.length < 4) return null;
    for (var i = 0; i < PADROES_PERIGOSOS.length; i++) if (PADROES_PERIGOSOS[i].re.test(v)) return PADROES_PERIGOSOS[i].o;
    return null;
  }
  /** A frase do aviso: «O motivo tem uma parte que não posso gravar (etiqueta <script>). Tira-a.» */
  function avisoPerigoso(rotulo, v) { var o = textoPerigoso(v); return o ? rotulo + ' tem uma parte que não posso gravar (' + o + '). Tira-a.' : null; }
  var POR_RECEBER = ['PEDIDO', 'ACEITE', 'A_CAMINHO'];
  var PASSO = { PEDIDO: 0, ACEITE: 1, A_CAMINHO: 2, RECEBIDO: 3 };
  function copia(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function uuid(novoId) { return String(novoId ? novoId() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9_-]/g, ''); }
  function novoIdPm(novoId) { return ('pm-' + uuid(novoId)).slice(0, 64); }
  function pl(n, um, varios) { return n + ' ' + (n === 1 ? um : varios); }
  function primeiro(nome) { var p = String(nome || '').trim().split(/\s+/); return p.length > 1 ? p[0] + ' ' + p[p.length - 1].charAt(0) + '.' : (p[0] || ''); }

  /** «6», «1,5», «200»: a quantidade à portuguesa (o servidor manda um número). */
  function textoQtd(q) { var n = Number(q); if (!isFinite(n)) return ''; return (Math.round(n * 100) / 100).toString().replace('.', ','); }
  function unidade(u) { return UNIDADE_ROTULO[u] || u || 'un'; }
  function qtdUn(l) { return textoQtd(l.quantidade) + ' ' + unidade(l.unidade); }
  /** O que a pessoa escreveu na quantidade («6», «1,5», «2.25») → número com até 2 casas, ou null. */
  function lerQtd(s) {
    var t = String(s == null ? '' : s).trim().replace(',', '.');
    if (!/^\d{1,6}(\.\d{1,2})?$/.test(t)) return null;
    var n = Number(t); return n > 0 && n <= LIMITES.quantidadeMax ? n : null;
  }

  // ── O estado de uma linha (a regra do servidor: doe_pm_atrasada) ──
  /** Atrasada: por receber com a chegada antes de hoje, ou com o «preciso até» do pedido antes de hoje. */
  function atrasadaLinha(l, precisoAte, hoje) {
    var e = l && l.estado;
    if (POR_RECEBER.indexOf(e) < 0) return false;
    if (e === 'A_CAMINHO' && l.chega && l.chega < hoje) return true;
    return !!(precisoAte && precisoAte < hoje);
  }
  /** A palavra, a cor e o facto da linha (o protótipo): «Pedido · à espera da GP», «Aceite · Ana P., 10:20», «A caminho ·
      chega hoje», «Atrasado · chegava seg 23 nov», «Recebido · por Rui S.», «Recusado · Há no armazém da obra». passo: a
      régua de 4 pontos (0 a 3; −1 sem régua); tom: a cor dos pontos. */
  function palavra(l, p, hoje) {
    var pa = (p && p.precisoAte) || null, prob = l.problema ? 'nota da obra: ' + (l.problema.nota || nomeProblema(l.problema.tipo).toLowerCase()) : '';
    if (l.estado === 'ANULADO') return { p: 'Tirado', c: 'neu-t', f: 'por quem pediu', passo: -1, tom: '' };
    if (l.estado === 'RECUSADO') return { p: 'Recusado', c: 'neg-t', f: (l.motivo || '') + (l.decidido && l.decidido.nome ? ' · ' + primeiro(l.decidido.nome) : ''), passo: -1, tom: 'neg' };
    if (l.estado === 'CANCELADO') { var ca = l.cancelado || {}; return { p: 'Cancelado', c: 'neu-t', f: (ca.motivo || l.motivo || 'não vem') + (ca.nome ? ' · ' + primeiro(ca.nome) : ''), passo: -1, tom: '' }; }
    if (l.estado === 'RECEBIDO') return { p: 'Recebido', c: 'pos-t', f: (l.recebido && l.recebido.nome ? 'por ' + primeiro(l.recebido.nome) : '') + (l.recebido && l.recebido.em ? ' · ' + quando(l.recebido.em, hoje) : ''), passo: 3, tom: 'pos' };
    var passo = PASSO[l.estado] || 0;
    if (atrasadaLinha(l, pa, hoje)) {
      var f = l.estado === 'A_CAMINHO' && l.chega && l.chega < hoje ? 'chegava ' + D.textoDiaMes(l.chega) : 'precisava até ' + D.textoDiaMes(pa);
      return { p: 'Atrasado', c: 'neg-t', f: prob ? f + ' · ' + prob : f, passo: passo, tom: 'neg' };
    }
    if (l.estado === 'A_CAMINHO') return { p: 'A caminho', c: 'ama-t', f: prob || (l.chega ? (l.chega === hoje ? 'chega hoje' : 'chega ' + D.textoDiaCurto(l.chega)) : 'sem data prevista'), passo: 2, tom: 'ama' };
    if (l.estado === 'ACEITE') return { p: 'Aceite', c: 'nav-t', f: prob || (l.decidido && l.decidido.nome ? primeiro(l.decidido.nome) + (l.decidido.em ? ', ' + quando(l.decidido.em, hoje) : '') : 'aceite'), passo: 1, tom: '' };
    return { p: 'Pedido', c: 'neu-t', f: 'à espera da GP' + ((l.pode || []).indexOf('linha-editar') >= 0 ? ' · podes corrigir' : ''), passo: 0, tom: '' };
  }
  function quando(iso, hoje) { var d = T.diaDe(iso); if (!d) return ''; return d === hoje ? D.horaDe(iso) : D.textoDiaMes(d); }
  function nomeProblema(t) { var x = PROBLEMAS.filter(function (p) { return p[0] === t; })[0]; return x ? x[1] : 'Há um problema'; }
  /** O pedido está aberto enquanto houver uma linha por receber (a regra do servidor, `aberto`). */
  function aberto(p) { return (p.linhas || []).some(function (l) { return POR_RECEBER.indexOf(l.estado) >= 0; }); }
  /** Os números da lista com os nomes do bloco Material do Hoje (a mesma população): por decidir, aceites, a caminho, chega
      hoje, atrasados, por receber, recebidos (todos os da lista). */
  function contas(pedidos, hoje) {
    var s = { porDecidir: 0, aceites: 0, aCaminho: 0, chegaHoje: 0, atrasados: 0, porReceber: 0, recebidos: 0, abertos: 0, fechados: 0 };
    (pedidos || []).forEach(function (p) {
      if (aberto(p)) s.abertos++; else s.fechados++;
      (p.linhas || []).forEach(function (l) {
        if (l.estado === 'PEDIDO') s.porDecidir++;
        if (l.estado === 'ACEITE') s.aceites++;
        if (l.estado === 'A_CAMINHO') { s.aCaminho++; if (l.chega === hoje) s.chegaHoje++; }
        if (atrasadaLinha(l, p.precisoAte, hoje)) s.atrasados++;
        if (POR_RECEBER.indexOf(l.estado) >= 0) s.porReceber++;
        if (l.estado === 'RECEBIDO') s.recebidos++;
      });
    });
    return s;
  }
  /** Os pedidos de um filtro: «abertos» (alguma linha por receber) ou «fechados»; os abertos com atrasos primeiro, depois os
      mais antigos; os fechados, os mais recentes primeiro. */
  function filtrar(pedidos, filtro, hoje) {
    var f = filtro === 'fechados' ? 'fechados' : 'abertos';
    var l = (pedidos || []).filter(function (p) { return (f === 'abertos') === aberto(p); });
    l.sort(function (a, b) {
      if (f === 'fechados') return String(b.alteradoEm || b.criadoEm || '').localeCompare(String(a.alteradoEm || a.criadoEm || ''));
      var ra = (a.linhas || []).some(function (x) { return atrasadaLinha(x, a.precisoAte, hoje); }) ? 0 : 1, rb = (b.linhas || []).some(function (x) { return atrasadaLinha(x, b.precisoAte, hoje); }) ? 0 : 1;
      return ra - rb || String(b.criadoEm || '').localeCompare(String(a.criadoEm || ''));
    });
    return l;
  }
  /** «Hoje, 09:58 · a Ana P.»: o cabeçalho de um pedido. paraQuem: {nome} da leitura (o decisor). */
  function cabecalho(p, hoje, paraQuem) {
    var d = p.dia || T.diaDe(p.criadoEm), h = p.criadoEm ? D.horaDe(p.criadoEm) : '';
    var quandoTxt = d === hoje ? 'Hoje' + (h ? ', ' + h : '') : D.textoDiaCurto(d);
    var quem = p.autor && !p.autor.eu ? 'de ' + primeiro(p.autor.nome) : (paraQuem && paraQuem.nome ? 'a ' + primeiro(paraQuem.nome) : '');
    return { t: quandoTxt + (quem ? ' · ' + quem : ''), ate: p.precisoAte ? 'preciso até ' + (p.precisoAte === hoje ? 'hoje' : (D.difDias(hoje, p.precisoAte) === 1 ? 'amanhã' : D.textoDiaCurto(p.precisoAte))) : '' };
  }
  /** «Vai para Ana Pereira, GP da ALC» (sem decisor: à gestão). */
  function textoParaQuem(pq, codigo) {
    if (!pq) return 'Sem GP nesta obra: o pedido vai à gestão';
    return 'Vai para ' + pq.nome + ', ' + (pq.papel === 'GP' ? 'GP' : 'chefia da GP') + (codigo ? ' da ' + codigo : '');
  }

  // ── O formulário (em memória; sem fotos) ──
  function linhaNova(un) { return { texto: '', qtd: '1', unidade: UNIDADES.indexOf(un) >= 0 ? un : 'un' }; }
  function formNovo(o) { return { obraId: (o && o.obraId) || '', linhas: [linhaNova()], precisoOp: '', precisoAte: null, nota: '', tentou: false }; }
  /** «Hoje · Amanhã · Esta semana (sexta; ao fim de semana, a sexta seguinte) · Escolher». */
  function opcoesPreciso(hoje) {
    var w = D.diaDaSemana(hoje), sex = (5 - w + 7) % 7;
    return [['hoje', 'Hoje', hoje], ['amanha', 'Amanhã', D.somarDias(hoje, 1)], ['semana', 'Esta semana', D.somarDias(hoje, sex)], ['escolher', 'Escolher', null]];
  }
  /** A primeira coisa que falta (o que o botão diz), ou null. */
  function faltaForm(f, obraValida) {
    if (!f || !f.obraId || obraValida === false) return { campo: 'obra', texto: 'Falta escolher a obra' };
    var cheias = (f.linhas || []).filter(function (l) { return String(l.texto || '').trim(); });
    if (!cheias.length) return { campo: 'texto', texto: 'Falta escrever o material' };
    for (var i = 0; i < (f.linhas || []).length; i++) {
      var l = f.linhas[i]; if (!String(l.texto || '').trim()) continue;
      if (String(l.texto).trim().length > LIMITES.texto) return { campo: 'texto', i: i, texto: 'O nome do material tem mais de ' + LIMITES.texto + ' caracteres' };
      var pg = avisoPerigoso('O material ' + (i + 1), String(l.texto)); if (pg) return { campo: 'texto', i: i, texto: pg };
      if (lerQtd(l.qtd) === null) return { campo: 'qtd', i: i, texto: 'A quantidade de «' + String(l.texto).trim().slice(0, 24) + '» não é um número' };
    }
    if (cheias.length > LIMITES.linhas) return { campo: 'texto', texto: 'No máximo ' + LIMITES.linhas + ' materiais por pedido' };
    if (f.precisoOp === 'escolher' && !(f.precisoAte && T.RE_DIA.test(f.precisoAte))) return { campo: 'preciso', texto: 'Falta escolher o dia' };
    if (String(f.nota || '').trim().length > LIMITES.nota) return { campo: 'nota', texto: 'A nota tem mais de ' + LIMITES.nota + ' caracteres' };
    var pn = avisoPerigoso('A nota', String(f.nota || '')); if (pn) return { campo: 'nota', texto: pn };
    return null;
  }
  function camposCriar(f) {
    var c = { linhas: (f.linhas || []).filter(function (l) { return String(l.texto || '').trim(); }).map(function (l) { return { texto: String(l.texto).trim().replace(/\s+/g, ' ').slice(0, LIMITES.texto), quantidade: lerQtd(l.qtd), unidade: UNIDADES.indexOf(l.unidade) >= 0 ? l.unidade : 'un' }; }) };
    if (f.precisoAte) c.precisoAte = f.precisoAte;
    var n = String(f.nota || '').trim(); if (n) c.nota = n.slice(0, LIMITES.nota);
    return c;
  }
  /** Os chips «Pedidos antes nesta obra» (o servidor), sem os que já estão no formulário. */
  function sugestoes(lista, f) {
    var ja = {}; ((f && f.linhas) || []).forEach(function (l) { ja[String(l.texto || '').trim().toLowerCase()] = 1; });
    return (lista || []).filter(function (s) { return s && s.texto && !ja[s.texto.toLowerCase()]; }).slice(0, LIMITES.sugestoes);
  }
  /** Uma sugestão entra na primeira linha vazia (senão numa nova): quantidade 1 e a unidade de quando foi pedida. */
  function juntarSugestao(f, s) {
    var vazia = (f.linhas || []).filter(function (l) { return !String(l.texto || '').trim(); })[0];
    if (vazia) { vazia.texto = s.texto; vazia.unidade = UNIDADES.indexOf(s.unidade) >= 0 ? s.unidade : vazia.unidade; vazia.qtd = vazia.qtd || '1'; }
    else if (f.linhas.length < LIMITES.linhas) f.linhas.push({ texto: s.texto, qtd: '1', unidade: UNIDADES.indexOf(s.unidade) >= 0 ? s.unidade : 'un' });
    return f;
  }
  /** O stepper − / + (de 1 em 1; nunca abaixo de 1 com o −). */
  function passoQtd(qtd, d) { var n = lerQtd(qtd); if (n === null) n = 0; n = Math.round((n + d) * 100) / 100; if (n < 1) n = d < 0 ? 1 : n; return textoQtd(Math.min(LIMITES.quantidadeMax, n)); }

  // ── A cache da conta (cache.pm[obra] = { data, lidoEm }) ──
  var OBRAS_NA_CACHE = 4;
  function aparar(mapa, max) {
    var ks = Object.keys(mapa).sort(function (a, b) { return String((mapa[b] || {}).lidoEm || '').localeCompare(String((mapa[a] || {}).lidoEm || '')); });
    ks.slice(max).forEach(function (k) { delete mapa[k]; });
  }
  function guardarLista(cache, obra, data, agora) {
    if (!cache.pm || typeof cache.pm !== 'object') cache.pm = {};
    cache.pm[String(obra)] = { data: copia(data), lidoEm: (agora || new Date()).toISOString() };
    aparar(cache.pm, OBRAS_NA_CACHE);
    return cache;
  }
  function listaDe(cache, obra) { var x = cache && cache.pm && cache.pm[String(obra)]; return x && x.data ? x : null; }
  /** Um pedido que o servidor devolveu (num comando) entra na cópia, no lugar do antigo (ou à frente, se é novo). */
  function porRegisto(cache, registo) {
    if (!registo || !registo.obraId) return cache;
    var x = listaDe(cache, registo.obraId); if (!x) return cache;
    var l = x.data.pedidos || [], i = -1;
    l.forEach(function (p, j) { if (p.id === registo.id) i = j; });
    if (i >= 0) l[i] = copia(registo); else { l.unshift(copia(registo)); x.data.total = (Number(x.data.total) || 0) + 1; }
    x.data.pedidos = l;
    return cache;
  }

  // ── Os comandos (a fila única: itens com tipo 'pm') ──
  var CAMPOS = { criar: ['linhas', 'precisoAte', 'nota'], editar: ['precisoAte', 'nota'], 'linha-juntar': ['linhas'], 'linha-editar': ['n', 'texto', 'quantidade', 'unidade'],
    'linha-tirar': ['n'], 'linha-repor': ['n'], anular: [], aceitar: ['linhas'], recusar: ['linhas', 'motivo'], cancelar: ['linhas', 'motivo'], reabrir: ['n'], recebi: ['linhas'],
    problema: ['n', 'tipo', 'nota'], 'desfazer-rececao': ['n'] };
  /** Um item da fila. o: { accao, pm (o pedido, ou {id, obraId} no criar), campos, contaId, contaNome, novoId, agora, adiarMs, resumo }. */
  function itemComando(o) {
    var agora = o.agora || new Date(), p = o.pm || {}, campos = {};
    (CAMPOS[o.accao] || []).forEach(function (k) { if (o.campos && Object.prototype.hasOwnProperty.call(o.campos, k) && o.campos[k] !== undefined) campos[k] = o.campos[k]; });
    return { id: 'q-' + uuid(o.novoId), tipo: 'pm', estado: 'a-enviar', contaId: String(o.contaId || ''), contaNome: String(o.contaNome || ''),
      registoId: String(p.id || ''), obraId: String(p.obraId || o.obraId || ''), accao: o.accao, campos: campos, pedidoId: T.novoPedidoId(o.novoId),
      versao: Number(p.versao) || 0, fotos: [], resumo: String(o.resumo || resumoPedido(p) || '').slice(0, 80),
      criadoEm: agora.toISOString(), adiadoAte: o.adiarMs ? new Date(agora.getTime() + o.adiarMs).toISOString() : '', tentou: false, resposta: null, erro: '', avisos: [] };
  }
  function resumoPedido(p) { var ls = (p && p.linhas) || []; if (!ls.length) return ''; return ls[0].texto + (ls.length > 1 ? ' e mais ' + (ls.length - 1) : ''); }
  /** O corpo do POST /movel/pm (a lista fechada do contrato). */
  function corpoComando(item) {
    var c = { accao: item.accao, pedidoId: item.pedidoId, id: item.registoId };
    if (item.accao === 'criar') c.obraId = item.obraId;
    Object.keys(item.campos || {}).forEach(function (k) { c[k] = item.campos[k]; });
    if ((item.accao === 'editar' || item.accao === 'linha-editar') && item.versao) c.versao = item.versao;
    return c;
  }
  /** O pedido como fica com um comando por enviar (para se ver logo; a resposta do servidor substitui-o). */
  function aplicarLocal(p0, item, hoje, eu) {
    var p = copia(p0) || {}, c = item.campos || {}, agora = new Date().toISOString(), nome = (eu && eu.nome) || '';
    var ls = function (ns) { return (p.linhas || []).filter(function (l) { return (ns || []).indexOf(l.n) >= 0; }); };
    var um = function (n) { return (p.linhas || []).filter(function (l) { return l.n === n; }); };
    p.historico = (p.historico || []).concat([{ accao: item.accao, em: agora, nome: nome }]);
    if (item.accao === 'aceitar') ls(c.linhas).forEach(function (l) { if (l.estado === 'PEDIDO') { l.estado = 'ACEITE'; l.decidido = { nome: nome, em: agora }; } });
    else if (item.accao === 'recusar') ls(c.linhas).forEach(function (l) { if (l.estado === 'PEDIDO') { l.estado = 'RECUSADO'; l.motivo = c.motivo; l.decidido = { nome: nome, em: agora }; } });
    else if (item.accao === 'recebi') ls(c.linhas).forEach(function (l) { if (l.estado === 'ACEITE' || l.estado === 'A_CAMINHO') { l.estado = 'RECEBIDO'; l.recebido = { nome: nome, em: agora, eu: true }; } });
    else if (item.accao === 'cancelar') ls(c.linhas).forEach(function (l) { if (l.estado === 'ACEITE' || l.estado === 'A_CAMINHO') { l.estado = 'CANCELADO'; l.motivo = c.motivo; l.cancelado = { nome: nome, em: agora, motivo: c.motivo }; } });
    else if (item.accao === 'reabrir') um(c.n).forEach(function (l) {
      if (l.estado === 'CANCELADO') { l.estado = 'ACEITE'; l.cancelado = null; l.motivo = null; l.chega = null; l.caminho = null; }   // volta a Aceite, sem data
      else { l.estado = 'PEDIDO'; l.decidido = null; l.motivo = null; }
    });
    else if (item.accao === 'problema') um(c.n).forEach(function (l) { l.problema = { tipo: c.tipo, nota: c.nota || null, nome: nome, em: agora }; });
    else if (item.accao === 'desfazer-rececao') um(c.n).forEach(function (l) { l.estado = l.caminho ? 'A_CAMINHO' : 'ACEITE'; l.recebido = null; });
    else if (item.accao === 'linha-tirar') um(c.n).forEach(function (l) { l.estado = 'ANULADO'; l.anuladoEm = agora; });
    else if (item.accao === 'linha-repor') um(c.n).forEach(function (l) { l.estado = 'PEDIDO'; l.anuladoEm = null; });
    else if (item.accao === 'anular') (p.linhas || []).forEach(function (l) { if (l.estado === 'PEDIDO') { l.estado = 'ANULADO'; l.anuladoEm = agora; } });
    else if (item.accao === 'linha-editar') um(c.n).forEach(function (l) { if (c.texto) l.texto = c.texto; if (c.quantidade) l.quantidade = c.quantidade; if (c.unidade) l.unidade = c.unidade; });
    else if (item.accao === 'linha-juntar') { var mx = 0; (p.linhas || []).forEach(function (l) { mx = Math.max(mx, l.n); }); (c.linhas || []).forEach(function (x) { mx++; p.linhas.push({ n: mx, texto: x.texto, quantidade: x.quantidade, unidade: x.unidade, estado: 'PEDIDO', pode: [] }); }); }
    else if (item.accao === 'editar') { if (Object.prototype.hasOwnProperty.call(c, 'precisoAte')) p.precisoAte = c.precisoAte; if (Object.prototype.hasOwnProperty.call(c, 'nota')) p.nota = c.nota; }
    (p.linhas || []).forEach(function (l) { l.pode = []; l.atrasada = atrasadaLinha(l, p.precisoAte, hoje); });
    p.aberto = aberto(p); p.porEnviar = true; p.pode = [];   // até o servidor responder, nada mais se faz nele
    return p;
  }
  /** O pedido que nasce no telemóvel (o criar por enviar). */
  function registoProvisorio(item, eu, hoje) {
    var c = item.campos || {}, agora = item.criadoEm;
    var p = { id: item.registoId, obraId: item.obraId, autor: { nome: (eu && eu.nome) || '', eu: true }, dia: hoje, criadoEm: agora, precisoAte: c.precisoAte || null, nota: c.nota || null,
      linhas: (c.linhas || []).map(function (x, i) { return { n: i + 1, texto: x.texto, quantidade: x.quantidade, unidade: x.unidade, estado: 'PEDIDO', pode: [] }; }),
      versao: 0, alteradoEm: agora, pode: [], historico: [{ accao: 'criar', em: agora, nome: (eu && eu.nome) || '' }], porEnviar: true };
    p.aberto = aberto(p);
    return p;
  }
  /** Um comando recusado de vez marca o pedido «não entrou»; um conflito (a pessoa já viu o que mudou) não. */
  function paradoNaoEntrou(q) { return q.estado === 'parado' && q.motivo !== 'conflito'; }
  /** A lista que se mostra: a cópia do servidor com os comandos por enviar por cima (por ordem). */
  function comPendentes(lista, fila, obra, hoje, eu) {
    var l = (lista || []).map(copia), porId = {};
    var idx = function () { porId = {}; l.forEach(function (p, i) { porId[p.id] = i; }); }; idx();
    (fila || []).filter(function (q) { return q.tipo === 'pm' && q.obraId === obra && q.estado !== 'entregue'; }).sort(function (a, b) { return String(a.criadoEm).localeCompare(String(b.criadoEm)); }).forEach(function (q) {
      if (q.accao === 'criar') { if (porId[q.registoId] == null) { var r = registoProvisorio(q, eu, hoje); if (paradoNaoEntrou(q)) r.comErro = q.erro || 'Não entrou'; l.unshift(r); idx(); } return; }
      var i = porId[q.registoId]; if (i == null) return;
      if (q.estado === 'parado') { if (paradoNaoEntrou(q)) l[i].comErro = q.erro || 'Não entrou'; return; }
      l[i] = aplicarLocal(l[i], q, hoje, eu);
    });
    return l;
  }

  // ── A resposta do servidor e os erros ──
  function aplicarResposta(item, data) {
    item.resposta = { versao: Number(data.versao) || 0, repetido: !!data.repetido, mudadas: data.mudadas || [], naoMudadas: data.naoMudadas || [], substituiu: data.substituiu || null };
    item.registo = data.registo || null;
    item.avisos = [];
    (data.avisos || []).forEach(function (a) { if (a && a.motivo === 'sem-decisor') item.avisos.push('Esta obra não tem GP nem chefia da GP: o pedido vai à gestão.'); });
    var nao = data.naoMudadas || [], ja = nao.filter(function (x) { return x && x.motivo === 'ja'; }), nm = nao.length - ja.length;
    if (nm && (data.mudadas || []).length) item.avisos.push(pl(nm, 'material já tinha mudado', 'materiais já tinham mudado') + ' e ficaram como estavam.');
    // revisão (14): outra pessoa já tinha feito o mesmo (dois encarregados carregam «Recebi»): ok, e diz-se quem
    if (ja.length && !(data.mudadas || []).length) item.avisos.push(textoJa(ja, data.registo));
    if (data.substituiu && (item.accao === 'editar' || item.accao === 'linha-editar')) item.avisos.push(T.textoSubstituiu(data.substituiu, 'pedido'));
    return item;
  }
  /** Os erros em linguagem de obra (o que o motor dos trabalhos faz a seguir: parar, repetir, conflito). */
  function mensagemPm(e) {
    var c = (e && e.code) || '', d = (e && e.details) || {};
    if (c === 'TRANSICAO_INVALIDA') return { accao: 'conflito', estado: d.estado || '', versao: d.versao, texto: 'Isto já mudou noutro telemóvel ou no computador.' };
    if (c === 'SEM_PAPEL') return { accao: 'parar', texto: (e && e.message) || 'Não podes fazer isto neste pedido.' };
    if (c === 'DIA_FECHADO') return { accao: 'parar', fechado: true, texto: 'Já passaram os 7 dias em que quem pediu corrige e desfaz. Agora, só o GP.' };
    if (c === 'TOKEN_DE_AMBITO') return { accao: 'repetir', longo: true, recuada: true, texto: 'Os pedidos de material estão a ser atualizados no servidor. Fica no telemóvel; tento mais tarde.' };
    if (c === 'MATERIAL_POR_INSTALAR') return { accao: 'repetir', longo: true, texto: 'Os pedidos de material ainda estão a ser preparados no servidor. Fica no telemóvel; tento mais tarde.' };
    if (c === 'CONTA_EXTERNA') return { accao: 'parar', externa: true, texto: 'Os pedidos de material são só das contas da DOE.' };
    if (c === 'NAO_EXISTE') return { accao: 'parar', texto: 'Este pedido já não existe nesta obra.' };
    if (c === 'LIMITE_DIARIO' || c === 'LINHAS_DEMAIS' || c === 'TEXTO_PERIGOSO' || c === 'VALIDATION_ERROR' || c === 'OBRA_INVALIDA') return { accao: 'parar', texto: (e && e.message) || 'O servidor não aceitou este pedido.' };
    return D.mensagemDiario(e);
  }
  var CFG_PM = { rota: '/movel/pm', entidade: 'MAT', corpo: corpoComando, aplicar: aplicarResposta, mensagem: mensagemPm, novoIdRegisto: novoIdPm };
  function processarPm(item, deps) { return T.processarComando(item, deps, CFG_PM); }
  function lerLista(deps, obra) { return D.pedir(deps, 'GET', '/movel/pm?obra=' + encodeURIComponent(obra)); }

  // ── O histórico e a fila, em linguagem de obra ──
  var ACCAO = { criar: 'Pedido', editar: 'Pedido mudado', 'linha-juntar': 'Material acrescentado', 'linha-editar': 'Material corrigido', 'linha-tirar': 'Material tirado',
    'linha-repor': 'Material reposto', anular: 'Pedido anulado', aceitar: 'Aceite', recusar: 'Recusado', reabrir: 'Reaberto', 'a-caminho': 'A caminho', cancelar: 'Cancelado',
    recebi: 'Recebido', problema: 'Há um problema', 'desfazer-rececao': 'Receção desfeita' };
  function nomeAccao(a) { return ACCAO[a] || a; }
  var FRASE = { aceitar: 'já foi aceite', recusar: 'já foi recusado', 'a-caminho': 'já está a caminho', cancelar: 'já foi cancelado', recebi: 'já foi recebido', anular: 'já foi anulado', 'linha-tirar': 'já foi tirado', reabrir: 'já foi reaberto' };
  var JA_ESTADO = { ACEITE: 'aceite', RECUSADO: 'recusado', RECEBIDO: 'recebido', CANCELADO: 'cancelado', ANULADO: 'tirado' };
  /** «Já estava recebido por Bruno C.» / «Já estavam 2 recebidos»: o que outra pessoa já tinha feito (motivo «ja»). */
  function textoJa(ja, registo) {
    var e = JA_ESTADO[ja[0] && ja[0].estado] || 'feito', l = ((registo && registo.linhas) || []).filter(function (x) { return x.n === (ja[0] && ja[0].n); })[0];
    var quem = l && l.estado === 'RECEBIDO' && l.recebido && l.recebido.nome ? l.recebido.nome : (l && l.estado === 'CANCELADO' && l.cancelado ? l.cancelado.nome : (l && l.decidido ? l.decidido.nome : ''));
    if (ja.length > 1) return 'Já estavam ' + ja.length + ' ' + e.replace(/o$/, 'os') + ': não mudei nada.';
    return 'Já estava ' + e + (quem ? ' por ' + primeiro(quem) : '') + ': não mudei nada.';
  }
  /** «Já foi aceite por Ana Pereira.»: o que mudou a linha e quem (o histórico do servidor). */
  function textoConflito(registo) {
    var hs = (registo && registo.historico) || [], h = null;
    for (var i = hs.length - 1; i >= 0 && !h; i--) if (hs[i] && FRASE[hs[i].accao]) h = hs[i];
    if (!h) return 'Já mudou entretanto.';
    var f = FRASE[h.accao];
    return f.charAt(0).toUpperCase() + f.slice(1) + (h.nome ? ' por ' + h.nome : '') + '.';
  }
  function resumoItem(q) {
    var c = q.campos || {}, r = q.resumo || '';
    if (q.accao === 'criar') { var ls = c.linhas || []; return ls.length ? ls[0].texto + ' · ' + textoQtd(ls[0].quantidade) + ' ' + unidade(ls[0].unidade) + (ls.length > 1 ? ' e mais ' + (ls.length - 1) : '') : r; }
    if (q.accao === 'recusar') return r + ' · recusado: ' + (c.motivo || '');
    if (q.accao === 'cancelar') return r + ' · cancelado: ' + (c.motivo || '');
    if (q.accao === 'problema') return r + ' · ' + nomeProblema(c.tipo).toLowerCase() + (c.nota ? ': ' + c.nota : '');
    return r + ' · ' + nomeAccao(q.accao).toLowerCase();
  }
  function tituloItem(q) { return q.accao === 'criar' ? 'Pedido de material' : 'Material · ' + nomeAccao(q.accao).toLowerCase(); }
  function disponivel(funcs) { return Array.isArray(funcs) && funcs.indexOf('material') >= 0; }

  return {
    LIMITES: LIMITES, UNIDADES: UNIDADES, UNIDADE_ROTULO: UNIDADE_ROTULO, PROBLEMAS: PROBLEMAS, MOTIVOS_RECUSA: MOTIVOS_RECUSA, MOTIVOS_CANCELA: MOTIVOS_CANCELA, POR_RECEBER: POR_RECEBER,
    PADROES_PERIGOSOS: PADROES_PERIGOSOS, textoPerigoso: textoPerigoso, avisoPerigoso: avisoPerigoso, textoJa: textoJa,
    novoIdPm: novoIdPm, primeiro: primeiro, textoQtd: textoQtd, unidade: unidade, qtdUn: qtdUn, lerQtd: lerQtd, atrasadaLinha: atrasadaLinha, palavra: palavra,
    nomeProblema: nomeProblema, aberto: aberto, contas: contas, filtrar: filtrar, cabecalho: cabecalho, textoParaQuem: textoParaQuem,
    linhaNova: linhaNova, formNovo: formNovo, opcoesPreciso: opcoesPreciso, faltaForm: faltaForm, camposCriar: camposCriar, sugestoes: sugestoes, juntarSugestao: juntarSugestao, passoQtd: passoQtd,
    guardarLista: guardarLista, listaDe: listaDe, porRegisto: porRegisto, OBRAS_NA_CACHE: OBRAS_NA_CACHE,
    itemComando: itemComando, corpoComando: corpoComando, aplicarLocal: aplicarLocal, registoProvisorio: registoProvisorio, comPendentes: comPendentes, paradoNaoEntrou: paradoNaoEntrou,
    aplicarResposta: aplicarResposta, mensagemPm: mensagemPm, processarPm: processarPm, lerLista: lerLista, CFG_PM: CFG_PM,
    nomeAccao: nomeAccao, textoConflito: textoConflito, resumoItem: resumoItem, tituloItem: tituloItem, disponivel: disponivel,
  };
}));
