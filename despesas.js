/* DOE · Telemóvel — o Pessoal, fase 3 (23 nov 2026): registar, corrigir, anular, marcar «Paga» e desfazer «Paga» as
   despesas da própria pessoa. Lógica pura (sem DOM), UMD como ausencias.js (self.DoeMovelDesp no browser, require em Node),
   testada em Node e contra a simulação do servidor (movel/teste/api-pessoal-simulada.js, `opcoes.despesas`). Contrato:
   docs/analises/Movel-Pessoal-Contrato.md, decisão 4, 1.2, 1.4, 2.3 («POST /movel/pessoal/despesas»), 2.4 e «Fase 3».
   Regras que esta lógica cumpre:
   - as escritas são COMANDOS sobre UMA despesa (`accao` registar | corrigir | anular | paga | despagar), com o `id` gerado
     aqui ao registar e um `pedidoId` por intenção da pessoa (o mesmo em cada repetição); os outros levam a `versao` que a
     pessoa viu (o servidor responde 409 MUDOU se a despesa mudou entretanto). Nunca a lista inteira;
   - vão na fila ÚNICA da casca (IndexedDB «doeMovelDiario», itens com tipo 'desp'), por conta; sem rede ficam «por enviar»
     e seguem sozinhos; uma página antiga não os conhece e não os apaga;
   - o que se pode fazer decide-o o SERVIDOR (o `pode` de cada despesa); a página não tem segunda regra. Corrigir uma despesa
     que já foi para a folha (IMPRESSA ou PAGA) pede uma confirmação antes de enviar e leva `confirmouFolha: true`; o
     409 JA_NA_FOLHA do servidor leva à mesma confirmação;
   - SEM fotos de talão (decisão do Pedro): `faturaPapel` é só sim/não, como no computador;
   - um 409 ou um 403 não se repete: fica parado com o motivo do servidor até a pessoa «Mudar» (um pedidoId novo),
     confirmar ou «Desistir»; um 429, um 503, a falta de rede e uma Edge sem a rota repetem-se sozinhos;
   - as datas são texto AAAA-MM-DD; o valor escreve-se com vírgula (12,50) e vai em número com 2 casas. */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica(require('./diario.js'), require('./pessoal.js'));
  else raiz.DoeMovelDesp = fabrica(raiz.DoeMovelDiario, raiz.DoeMovelPessoal);
}(typeof self !== 'undefined' ? self : this, function (D, P) {
  'use strict';
  var ROTA = '/movel/pessoal/despesas', FUNC = 'despesas';
  var LIMITES = { categoria: 60, notas: 300, motivo: 300, valorMax: 999999.99 };   // os de regrasDespesas.js (LIMITES_DESPESA)
  var RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
  // As sugestões do computador (a datalist «exp-cat-suggestions» de despesas-ajudas-custo.js), pela mesma ordem.
  var CATEGORIAS = ['Refeição', 'Alojamento', 'Combustível', 'Portagens', 'Estacionamento', 'Bilhete comboio', 'Material', 'Outro'];
  var IMPUT = { PROJETO: 'Obra', DEPARTAMENTO: 'Departamento' };
  var ACCOES = ['registar', 'corrigir', 'anular', 'paga', 'despagar'];
  function copia(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function lista(v) { return Array.isArray(v) ? v : []; }
  function dia(v) { return typeof v === 'string' && RE_DIA.test(v) ? v : null; }
  function txt(v) { return String(v == null ? '' : v).trim(); }
  function uuid(novoId) { return String(novoId ? novoId() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9_-]/g, ''); }
  function novoIdDesp(novoId) { return ('desp-' + uuid(novoId)).slice(0, 64); }
  function novoPedidoId(novoId) { return ('ped-' + uuid(novoId)).slice(0, 64); }
  /** O servidor dá os comandos das despesas a esta conta? (`despesas` nas funcionalidades; sem ela, as despesas só se lêem) */
  function disponivel(funcs) { return lista(funcs).indexOf(FUNC) >= 0; }

  // ── O valor (texto do campo ↔ número com 2 casas) ──
  /** «12,5» · «12.50» · «1 068» · «12,50 €» → 12.5 · 12.5 · 1068 · 12.5; o que não é um valor de euros → NaN. */
  function lerValor(s) {
    var t = String(s == null ? '' : s).replace(/[\s €]/g, '');
    if (!/^\d+([.,]\d{1,2})?$/.test(t)) return NaN;
    return Math.round(Number(t.replace(',', '.')) * 100) / 100;
  }
  /** 12.5 → «12,50» (o que o campo mostra ao corrigir). */
  function valorTexto(n) { var v = Number(n); return Number.isFinite(v) && v > 0 ? v.toFixed(2).replace('.', ',') : ''; }

  // ── A imputação (obra ou departamento) com os nomes da leitura ──
  /** O texto do computador (expenseImputLabel): «Obra — PHX — Phoenix» · «Departamento — Gestão de Projeto» · ''. */
  function imputRotulo(tipo, id, d) {
    if (!tipo || !id) return '';
    if (tipo === 'DEPARTAMENTO') { var dp = lista(d && d.departamentos).filter(function (x) { return x.codigo === id; })[0]; return 'Departamento — ' + (dp ? dp.nome : id); }
    var o = lista(d && d.obras).filter(function (x) { return x.id === id; })[0];
    return 'Obra — ' + (o ? (o.codigo || '') + ' — ' + (o.nome || '') : id);
  }
  /** As obras que se podem escolher: as da leitura (o servidor já tira as arquivadas, fechadas e concluídas; as pausadas
      ficam, como no computador). */
  function obrasImput(d) { return lista(d && d.obras); }

  // ── O formulário (um rascunho em memória; ao corrigir, vem da despesa) ──
  function formNovo(hoje) {
    return { accao: 'registar', id: '', versao: '', data: dia(hoje) || '', categoria: '', valor: '', imputModo: 'PROJETO', imputTipo: '', imputId: '', faturaPapel: false, notas: '', folha: '' };
  }
  function formDoRegisto(x) {
    var f = formNovo(x.data);
    f.accao = 'corrigir'; f.id = x.id; f.versao = x.versao || ''; f.categoria = x.categoria || ''; f.valor = valorTexto(x.valor);
    f.imputTipo = x.imputTipo === 'DEPARTAMENTO' || x.imputTipo === 'PROJETO' ? x.imputTipo : ''; f.imputId = f.imputTipo ? (x.imputId || '') : '';
    if (!f.imputId) f.imputTipo = '';
    f.imputModo = f.imputTipo || 'PROJETO'; f.faturaPapel = !!x.faturaPapel; f.notas = x.notas || ''; f.folha = x.folha || '';
    f.imputRotuloAntes = x.imputRotulo || '';
    f.base = baseDe(x);   // o que a pessoa leu: corrigir manda só o que ela mudou em relação a isto
    return f;
  }
  /** «Mudar» um comando que não entrou (ou que ainda não saiu). Num corrigir com a despesa de AGORA (a cópia, que o 409
      MUDOU ou JA_NA_FOLHA já acertou com `details.registo`): parte dela e põe por cima só os campos que a pessoa mudou;
      `servidorMudou` diz o que mudou entretanto (revisão da F3, C2: antes o formulário voltava com os valores velhos e o
      reenvio desfazia em silêncio a correcção do computador). Sem isso (registar, ou um item antigo sem `base`): o que tinha. */
  function formDoItem(q, registo) {
    if (q.accao === 'corrigir' && registo && q.base) {
      var g = formDoRegisto(registo), c0 = q.campos || {};
      aplicarCamposAoForm(g, c0);
      g.servidorMudou = diferencas(q.base, baseDe(registo));
      g.deItem = q.id;
      return g;
    }
    var c = q.campos || {}, f = formNovo(c.data);
    f.accao = q.accao === 'corrigir' ? 'corrigir' : 'registar'; f.id = q.registoId; f.versao = registo ? (registo.versao || '') : (q.versao || '');
    f.categoria = c.categoria || ''; f.valor = valorTexto(c.valor);
    f.imputTipo = c.imputTipo || ''; f.imputId = c.imputTipo ? (c.imputId || '') : ''; f.imputModo = f.imputTipo || 'PROJETO';
    f.faturaPapel = !!c.faturaPapel; f.notas = c.notas || ''; f.folha = registo ? (registo.folha || '') : '';
    f.imputRotuloAntes = registo ? (registo.imputRotulo || '') : '';
    f.deItem = q.id;
    return f;
  }
  /** O que falta para gravar. → { campo, texto } ou null. */
  function faltaNoForm(f) {
    if (!dia(f.data)) return { campo: 'data', texto: 'Escolhe a data da despesa.' };
    var cat = txt(f.categoria);
    if (!cat) return { campo: 'categoria', texto: 'Escolhe ou escreve a categoria.' };
    if (cat.length > LIMITES.categoria) return { campo: 'categoria', texto: 'A categoria tem mais de ' + LIMITES.categoria + ' caracteres.' };
    var v = lerValor(f.valor);
    if (!txt(f.valor)) return { campo: 'valor', texto: 'Escreve o valor.' };
    if (!Number.isFinite(v)) return { campo: 'valor', texto: 'Escreve o valor em euros, com até 2 casas decimais (ex.: 12,50).' };
    if (!(v > 0)) return { campo: 'valor', texto: 'O valor tem de ser maior do que zero.' };
    if (v > LIMITES.valorMax) return { campo: 'valor', texto: 'O valor é demasiado alto (no máximo 999 999,99 €).' };
    if (f.imputTipo && !f.imputId) return { campo: 'imput', texto: 'Escolhe a obra ou o departamento.' };
    if (txt(f.notas).length > LIMITES.notas) return { campo: 'notas', texto: 'As observações têm mais de ' + LIMITES.notas + ' caracteres.' };
    return null;
  }
  /** Os campos de uma despesa que o comando escreve, na forma do comando: { data, categoria, valor, imputTipo, imputId,
      faturaPapel, notas } (a imputação vazia é null). Serve de BASE: o que a pessoa leu. */
  function baseDe(x) {
    x = x || {};
    var it = (x.imputTipo === 'DEPARTAMENTO' || x.imputTipo === 'PROJETO') && x.imputId ? x.imputTipo : null;
    return { data: x.data || '', categoria: String(x.categoria || ''), valor: Math.round((Number(x.valor) || 0) * 100) / 100, imputTipo: it, imputId: it ? x.imputId : null, faturaPapel: !!x.faturaPapel, notas: String(x.notas || '') };
  }
  /** O formulário inteiro na forma do comando. */
  function camposTodos(f) {
    var temImp = !!(f.imputTipo && f.imputId);
    return { data: f.data, categoria: txt(f.categoria), valor: lerValor(f.valor), imputTipo: temImp ? f.imputTipo : null, imputId: temImp ? f.imputId : null, faturaPapel: !!f.faturaPapel, notas: txt(f.notas) };
  }
  var CAMPOS = ['data', 'categoria', 'valor', 'imputacao', 'faturaPapel', 'notas'];
  function valorDe(b, k) { return k === 'imputacao' ? (b.imputTipo ? b.imputTipo + ':' + b.imputId : '') : (b[k] == null ? '' : b[k]); }
  /** O que difere entre duas bases: [{ campo, antes, depois }] (a imputação é um campo só: tipo e alvo juntos). */
  function diferencas(a, b) {
    if (!a || !b) return [];
    return CAMPOS.filter(function (k) { return valorDe(a, k) !== valorDe(b, k); }).map(function (k) {
      return { campo: k, antes: k === 'imputacao' ? { imputTipo: a.imputTipo, imputId: a.imputId } : a[k], depois: k === 'imputacao' ? { imputTipo: b.imputTipo, imputId: b.imputId } : b[k] };
    });
  }
  /** Os campos do comando (a lista fechada do contrato, 2.3). Ao registar vão todos os preenchidos. Ao corrigir vão SÓ os
      que a pessoa mudou em relação ao que leu (`f.base`, ou o.base): o servidor deixa como está um campo ausente (revisão
      da F3, C1: mandar o formulário inteiro, depois de um 409 com a versão de agora, desfazia a correcção do computador).
      A imputação tirada vai a null; as observações apagadas vão ''. */
  function camposDe(f, o) {
    o = o || {};
    var t = camposTodos(f), x = {}, base = o.base || f.base;
    if (f.accao === 'corrigir' && base) {
      diferencas(base, t).forEach(function (d) { if (d.campo === 'imputacao') { x.imputTipo = t.imputTipo; x.imputId = t.imputId; } else x[d.campo] = t[d.campo]; });
    } else if (f.accao === 'corrigir') {
      x = t;
    } else {
      x = { data: t.data, categoria: t.categoria, valor: t.valor };
      if (t.imputTipo) { x.imputTipo = t.imputTipo; x.imputId = t.imputId; }
      x.faturaPapel = t.faturaPapel;
      if (t.notas) x.notas = t.notas;
    }
    if (o.confirmouFolha) x.confirmouFolha = true;
    return x;
  }
  /** Os campos de um corrigir que mudam alguma coisa (sem a confirmação da folha). */
  function temMudancas(c) { return Object.keys(c || {}).some(function (k) { return k !== 'confirmouFolha'; }); }
  /** Põe no formulário os campos de um comando (só os que lá estão). */
  function aplicarCamposAoForm(f, c) {
    if (c.data !== undefined) f.data = c.data;
    if (c.categoria !== undefined) f.categoria = c.categoria;
    if (c.valor !== undefined) f.valor = valorTexto(c.valor);
    if (c.imputTipo !== undefined || c.imputId !== undefined) { f.imputTipo = c.imputTipo || ''; f.imputId = c.imputTipo ? (c.imputId || '') : ''; if (f.imputTipo) f.imputModo = f.imputTipo; }
    if (c.faturaPapel !== undefined) f.faturaPapel = !!c.faturaPapel;
    if (c.notas !== undefined) f.notas = c.notas || '';
    return f;
  }
  /** O que um corrigir vai mudar na despesa de AGORA: [{ campo, antes (agora), depois (o da pessoa) }]. */
  function vaiMudar(campos, registo) {
    var agora = baseDe(registo), depois = Object.assign({}, agora);
    Object.keys(campos || {}).forEach(function (k) { if (k !== 'confirmouFolha') depois[k] = campos[k]; });
    if (campos && campos.imputTipo !== undefined && !campos.imputTipo) depois.imputId = null;
    return diferencas(agora, depois);
  }
  var ROT_CAMPO = { data: 'Data', categoria: 'Categoria', valor: 'Valor', imputacao: 'Imputar a', faturaPapel: 'Fatura em papel', notas: 'Observações' };
  /** Um valor de um campo, para ler: «12,50 €», «ter 10 nov», «Obra — PHX — Phoenix», «Sim». */
  function textoValor(campo, v, d) {
    if (campo === 'valor') return P.eur(v);
    if (campo === 'data') return dia(v) ? D.textoDiaCurto(v) : '—';
    if (campo === 'imputacao') return v && v.imputTipo ? imputRotulo(v.imputTipo, v.imputId, d) : 'Sem imputação';
    if (campo === 'faturaPapel') return v ? 'Sim' : 'Não';
    return String(v == null ? '' : v) || '—';
  }
  /** «Valor: 14,00 € → 41,00 €». */
  function textoDiferenca(x, d) { return (ROT_CAMPO[x.campo] || x.campo) + ': ' + textoValor(x.campo, x.antes, d) + ' → ' + textoValor(x.campo, x.depois, d); }
  /** A despesa foi para a folha (Aguarda assinatura ou Paga)? Corrigi-la pede confirmação (decisão 4). */
  function naFolha(x) { return !!x && (x.estado === 'IMPRESSA' || x.estado === 'PAGA'); }
  /** O texto do aviso (o de 2.4, com a referência da folha quando se sabe). */
  function textoFolha(ref) { return 'Esta despesa foi para a folha' + (ref ? ' ' + ref : '') + '. A folha em papel não muda: confirma para gravar.'; }
  /** O formulário muda alguma coisa na despesa? (para não mandar um corrigir vazio) */
  function mudou(f, x) { return !x || diferencas(baseDe(x), camposTodos(f)).length > 0; }

  // ── A fila (itens com tipo 'desp') ──
  /** Um item da fila para um comando. o: { accao, registo (a despesa de agora, menos ao registar), form, motivo (anular),
      confirmouFolha, contaId, contaNome, novoId, agora, adiarMs (o Desfazer), id (a despesa, ao registar: gerada se faltar) }. */
  function itemComando(o) {
    var agora = o.agora || new Date(), r = o.registo || null, f = o.form || null, accao = o.accao;
    var base = accao === 'corrigir' ? (r ? baseDe(r) : (f && f.base) || null) : null;
    var campos = accao === 'registar' || accao === 'corrigir' ? camposDe(f, { confirmouFolha: o.confirmouFolha, base: base }) : (accao === 'anular' ? { motivo: txt(o.motivo) } : {});
    var registoId = accao === 'registar' ? (o.id || (f && f.id) || novoIdDesp(o.novoId)) : String((r && r.id) || (f && f.id) || '');
    return { id: 'q-' + uuid(o.novoId), tipo: 'desp', estado: 'a-enviar', contaId: String(o.contaId || ''), contaNome: String(o.contaNome || ''),
      registoId: registoId, accao: accao, campos: campos, pedidoId: novoPedidoId(o.novoId), versao: accao === 'registar' ? '' : String((r && r.versao) || (f && f.versao) || ''),
      resumo: resumoDe(accao === 'registar' ? campos : (accao === 'corrigir' ? Object.assign({}, r || {}, campos) : r)), folha: (r && r.folha) || '', base: base,
      criadoEm: agora.toISOString(), adiadoAte: o.adiarMs ? new Date(agora.getTime() + o.adiarMs).toISOString() : '', tentou: false,
      resposta: null, registo: null, erro: '', code: '', details: null, avisos: [], fotos: [] };
  }
  function resumoDe(x) { if (!x) return ''; var p = []; if (x.categoria) p.push(x.categoria); if (Number(x.valor) > 0) p.push(P.eur(x.valor)); if (dia(x.data)) p.push(D.textoDiaCurto(x.data)); return p.join(' · '); }
  /** O corpo do POST /movel/pessoal/despesas: { accao, pedidoId, id, versao?, …campos }. */
  function corpoComando(q) {
    var c = { accao: q.accao, pedidoId: q.pedidoId, id: q.registoId };
    if (q.accao !== 'registar') c.versao = q.versao;
    Object.keys(q.campos || {}).forEach(function (k) { c[k] = copia(q.campos[k]); });
    return c;
  }
  /** A despesa que nasce no telemóvel (o registar por enviar), para se ver logo; a resposta do servidor substitui-a. */
  function registoProvisorio(q, d) {
    var c = q.campos || {}, it = c.imputTipo || null;
    return { id: q.registoId, data: c.data, categoria: c.categoria || '', valor: Number(c.valor) || 0, imputTipo: it, imputId: it ? c.imputId : null, imputRotulo: imputRotulo(it, c.imputId, d),
      faturaPapel: !!c.faturaPapel, notas: c.notas || '', estado: 'PENDENTE', folha: null, pagaEm: null, anulada: null,
      historico: [{ em: q.criadoEm, texto: 'Por enviar (telemóvel)' }], versao: '', pode: [], porEnviar: true, filaId: q.id };
  }
  /** A folha da despesa continua aberta (outra despesa minha da mesma folha ainda por pagar)? A regra de _expenseFolhaAberta,
      sobre as despesas da leitura (só as da pessoa; a folha é sempre de uma pessoa). */
  function folhaAberta(x, d) { return !!x.folha && lista(d && d.despesas).some(function (y) { return y.id !== x.id && y.folha === x.folha && y.estado !== 'PAGA' && y.estado !== 'ANULADA'; }); }
  /** A despesa como fica com um comando por enviar (para se ver logo, sem acções até o servidor responder). */
  function aplicarLocal(x, q, d) {
    var r = copia(x), c = q.campos || {};
    if (q.accao === 'corrigir') {
      ['data', 'categoria', 'notas'].forEach(function (k) { if (c[k] !== undefined) r[k] = c[k]; });
      if (c.valor !== undefined) r.valor = Number(c.valor) || 0;
      if (c.faturaPapel !== undefined) r.faturaPapel = !!c.faturaPapel;
      if (c.imputTipo !== undefined) { r.imputTipo = c.imputTipo || null; r.imputId = c.imputTipo ? c.imputId : null; r.imputRotulo = imputRotulo(r.imputTipo, r.imputId, d); }
    } else if (q.accao === 'anular') { r.estado = 'ANULADA'; r.anulada = { motivo: c.motivo || '', em: q.criadoEm }; }
    else if (q.accao === 'paga') { r.estado = 'PAGA'; r.pagaEm = q.criadoEm; }
    else if (q.accao === 'despagar') { r.pagaEm = null; r.estado = x.folha && folhaAberta(x, d) ? 'IMPRESSA' : 'PENDENTE'; if (r.estado === 'PENDENTE') r.folha = null; }
    r.porEnviar = true; r.pode = []; r.filaId = q.id;
    return r;
  }
  /** Os itens da fila desta conta, das despesas, que ainda não foram entregues. */
  function meus(fila, contaId) { return lista(fila).filter(function (q) { return q && q.tipo === 'desp' && q.contaId === contaId && q.estado !== 'entregue'; }); }
  function parado(q) { return q.estado === 'parado'; }
  /** «Por reembolsar» (PENDENTE + IMPRESSA): { valor, n }. */
  function conta(l) { var s = { valor: 0, n: 0 }; lista(l).forEach(function (x) { if (x.estado === 'PENDENTE' || x.estado === 'IMPRESSA') { s.valor += Number(x.valor) || 0; s.n++; } }); s.valor = Math.round(s.valor * 100) / 100; return s; }
  /** O «por reembolsar» acertado pela diferença entre as duas listas (a leitura pode vir cortada: o total é o do servidor). */
  function porReembolsarAjustado(pr, antes, depois) {
    var a = conta(antes), b = conta(depois), r = copia(pr || { valor: 0, n: 0 });
    r.valor = Math.round(((Number(r.valor) || 0) + b.valor - a.valor) * 100) / 100; r.n = Math.max(0, (Number(r.n) || 0) + b.n - a.n);
    return r;
  }
  /** A leitura com os comandos por enviar por cima (por ordem). Os parados não mudam a despesa: marcam-na (`comErro`).
      → uma cópia de d, ou d se não há nada. */
  function comPendentes(d, fila, contaId) {
    var ms = meus(fila, contaId);
    if (!d || !ms.length) return d;
    var x = copia(d), porId = {};
    x.despesas = lista(x.despesas);
    var reindex = function () { porId = {}; x.despesas.forEach(function (p, j) { porId[p.id] = j; }); };
    reindex();
    ms.slice().sort(function (a, b) { return String(a.criadoEm).localeCompare(String(b.criadoEm)); }).forEach(function (q) {
      var i = porId[q.registoId];
      if (parado(q)) { if (i != null) { x.despesas[i].comErro = q.erro || 'Não entrou'; x.despesas[i].filaId = q.id; } return; }
      if (q.accao === 'registar') { if (i == null) { x.despesas.unshift(registoProvisorio(q, x)); reindex(); } return; }
      if (i != null) x.despesas[i] = aplicarLocal(x.despesas[i], q, x);
    });
    x.porReembolsar = porReembolsarAjustado(d.porReembolsar, lista(d.despesas), x.despesas);
    return x;
  }
  /** A despesa que o servidor devolveu (num comando aceite, ou a de agora num 409) entra na cópia, no lugar da antiga (ou à
      frente, se é nova), e o «por reembolsar» acerta-se pela diferença. Muda d e devolve-o. */
  function aplicarResposta(d, registo) {
    if (!d || !registo || !registo.id) return d;
    var antes = copia(lista(d.despesas)), l = lista(d.despesas), i = -1;
    l.forEach(function (p, j) { if (p.id === registo.id) i = j; });
    if (i >= 0) l[i] = copia(registo); else l.unshift(copia(registo));
    d.despesas = l;
    d.porReembolsar = porReembolsarAjustado(d.porReembolsar, antes, l);
    return d;
  }

  // ── Erros → o que fazer (2.4) ──
  var MENSAGENS = {
    JA_NA_FOLHA: textoFolha(''),
    MUDOU: 'Isto mudou entretanto (no computador ou noutro telemóvel). Revê e envia outra vez.',
    TRANSICAO_INVALIDA: 'Já não se pode fazer isto neste estado.',
    NAO_ENCONTRADO: 'Esta despesa já não existe nas tuas despesas.',
    ID_ALHEIO: 'Esta despesa é de outra pessoa.',
    ID_EM_USO: 'Esta despesa já existe noutra conta. Regista-a outra vez.',
    ID_INVALIDO: 'Erro interno da página (identificador). Avisa o escritório.',
    VALIDATION_ERROR: 'Há um campo por corrigir.',
    TEXTO_PERIGOSO: 'A categoria ou as observações têm uma parte que não posso gravar. Tira-a e envia outra vez.',
    SEM_PESSOAL: 'O Pessoal é só para quem tem conta na aplicação do computador.',
    CONTA_EXTERNA: 'Esta conta é externa: o Pessoal é só para quem trabalha na DOE.',
    SEM_PERFIL: 'A tua conta não está ligada a nenhuma pessoa activa no DOE. Pede à administração.',
    PAPEL_SEM_ESCRITA: 'O teu papel (só leitura) não tem o Pessoal.',
  };
  // «Mudar» resolve (o formulário com o que se tinha, ou outra vez com a versão de agora); os outros só «Desistir».
  var MUDAVEIS = { MUDOU: true, VALIDATION_ERROR: true, TEXTO_PERIGOSO: true, JA_NA_FOLHA: true };
  var PARAM = Object.keys(MENSAGENS);
  var A_PREPARAR = 'As despesas pelo telemóvel ainda estão a ser preparadas no servidor. Fica no telemóvel; tento mais tarde.';
  var CAMPO_TXT = { data: 'a data', categoria: 'a categoria', valor: 'o valor', imputTipo: 'a imputação', imputId: 'a obra ou o departamento', notas: 'as observações', motivo: 'o motivo', faturaPapel: 'a fatura em papel' };
  /** → { accao: 'parar'|'repetir'|'login', texto, code, details, mudar, confirmarFolha, longo, retryAfter, rede, revogado } */
  function mensagem(e) {
    var c = (e && e.code) || '', s = (e && e.status) || 0, m = (e && e.message) || '', dt = (e && e.details) || {};
    if (e && e.rede) return D.mensagemDiario(e);
    if (c === 'TOKEN_DE_AMBITO' || c === 'ROUTE_NOT_FOUND' || c === 'NOT_FOUND' || (s === 404 && !c)) return { accao: 'repetir', longo: true, recuada: true, code: c, texto: A_PREPARAR };
    if (c === 'PESSOAL_POR_INSTALAR') return { accao: 'repetir', longo: true, code: c, texto: A_PREPARAR };
    if (c === 'LIMITE_DIARIO') return { accao: 'repetir', longo: true, code: c, texto: 'Chegaste ao limite de ' + (dt.max || 50) + ' registos de despesas por dia. Fica no telemóvel; segue amanhã.' };
    if (PARAM.indexOf(c) >= 0) {
      var t = c === 'JA_NA_FOLHA' ? (m || textoFolha(dt.folha)) : (m || MENSAGENS[c]);
      if (c === 'VALIDATION_ERROR' && !m && dt.campo) t = 'Há um campo por corrigir (' + (CAMPO_TXT[dt.campo] || dt.campo) + ').';
      return { accao: 'parar', code: c, details: copia(dt), texto: t, mudar: !!MUDAVEIS[c], confirmarFolha: c === 'JA_NA_FOLHA' };
    }
    var x = D.mensagemDiario(e);
    if (x.accao === 'login' || x.accao === 'repetir') return x;
    if (s >= 500 || s === 429) return { accao: 'repetir', texto: 'O servidor está ocupado. Fica no telemóvel; tento outra vez.', retryAfter: (e && e.retryAfter) || 0 };
    return { accao: 'parar', code: c, details: copia(dt), texto: m || 'Não foi aceite.', mudar: false };
  }
  /** A despesa do servidor é a que este registar mandou? */
  function mesmaDespesa(c, r) {
    c = c || {};
    if (!r) return true;
    return r.data === c.data && String(r.categoria || '') === String(c.categoria || '') && Math.round(Number(r.valor) * 100) === Math.round(Number(c.valor) * 100)
      && String(r.imputTipo || '') === String(c.imputTipo || '') && String(r.imputTipo ? r.imputId : '') === String(c.imputTipo ? c.imputId : '')
      && !!r.faturaPapel === !!c.faturaPapel && String(r.notas || '') === String(c.notas || '');
  }
  function textoJaEntrou(r) { return 'Esta despesa já tinha entrado antes (' + resumoDe(r) + '): ficou o que está no servidor. O que mudaste não foi aplicado; corrige a despesa se for preciso.'; }
  /** Os avisos de uma resposta ({ campo, motivo, valor? }): só o que a pessoa precisa de saber. */
  function textoAviso(a) {
    if (!a) return '';
    if (a.motivo === 'ignorado' || a.motivo === 'campo-ignorado') return '';
    if (a.motivo === 'sem-alteracoes') return 'Nada mudou: a despesa já estava assim.';
    return '';
  }
  /** Leva um comando ao servidor (chamado pelo drenar da casca, item a item). Repetir é seguro: o mesmo pedidoId.
      → { estado: 'entregue'|'pendente'|'parar'|'login'|'alheio', mensagem, rede, retryAfter, longo, revogado, registo } */
  async function processar(item, deps) {
    if (deps.contaId && item.contaId && item.contaId !== deps.contaId()) return { estado: 'alheio', mensagem: 'Isto é de ' + (item.contaNome || 'outra conta') + '; só essa conta o pode enviar.' };
    if (deps.online && deps.online() === false) return { estado: 'pendente', rede: true, mensagem: D.mensagemDiario({ rede: true, online: false }).texto };
    // «tentou» fica: uma falha de rede DEPOIS de sair não prova que o pedido não chegou (o molde da F2). Daí em diante só se
    // repete com o MESMO pedidoId (sem «Mudar» nem «Apagar»).
    item.tentou = true; await deps.guardar(item);
    var x = await D.pedir(deps, 'POST', ROTA, corpoComando(item));
    // Um registar cujo id já está no servidor com outro conteúdo (a resposta do 1.º envio perdeu-se e a pessoa mudou-o
    // depois): o servidor devolve o que lá está, como `repetido` ou num 409 com `details.registo`. Fica o do servidor.
    var jaLa = item.accao === 'registar' && !x.ok && x.status === 409 && x.code !== 'JA_NA_FOLHA' && x.details && x.details.registo && x.details.registo.id === item.registoId ? x.details.registo : null;
    if (x.ok || jaLa) {
      var dt = jaLa ? { registo: jaLa, repetido: true, versao: jaLa.versao, avisos: [] } : (x.data || {});
      item.resposta = { versao: dt.versao || (dt.registo && dt.registo.versao) || '', repetido: !!dt.repetido };
      item.registo = dt.registo || null; item.avisos = lista(dt.avisos).map(textoAviso).filter(Boolean);
      item.jaEntrou = item.accao === 'registar' && !!dt.repetido && !!item.registo && !mesmaDespesa(item.campos, item.registo);
      if (item.jaEntrou) item.avisos.unshift(textoJaEntrou(item.registo));
      item.estado = 'entregue'; item.erro = ''; item.code = ''; item.details = null;
      await deps.guardar(item);
      return { estado: 'entregue', registo: item.registo, avisos: item.avisos, jaEntrou: item.jaEntrou };
    }
    var m = mensagem(x);
    if (m.accao === 'parar') {
      item.estado = 'parado'; item.erro = m.texto; item.code = m.code || ''; item.details = m.details || null; item.mudar = !!m.mudar; item.confirmarFolha = !!m.confirmarFolha;
      if (m.confirmarFolha && m.details && m.details.folha) item.folha = m.details.folha;
      await deps.guardar(item); return { estado: 'parar', mensagem: m.texto, code: m.code };
    }
    if (m.accao === 'login') { await deps.guardar(item); return { estado: 'login', mensagem: m.texto, revogado: !!m.revogado }; }
    item.erro = m.rede ? '' : (m.texto || ''); await deps.guardar(item);
    return { estado: 'pendente', mensagem: m.texto, rede: !!m.rede, retryAfter: m.retryAfter || 0, longo: !!m.longo, recuada: !!m.recuada };
  }
  /** Um comando que parou e a pessoa quer enviar outra vez («Mudar» confirmado, a confirmação da folha, «Tentar outra vez»
      de um anular, pagar ou desfazer que mudou): um pedidoId NOVO (é outra intenção) e a versao de agora. Um que já saiu sem
      resposta não se reenvia (pode ter entrado): null. */
  function reenviar(q, o) {
    o = o || {};
    if (q.tentou && q.estado !== 'parado') return null;
    q.estado = 'a-enviar'; q.erro = ''; q.code = ''; q.details = null; q.mudar = false; q.confirmarFolha = false; q.tentou = false; q.resposta = null; q.registo = null;
    q.pedidoId = novoPedidoId(o.novoId);
    if (o.campos) { q.campos = o.campos; q.resumo = resumoDe(q.accao === 'corrigir' ? Object.assign({}, o.registo || {}, q.campos) : q.campos); }
    if (o.base !== undefined) q.base = o.base;   // a pessoa viu a despesa de agora: é sobre ela que os campos mudam
    if (o.versao !== undefined) q.versao = String(o.versao || '');
    if (o.motivo !== undefined && q.accao === 'anular') q.campos = { motivo: txt(o.motivo) };
    if (o.confirmouFolha && (q.accao === 'corrigir')) q.campos = Object.assign({}, q.campos, { confirmouFolha: true });
    q.criadoEm = (o.agora || new Date()).toISOString(); q.adiadoAte = o.adiarMs ? new Date((o.agora || new Date()).getTime() + o.adiarMs).toISOString() : '';
    return q;
  }

  // ── O que a fila diz (o «Por enviar» e o cartão do Pessoal) ──
  var TITULOS = { registar: 'Despesa', corrigir: 'Corrigir · despesa', anular: 'Anular · despesa', paga: 'Marcar paga · despesa', despagar: 'Desfazer «Paga» · despesa' };
  function tituloItem(q) { return TITULOS[q && q.accao] || 'Despesa'; }
  function resumoItem(q) { return (q && q.resumo) || ''; }

  return {
    ROTA: ROTA, FUNC: FUNC, LIMITES: LIMITES, CATEGORIAS: CATEGORIAS, IMPUT: IMPUT, ACCOES: ACCOES, MENSAGENS: MENSAGENS, A_PREPARAR: A_PREPARAR,
    disponivel: disponivel, novoIdDesp: novoIdDesp, novoPedidoId: novoPedidoId, lerValor: lerValor, valorTexto: valorTexto,
    imputRotulo: imputRotulo, obrasImput: obrasImput, formNovo: formNovo, formDoRegisto: formDoRegisto, formDoItem: formDoItem, faltaNoForm: faltaNoForm,
    camposDe: camposDe, naFolha: naFolha, textoFolha: textoFolha, mudou: mudou, baseDe: baseDe, diferencas: diferencas, temMudancas: temMudancas,
    aplicarCamposAoForm: aplicarCamposAoForm, vaiMudar: vaiMudar, textoDiferenca: textoDiferenca,
    itemComando: itemComando, corpoComando: corpoComando, registoProvisorio: registoProvisorio, folhaAberta: folhaAberta, aplicarLocal: aplicarLocal, meus: meus,
    comPendentes: comPendentes, aplicarResposta: aplicarResposta, porReembolsarAjustado: porReembolsarAjustado, mensagem: mensagem, processar: processar, reenviar: reenviar,
    mesmaDespesa: mesmaDespesa, textoAviso: textoAviso, tituloItem: tituloItem, resumoItem: resumoItem,
  };
}));
