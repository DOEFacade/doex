/* DOE · Telemóvel — o Pessoal, fase 1 (16 nov 2026): SÓ PARA LER. Lógica pura (sem DOM), UMD como hoje.js
   (self.DoeMovelPessoal no browser, require em Node), testada em Node e contra o servidor real dos testes.
   Uma só leitura, GET /movel/pessoal (contrato: docs/analises/Movel-Pessoal-Contrato.md, «F1 construída, o lado do
   servidor»), e as contas do ecrã do protótipo validado pelo Pedro (docs/prototipos/telemovel-perfis/pessoal.js).
   Regras que esta lógica cumpre:
   - quem tem Pessoal decide-o o SERVIDOR (`pessoal` nas funcionalidades do Hoje mais recente ou do login); a página não
     tem regra de papéis além do quemVe() da casca (a conta só de telemóvel e a externa nunca o vêem);
   - uma Edge anterior à F1 responde 403 TOKEN_DE_AMBITO: é «Em breve», nunca o login, e não mexe na fila;
   - o dia de hoje e o ano vêm do servidor (`hoje`, `ano`); os feriados são os de feriados.js e os fechos os da resposta;
     as datas são texto AAAA-MM-DD e a aritmética é a de diario.js (UTC), nunca toISOString().slice(0, 10);
   - o «gozado» é o do servidor (por dia, até ontem); a barra e a grelha do ano partem por dia, como ele;
   - a cópia guarda-se numa chave PRÓPRIA do localStorage (`doeMovel.pessoal`, com a conta dentro e um tecto de tamanho:
     revisão de f673e387, P1), à parte da cache do Hoje e do diário: se não couber, o Pessoal fica só em memória e o resto
     grava-se na mesma. Sai ao Sair, com o token revogado e quando entra outra conta. Nunca há dados de outra pessoa: o
     servidor só manda os da conta. */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica(require('./diario.js'));
  else raiz.DoeMovelPessoal = fabrica(raiz.DoeMovelDiario);
}(typeof self !== 'undefined' ? self : this, function (D) {
  'use strict';
  var ROTA = '/movel/pessoal';
  var RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
  var MESES_L = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  var PRESENCA = ['TELETRABALHO', 'OUT_OFFICE'];
  // As mensagens do servidor (pessoalMovel.js MENSAGENS_RECUSA), para quando a resposta não as traz.
  var RECUSA = {
    SEM_PESSOAL: 'O Pessoal é só para quem tem conta na aplicação do computador.',
    CONTA_EXTERNA: 'Esta conta é externa: o Pessoal é só para quem trabalha na DOE.',
    SEM_PERFIL: 'A tua conta não está ligada a nenhuma pessoa activa no DOE. Pede à administração.',
    PAPEL_SEM_ESCRITA: 'O teu papel (só leitura) não tem o Pessoal.',   // revisão de f673e387 (C1): a VIEWER não tem Pessoal (servidor 5e80a7df)
  };
  var CODIGOS_RECUSA = ['SEM_PESSOAL', 'CONTA_EXTERNA', 'SEM_PERFIL', 'PAPEL_SEM_ESCRITA'];
  var LS_PESSOAL = 'doeMovel.pessoal';
  var LIMITE_COPIA = 512 * 1024;   // caracteres do JSON guardado (o servidor no máximo, medido: ver movel-pessoal-dom.test.js)
  var EM_BREVE = 'Pessoal chega em breve: férias e despesas. Por agora, no computador.';
  function copia(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : 0; }
  function pl(n, um, varios) { return n + ' ' + (n === 1 ? um : varios); }
  function dia(v) { return typeof v === 'string' && RE_DIA.test(v) ? v : null; }
  function lista(v) { return Array.isArray(v) ? v : []; }

  // ── Rede ──
  /** GET /movel/pessoal (o ano por omissão é o de hoje em Lisboa, decidido pelo servidor). */
  function lerPessoal(deps, ano) { return D.pedir(deps, 'GET', ROTA + (ano ? '?ano=' + encodeURIComponent(ano) : '')); }
  /** O que fazer com uma leitura que falhou. → { tipo, texto, code, retryAfter, revogado, tirar }
      tipo: 'rede' (sem rede ou resposta perdida: fica a cópia), 'embreve' (a Edge de antes da F1: «Em breve», sem login),
      'recusa' (a conta não tem Pessoal: `tirar` = o separador sai), 'repetir' (429 ou servidor ocupado: tenta sozinho),
      'login' (a sessão acabou ou o telemóvel foi desligado: `revogado` apaga as leituras), 'erro'. */
  function falha(r) {
    r = r || {};
    if (r.rede) return { tipo: 'rede', texto: r.online === false ? 'Sem rede.' : 'Não consegui falar com o servidor (rede fraca).' };
    var c = r.code || '';
    // 403 TOKEN_DE_AMBITO: o portão de uma Edge anterior à F1 não conhece a rota. NÃO é o «entra outra vez» do diário.
    if (c === 'TOKEN_DE_AMBITO' || c === 'ROUTE_NOT_FOUND' || c === 'NOT_FOUND' || (r.status === 404 && !c)) return { tipo: 'embreve', texto: EM_BREVE, code: c };
    if (CODIGOS_RECUSA.indexOf(c) >= 0) return { tipo: 'recusa', texto: r.message || RECUSA[c], code: c, tirar: c !== 'SEM_PERFIL' };
    if (c === 'DEMASIADOS_PEDIDOS' || r.status === 429) return { tipo: 'repetir', code: c || 'DEMASIADOS_PEDIDOS', retryAfter: num(r.retryAfter) || 60, texto: 'Demasiados pedidos seguidos. Volto a ler daqui a ' + D.textoEspera(num(r.retryAfter) || 60) + '.' };
    if (c === 'DB_INDISPONIVEL' || r.status >= 500 || r.status === 0) return { tipo: 'repetir', code: c, retryAfter: num(r.retryAfter), texto: 'O servidor está ocupado. Volto a ler daqui a pouco.' };
    var m = D.mensagemDiario(r);
    if (m.accao === 'login') return { tipo: 'login', texto: m.texto, code: c, revogado: !!m.revogado };
    if (c === 'VALIDATION_ERROR') return { tipo: 'erro', code: c, texto: 'O pedido não é válido. Avisa o escritório.' };
    return { tipo: 'erro', code: c, texto: r.message || 'Não consegui ler o Pessoal.' };
  }
  /** O servidor dá o Pessoal a esta conta? `pessoal` nas funcionalidades (as do Hoje lido nesta abertura, ou as do login). */
  function temFuncionalidade(funcs) { return lista(funcs).indexOf('pessoal') >= 0; }
  /** O servidor da F1 diz, no login e no Hoje, `pessoalRecusa: '<código>'` quando a conta NÃO tem Pessoal (revisão de f673e387,
      C2). Um código desconhecido conta também (falha fechada: sem o separador); ausente = '' (tem, ou é uma Edge de antes). */
  function recusaDe(data) { var v = data && data.pessoalRecusa; return typeof v === 'string' && /^[A-Z_]{1,40}$/.test(v) ? v : ''; }
  /** DB_INDISPONIVEL: o servidor não conseguiu ler as pessoas agora. Não é «não é para ti»: o separador fica, sem abrir. */
  var RECUSA_PASSAGEIRA = 'DB_INDISPONIVEL';
  var SEM_CONFIRMAR = 'Não consegui confirmar o teu Pessoal no servidor. Tento outra vez quando o Hoje se atualizar.';

  // ── A cópia da conta (chave própria, com tecto) ──
  /** O texto a guardar: { contaId, data, lidoEm, cortada }. Se passar do tecto, corta-se primeiro o histórico (as últimas 5
      entradas de cada registo), depois a lista das empresas e dos contactos (é da F2), depois metade das listas, até caber.
      → { texto, cortada, tamanho } ou null (nem assim cabe). */
  function paraGuardar(contaId, data, lidoEm, limite) {
    var max = limite || LIMITE_COPIA, d = copia(data), passos = [
      function () { lista(d.pedidos).concat(lista(d.despesas)).forEach(function (x) { if (Array.isArray(x.historico)) x.historico = x.historico.slice(-5); }); },
      function () { d.visitas = { empresas: [] }; },
      function () { d.pedidos = lista(d.pedidos).slice(0, 100); d.despesas = lista(d.despesas).slice(0, 150); },
      function () { d.pedidos = lista(d.pedidos).slice(0, 50); d.despesas = lista(d.despesas).slice(0, 60); lista(d.pedidos).concat(lista(d.despesas)).forEach(function (x) { x.historico = []; }); },
    ];
    var cortada = false, t = JSON.stringify({ contaId: String(contaId), data: d, lidoEm: lidoEm, cortada: false });
    for (var i = 0; t.length > max && i < passos.length; i++) { passos[i](); cortada = true; t = JSON.stringify({ contaId: String(contaId), data: d, lidoEm: lidoEm, cortada: true }); }
    return t.length > max ? null : { texto: t, cortada: cortada, tamanho: t.length };
  }
  /** A cópia guardada, se for desta conta e tiver o saldo; senão null. */
  function deGuardado(texto, contaId) {
    var o = null; try { o = JSON.parse(texto || 'null'); } catch (e) { o = null; }
    return o && o.contaId === String(contaId) && o.data && o.data.saldo ? { data: o.data, lidoEm: o.lidoEm, cortada: !!o.cortada } : null;
  }

  // ── Datas e números (texto AAAA-MM-DD; o dia vem do servidor) ──
  function mesDe(d) { return Number(String(d).slice(5, 7)) - 1; }
  function dm(d) { return D.textoDiaMes(d); }
  /** «qua 12 nov» · «17–18 dez» · «21 dez – 4 jan» (como o protótipo). */
  function intervalo(a, b) {
    if (!dia(a)) return '';
    if (!dia(b) || a === b) return D.textoDiaCurto(a);
    if (a.slice(0, 7) === b.slice(0, 7)) return Number(a.slice(8, 10)) + '–' + dm(b);
    return dm(a) + ' – ' + dm(b);
  }
  function eur(v) {
    var n = Math.round(num(v) * 100) / 100, s = Math.abs(n).toFixed(2).split('.'), int = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return (n < 0 ? '−' : '') + int + ',' + s[1] + ' €';
  }
  function dois(n) { return ('0' + n).slice(-2); }
  /** Um instante (ISO) na hora do telemóvel: «12 nov, 10:30» (com o ano, se não for o de `ano`). */
  function quando(iso, ano) {
    var d = new Date(iso); if (!iso || isNaN(d.getTime())) return '';
    var y = d.getFullYear(), txt = d.getDate() + ' ' + D.MESES_C[d.getMonth()] + (ano && y !== Number(ano) ? ' ' + y : '');
    return txt + ', ' + dois(d.getHours()) + ':' + dois(d.getMinutes());
  }
  /** «das 08:12» (hoje) ou «de ter 10 nov, 08:12»: a hora da cópia guardada. */
  function daCopia(lidoEm, agora) { return D.textoDados(lidoEm, agora || new Date()); }

  // ── Estados (os rótulos do computador; sempre escritos, nunca só a cor) ──
  function ehFerias(p) { return p && p.tipo === 'FERIAS'; }
  function presenca(p) { return !!p && PRESENCA.indexOf(p.tipo) >= 0; }
  /** { t, cls } da pílula de uma ausência. Férias: Pendente · Aprovado · Rejeitado · Cancelado. Faltas: Pendente · RH ·
      Aprovada · Rejeitada · Cancelada. Teletrabalho e Out of Office aprovados sozinhos: Registado. */
  function estadoAusencia(p) {
    var fer = ehFerias(p), e = p && p.estado;
    if (e === 'PENDING') return { t: fer ? 'Pendente' : (p.etapa === 'RH' ? 'Pendente · RH' : 'Pendente'), cls: 'ama' };
    if (e === 'APPROVED') return p.registado ? { t: 'Registado', cls: 'nav' } : { t: fer ? 'Aprovado' : 'Aprovada', cls: 'pos' };
    if (e === 'REJECTED') return { t: fer ? 'Rejeitado' : 'Rejeitada', cls: 'neg' };
    return { t: fer ? 'Cancelado' : 'Cancelada', cls: '' };
  }
  /** Quem decide (pendente) ou decidiu: «decide Teresa Lobo» / «aguarda o RH». */
  function etapaTexto(p) {
    if (!p || p.estado !== 'PENDING') return '';
    if (p.etapa === 'DEPT') return 'decide ' + (p.decideNome || 'a tua chefia');
    if (p.etapa === 'RH') return 'aguarda o RH';
    return '';
  }
  var ESTADO_DESPESA = { PENDENTE: { t: 'Pendente', cls: 'nav' }, IMPRESSA: { t: 'Aguarda assinatura', cls: 'ama' }, PAGA: { t: 'Paga', cls: 'pos' }, ANULADA: { t: 'Anulada', cls: '' } };
  function estadoDespesa(x) { return ESTADO_DESPESA[x && x.estado] || ESTADO_DESPESA.PENDENTE; }

  // ── O resumo do saldo ──
  /** A barra de três troços: { goz, mar, pen, liv } em percentagem da barra (o direito; acima dele, o total). */
  function barra(s) {
    var goz = Math.max(num(s.gozados), 0), mar = Math.max(num(s.marcados), 0), pen = Math.max(num(s.pendentes), 0), liv = Math.max(num(s.livres), 0);
    var tot = Math.max(num(s.direito), goz + mar + pen, 1), pc = function (n) { return Math.round(n / tot * 1000) / 10; };
    return { goz: pc(goz), mar: pc(mar), pen: pc(pen), n: { goz: goz, mar: mar, pen: pen, liv: liv },
      aria: pl(goz, 'gozado', 'gozados') + ', ' + pl(mar, 'marcado', 'marcados') + ' e ainda por gozar, ' + pl(pen, 'pendente', 'pendentes') + ', ' + pl(liv, 'livre', 'livres') };   // plurais certos (revisão de 029ccb2a)
  }
  function resumoSaldo(d) {
    var s = d.saldo || {}, por = num(s.porMarcar), pen = num(s.pendentes), liv = num(s.livres);
    return { ano: num(s.ano) || num(d.ano), n: por, unidade: por === 1 || por === -1 ? 'dia' : 'dias',
      sub: 'por marcar · ' + pen + ' em pedidos pendentes · ' + Math.max(liv, 0) + ' livres para pedir',
      prox: s.proxAno && num(s.proxAno.dias) ? 'E ' + pl(num(s.proxAno.dias), 'dia', 'dias') + ' em ' + s.proxAno.ano + ', fora destas contas.' : '' };
  }
  /** As linhas «de onde vêm os dias» do ecrã Férias (como o protótipo; os zeros que não dizem nada ficam de fora). */
  function contasSaldo(d) {
    var s = d.saldo || {}, a = num(s.ano) || num(d.ano), l = [['Direito de ' + a, pl(num(s.direitoAno), 'dia', 'dias')]];
    if (num(s.transitados)) l.push(['Transitados de ' + (a - 1), '+' + num(s.transitados)]);
    l.push(['Dias ganhos', String(num(s.diasGanhos))]);
    if (num(s.descontoAnterior)) l.push(['Gozados a mais em ' + (a - 1), '−' + num(s.descontoAnterior)]);
    l.push(['Total', pl(num(s.direito), 'dia', 'dias')]);
    l.push(['Por marcar', num(s.porMarcar) + (num(s.pendentes) ? ' (dos quais ' + num(s.pendentes) + ' em pedidos pendentes)' : '')]);
    return l;
  }

  // ── As listas ──
  function pedidosFerias(d) { return lista(d.pedidos).filter(ehFerias); }
  function faltas(d) { return lista(d.pedidos).filter(function (p) { return !ehFerias(p); }); }
  function porInicio(a, b) { return String(a.inicio).localeCompare(String(b.inicio)) || String(a.id).localeCompare(String(b.id)); }
  /** Os pedidos de férias por vir (aprovados ou pendentes que ainda não acabaram), do mais próximo. */
  function feriasASeguir(d) { var h = d.hoje; return pedidosFerias(d).filter(function (p) { return (p.estado === 'APPROVED' || p.estado === 'PENDING') && dia(p.fim) && p.fim >= h; }).sort(porInicio); }
  /** «Os meus pedidos» do ecrã Férias: 'seguir' (por vir) ou 'todos' (do mais recente). */
  function feriasLista(d, filtro) { return filtro === 'todos' ? pedidosFerias(d).slice().sort(function (a, b) { return -porInicio(a, b); }) : feriasASeguir(d); }
  /** À espera de decisão: os pendentes, férias e faltas (do mais próximo). */
  function esperaDecisao(d) { return lista(d.pedidos).filter(function (p) { return p.estado === 'PENDING'; }).sort(porInicio); }
  /** Os feriados nacionais (feriados.js) e os fechos da empresa (os da resposta) depois de hoje: [{ inicio, fim, nome, fecho }]. */
  function feriadosEFechos(d, feriados, n) {
    var h = d.hoje, l = [];
    Object.keys(feriados || {}).forEach(function (k) { if (dia(k) && k > h) l.push({ inicio: k, fim: k, nome: String(feriados[k]), fecho: false }); });
    lista(d.fechos).forEach(function (f) { if (dia(f.inicio) && dia(f.fim) && f.fim > h) l.push({ inicio: f.inicio, fim: f.fim, nome: f.nome ? 'Fecho da empresa · ' + f.nome : 'Fecho da empresa', fecho: true }); });
    l.sort(function (a, b) { return a.inicio.localeCompare(b.inicio) || (a.fecho === b.fecho ? 0 : (a.fecho ? 1 : -1)); });
    var ate = (Number(String(h).slice(0, 4)) + 1) + '-12-31';   // até ao fim do ano seguinte (os fechos que o servidor dá)
    l = l.filter(function (x) { return x.inicio <= ate; });
    return n ? l.slice(0, n) : l;
  }
  /** O que vem a seguir: o próximo pedido de férias e o próximo feriado ou fecho. */
  function aSeguir(d, feriados) { return { pedido: feriasASeguir(d)[0] || null, feriado: feriadosEFechos(d, feriados, 1)[0] || null }; }
  /** A falta toca este mês (AAAA-MM)? Uma que atravessa o mês conta nos dois, como no calendário do computador. */
  function tocaMes(p, m) { return dia(p.inicio) && dia(p.fim) && p.inicio.slice(0, 7) <= m && p.fim.slice(0, 7) >= m; }
  /** As faltas e ausências deste mês (o de hoje): quantas faltas e quantas «fora do escritório». Contam as activas, como a
      folha MOD.67 do computador (printAbsenceCommunicationSheet): nem as canceladas nem as rejeitadas (revisão P6). */
  function faltasDoMes(d) {
    var m = String(d.hoje).slice(0, 7), l = faltas(d).filter(function (p) { return tocaMes(p, m) && p.estado !== 'CANCELLED' && p.estado !== 'REJECTED'; });
    var nP = l.filter(presenca).length;
    return { mes: MESES_L[mesDe(d.hoje)] || '', faltas: l.length - nP, fora: nP };
  }
  /** As faltas por mês: 'mes' (o de hoje) ou 'ano' (todas as do ano). [{ mes: 'Novembro', itens }], do mais recente. */
  function faltasPorMes(d, filtro) {
    var m = String(d.hoje).slice(0, 7), grupos = [], por = {};
    faltas(d).filter(function (p) { return filtro === 'ano' || tocaMes(p, m); })
      .sort(function (a, b) { return -porInicio(a, b); })
      .forEach(function (p) { var k = filtro === 'ano' ? String(p.inicio).slice(0, 7) : m; if (!por[k]) { por[k] = { mes: (MESES_L[mesDe(k + '-01')] || '') + (k.slice(0, 4) !== String(d.ano) ? ' de ' + k.slice(0, 4) : ''), itens: [] }; grupos.push(por[k]); } por[k].itens.push(p); });
    return grupos;
  }
  /** O detalhe de uma falta numa frase: o motivo (Doença: «Consulta/Cirurgia»), o modo do Out of Office, as horas. */
  var MODO_OO = { OBRA: 'Obra', VISITAS: 'Visitas a clientes', SEDE: 'Sede DOE' };
  function detalheFalta(p, d) {
    var partes = [];
    if (p.tipo === 'OUT_OFFICE') {
      var oo = p.outOffice || {};
      if (MODO_OO[oo.modo]) partes.push(MODO_OO[oo.modo]);
    } else if (p.motivo) partes.push(p.motivo);
    if (p.horasCompleto === false && p.horaInicio && p.horaFim) partes.push(p.horaInicio + '–' + p.horaFim);
    return partes.join(' · ');
  }
  /** Para onde foi um Out of Office, em texto (as obras e as visitas pelos nomes da resposta; senão o resumo `motivo`). */
  function destinoOutOffice(p, d) {
    var oo = p.outOffice || {}, obras = lista(d.obras), emp = lista(d.visitas && d.visitas.empresas);
    if (oo.modo === 'OBRA') { var os = lista(oo.obras).map(function (id) { var o = obras.filter(function (x) { return x.id === id; })[0]; return o ? (o.codigo ? o.codigo + ' — ' : '') + o.nome : ''; }).filter(Boolean); if (os.length) return os.join('; '); }
    if (oo.modo === 'VISITAS') {
      var vs = lista(oo.visitas).map(function (v) { var e = emp.filter(function (x) { return x.id === v.clienteId; })[0], c = e ? lista(e.contactos).filter(function (x) { return x.id === v.contactoId; })[0] : null; return e ? e.nome + (c ? ' (' + c.nome + ')' : '') : ''; }).filter(Boolean);
      if (vs.length) return vs.join('; ');
    }
    if (oo.modo === 'SEDE') return 'Sede DOE';
    return p.motivo || '';
  }
  /** As despesas por grupo: 'reemb' (pendentes; por assinar, por folha), 'pagas' (por folha) ou 'anuladas'. */
  function despesasGrupos(d, filtro) {
    var l = lista(d.despesas), g = [], porFolha = function (est, rot) {
      var por = {};
      l.filter(function (x) { return x.estado === est; }).forEach(function (x) { var k = x.folha || ''; if (!por[k]) { por[k] = { titulo: rot + (k ? ' · folha ' + k : ''), itens: [] }; g.push(por[k]); } por[k].itens.push(x); });
    };
    if (filtro === 'pagas') porFolha('PAGA', 'Pagas');
    else if (filtro === 'anuladas') { var an = l.filter(function (x) { return x.estado === 'ANULADA'; }); if (an.length) g.push({ titulo: 'Anuladas', itens: an }); }
    else {
      var pe = l.filter(function (x) { return x.estado === 'PENDENTE'; });
      if (pe.length) g.push({ titulo: 'Pendentes · entram na próxima folha', itens: pe });
      porFolha('IMPRESSA', 'Aguardam assinatura');
    }
    return g;
  }
  /** A imputação curta para a linha: «PHX — Phoenix» em vez de «Obra — PHX — Phoenix». */
  function imputCurta(x) { return String(x.imputRotulo || '').replace(/^Obra — /, '').replace(/^Departamento — /, ''); }

  // ── A grelha do ano (12 meses × 31 dias), dia a dia: como o servidor conta o gozado (até ontem) ──
  /** [{ mes, rot, dias: [{ d, cls }] }]: cls ∈ x (não existe), fs, fer, fec, goz, mar, pen, '' (útil livre); hoje à parte. */
  function anoGrelha(d, feriados) {
    var ano = Number(d.ano), h = d.hoje, fer = feriados || {}, peds = pedidosFerias(d).filter(function (p) { return (p.estado === 'APPROVED' || p.estado === 'PENDING') && dia(p.inicio) && dia(p.fim); });
    var fechos = lista(d.fechos).filter(function (f) { return dia(f.inicio) && dia(f.fim); });
    var meses = [], conta = { goz: 0, mar: 0, pen: 0 };
    for (var m = 0; m < 12; m++) {
      var l = { mes: m, rot: D.MESES_C[m], dias: [] };
      for (var k = 1; k <= 31; k++) {
        var s = ano + '-' + dois(m + 1) + '-' + dois(k);
        if (Number(D.somarDias(s, 0).slice(5, 7)) !== m + 1) { l.dias.push({ d: s, cls: 'x' }); continue; }   // 30 fev passa a março: não existe
        var c = '', util = !D.fimDeSemana(s) && !fer[s];
        if (D.fimDeSemana(s)) c = 'fs'; else if (fer[s]) c = 'fer';
        if (fechos.some(function (f) { return s >= f.inicio && s <= f.fim; }) && util) c = 'fec';
        if (util) peds.forEach(function (p) { if (s >= p.inicio && s <= p.fim) { if (p.estado === 'APPROVED') c = s < h ? 'goz' : 'mar'; else if (c !== 'goz' && c !== 'mar') c = 'pen'; } });
        if (conta[c] != null) conta[c]++;
        l.dias.push({ d: s, cls: c, hoje: s === h });
      }
      meses.push(l);
    }
    return { meses: meses, conta: conta, aria: 'Férias de ' + ano + ', dia a dia: ' + conta.goz + ' dias gozados, ' + conta.mar + ' marcados e ainda por gozar, ' + conta.pen + ' pendentes.' };
  }

  return {
    ROTA: ROTA, RECUSA: RECUSA, CODIGOS_RECUSA: CODIGOS_RECUSA, EM_BREVE: EM_BREVE, MESES_L: MESES_L, LS_PESSOAL: LS_PESSOAL, LIMITE_COPIA: LIMITE_COPIA,
    lerPessoal: lerPessoal, falha: falha, temFuncionalidade: temFuncionalidade, recusaDe: recusaDe, RECUSA_PASSAGEIRA: RECUSA_PASSAGEIRA, SEM_CONFIRMAR: SEM_CONFIRMAR,
    paraGuardar: paraGuardar, deGuardado: deGuardado, tocaMes: tocaMes,
    intervalo: intervalo, eur: eur, quando: quando, daCopia: daCopia,
    ehFerias: ehFerias, presenca: presenca, estadoAusencia: estadoAusencia, etapaTexto: etapaTexto, estadoDespesa: estadoDespesa,
    barra: barra, resumoSaldo: resumoSaldo, contasSaldo: contasSaldo, pl: pl,
    pedidosFerias: pedidosFerias, faltas: faltas, feriasASeguir: feriasASeguir, feriasLista: feriasLista, esperaDecisao: esperaDecisao,
    feriadosEFechos: feriadosEFechos, aSeguir: aSeguir, faltasDoMes: faltasDoMes, faltasPorMes: faltasPorMes,
    detalheFalta: detalheFalta, destinoOutOffice: destinoOutOffice, despesasGrupos: despesasGrupos, imputCurta: imputCurta,
    anoGrelha: anoGrelha,
  };
}));
