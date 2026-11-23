/* DOE · Telemóvel — o Pessoal, fase 2 (17 nov 2026): pedir, corrigir e cancelar férias, faltas, Teletrabalho e Out of Office.
   Lógica pura (sem DOM), UMD como pessoal.js (self.DoeMovelAus no browser, require em Node), testada em Node e contra a
   simulação do servidor (movel/teste/api-pessoal-simulada.js). Contrato: docs/analises/Movel-Pessoal-Contrato.md, 1.2, 1.3,
   2.3 («POST /movel/pessoal/ausencias»), 2.4 e «Fase 2». Desenho: o protótipo validado pelo Pedro
   (docs/prototipos/telemovel-perfis/pessoal.js, ecrãs pes-fer-* e pes-falta-*).
   Regras que esta lógica cumpre:
   - as escritas são COMANDOS sobre UM registo (`accao` pedir | corrigir | cancelar), com o `id` do registo gerado aqui ao
     pedir e um `pedidoId` por intenção da pessoa (o mesmo em cada repetição: idempotência no servidor); corrigir e cancelar
     levam a `versao` que a pessoa viu (o servidor responde 409 MUDOU se o registo mudou entretanto). Nunca a lista inteira;
   - vão na fila ÚNICA da casca (IndexedDB «doeMovelDiario», itens com tipo 'aus'), por conta; sem rede ficam «por enviar»
     e seguem sozinhos; uma página antiga não os conhece e não os apaga (casca.js ligar: só carrega os tipos que conhece);
   - quem pode corrigir e cancelar decide-o o SERVIDOR (o `pode` de cada registo); a página não tem segunda regra. O que se
     calcula aqui (sobreposição, mês fechado, acima do saldo) é só AVISO antes de enviar, para a pessoa não ser surpreendida:
     o servidor decide e o motivo dele volta ao «Por enviar»;
   - um 409 ou um 403 não se repete: fica parado com o motivo do servidor até a pessoa «Mudar» (um pedidoId novo) ou
     «Desistir»; um 429, um 503, a falta de rede e uma Edge sem a rota (403 TOKEN_DE_AMBITO) repetem-se sozinhos;
   - nenhum ficheiro: o comprovativo de uma falta é a caixa «Tenho documento comprovativo» (campo `anexo`), como hoje;
   - as datas são texto AAAA-MM-DD e a aritmética é a de diario.js (UTC), nunca toISOString().slice(0, 10). */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica(require('./diario.js'), require('./pessoal.js'));
  else raiz.DoeMovelAus = fabrica(raiz.DoeMovelDiario, raiz.DoeMovelPessoal);
}(typeof self !== 'undefined' ? self : this, function (D, P) {
  'use strict';
  var ROTA = '/movel/pessoal/ausencias', FUNC = 'ausencias';
  var LIMITES = { nota: 500, texto: 200, diasMax: 366, obras: 20, visitas: 20 };
  var RE_DIA = /^\d{4}-\d{2}-\d{2}$/, RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
  // Os tipos do computador (ABSENCE_TYPE_CFG, ferias-helpers.js), menos «Ausência» (só leitura, redigida): a mesma ordem.
  var TIPOS = [
    { k: 'DOENCA', l: 'Doença', motivos: ['Baixa SNS', 'Exames/Tratamentos', 'Consulta/Cirurgia'] },
    { k: 'ASSISTENCIA_FAMILIAR', l: 'Assistência a Familiar', parentesco: true },
    { k: 'FALECIMENTO', l: 'Falecimento de Parentes e Afins', parentesco: true },
    { k: 'LICENCA_PARENTAL', l: 'Licença Parental' },
    { k: 'CASAMENTO', l: 'Casamento' },
    { k: 'TRABALHADOR_ESTUDANTE', l: 'Trabalhador Estudante' },
    { k: 'OBRIGACOES_LEGAIS', l: 'Obrigações Legais', especificar: true },
    { k: 'SEM_JUSTIFICACAO', l: 'Sem Justificação', horas: true },
    { k: 'TELETRABALHO', l: 'Teletrabalho', presenca: true },
    { k: 'OUT_OFFICE', l: 'Out of Office', presenca: true, horas: true, oo: true },
  ];
  var FERIAS = { k: 'FERIAS', l: 'Férias', ferias: true };
  var MODOS_OO = [['OBRA', 'Obra'], ['VISITAS', 'Visitas'], ['SEDE', 'Sede DOE']];
  var ESTADO_TXT = { PENDING: 'pendente', APPROVED: 'aprovado', REJECTED: 'rejeitado', CANCELLED: 'cancelado' };
  // sem tipo (uma falta antes do 1.º passo) não é Férias: o título e os passos dela são os das faltas
  function cfg(k) { if (k === 'FERIAS') return FERIAS; if (!k) return { k: '', l: '' }; for (var i = 0; i < TIPOS.length; i++) if (TIPOS[i].k === k) return TIPOS[i]; return { k: k, l: k }; }
  function copia(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function lista(v) { return Array.isArray(v) ? v : []; }
  function dia(v) { return typeof v === 'string' && RE_DIA.test(v) ? v : null; }
  function pl(n, um, varios) { return n + ' ' + (n === 1 ? um : varios); }
  function uuid(novoId) { return String(novoId ? novoId() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9_-]/g, ''); }
  function novoIdAus(novoId) { return ('aus-' + uuid(novoId)).slice(0, 64); }
  function novoPedidoId(novoId) { return ('ped-' + uuid(novoId)).slice(0, 64); }
  /** O servidor dá os comandos das ausências a esta conta? (`ausencias` nas funcionalidades; sem ela, o Pessoal só lê, como na F1) */
  function disponivel(funcs) { return lista(funcs).indexOf(FUNC) >= 0; }

  // ── Calendário (sem fins-de-semana nem feriados; um fecho dentro do pedido conta, como no computador) ──
  function uteis(a, b, fer) { if (!dia(a) || !dia(b) || b < a) return 0; var n = 0, s = a; for (var v = 0; s <= b && v < 800; v++) { if (!D.fimDeSemana(s) && !(fer || {})[s]) n++; s = D.somarDias(s, 1); } return n; }
  function uteisNoAno(a, b, ano, fer) { var i = a > ano + '-01-01' ? a : ano + '-01-01', f = b < ano + '-12-31' ? b : ano + '-12-31'; return i > f ? 0 : uteis(i, f, fer); }
  function corridos(a, b) { return dia(a) && dia(b) && b >= a ? D.difDias(a, b) + 1 : 0; }
  /** Os feriados (nacionais) de dias úteis dentro do período: [{ dia, nome }] (para «Fora da conta»). */
  function feriadosNoPeriodo(a, b, fer) { var l = []; if (!dia(a) || !dia(b) || b < a) return l; Object.keys(fer || {}).sort().forEach(function (k) { if (k >= a && k <= b && !D.fimDeSemana(k)) l.push({ dia: k, nome: String(fer[k]) }); }); return l; }
  /** O mês do início já fechou? (a regra do computador: depois, só o RH marca ou corrige; o servidor decide em Lisboa) */
  function mesFechado(d, hoje) { return !!dia(d) && !!dia(hoje) && d.slice(0, 7) < hoje.slice(0, 7); }
  function fimDoMes(d) { var x = D.somarDias(d.slice(0, 8) + '01', 32); return D.somarDias(x.slice(0, 8) + '01', -1); }

  // ── O formulário (um rascunho em memória; ao corrigir, vem do registo) ──
  function ooVazio() { return { modo: 'OBRA', obras: [], visitas: [] }; }
  /** Um pedido novo. tipo: 'FERIAS' (o ecrã das férias) ou '' (o das faltas: escolhe-se no 1.º passo). */
  function formNovo(tipo, hoje) {
    var h = dia(hoje) || '';
    return { accao: 'pedir', id: '', versao: '', tipo: tipo || '', inicio: h, fim: h, horasCompleto: true, horaInicio: '', horaFim: '', nota: '', motivo: '', parentesco: '', especificar: '', anexo: false, oo: ooVazio(), passo: 1 };
  }
  /** Corrigir um registo: os valores dele (o tipo, o motivo e o modo do Out of Office vêm do registo). */
  function formDoRegisto(p) {
    var c = cfg(p.tipo), oo = p.outOffice || null, f = formNovo(p.tipo, p.inicio);
    f.accao = 'corrigir'; f.id = p.id; f.versao = p.versao || ''; f.inicio = p.inicio; f.fim = p.fim || p.inicio;
    f.horasCompleto = p.horasCompleto !== false; f.horaInicio = p.horaInicio || ''; f.horaFim = p.horaFim || ''; f.nota = p.nota || '';
    if (c.motivos) f.motivo = c.motivos.indexOf(p.motivo) >= 0 ? p.motivo : '';
    if (c.parentesco) f.parentesco = String(p.motivo || '').replace(/^Parentesco:\s*/i, '');
    if (c.especificar) f.especificar = p.motivo || '';
    f.anexo = !!p.anexo;
    if (c.oo && oo) f.oo = { modo: oo.modo || 'OBRA', obras: lista(oo.obras).slice(), visitas: lista(oo.visitas).map(function (v) { return { clienteId: v.clienteId, contactoId: v.contactoId }; }) };
    f.passo = c.ferias ? 1 : 2;   // ao corrigir uma falta não se escolhe outra vez o tipo
    return f;
  }
  /** «Mudar» um comando que não entrou (ou que ainda não saiu): o formulário com o que a pessoa tinha. */
  function formDoItem(q, registo) {
    var c = q.campos || {}, f = formNovo(c.tipo || (registo && registo.tipo) || '', c.inicio);
    f.accao = q.accao === 'corrigir' ? 'corrigir' : 'pedir'; f.id = q.registoId; f.versao = registo ? (registo.versao || '') : (q.versao || '');
    f.inicio = c.inicio || ''; f.fim = c.fim || c.inicio || ''; f.horasCompleto = c.horasCompleto !== false; f.horaInicio = c.horaInicio || ''; f.horaFim = c.horaFim || '';
    f.nota = c.nota || ''; f.motivo = c.motivo || ''; f.parentesco = c.parentesco || ''; f.especificar = c.especificar || ''; f.anexo = !!c.anexo;
    if (c.outOffice) f.oo = { modo: c.outOffice.modo || 'OBRA', obras: lista(c.outOffice.obras).slice(), visitas: lista(c.outOffice.visitas).map(function (v) { return { clienteId: v.clienteId, contactoId: v.contactoId }; }) };
    f.passo = cfg(f.tipo).ferias ? 1 : 2; f.deItem = q.id;
    return f;
  }
  /** O que falta para seguir (o mesmo que o computador diz). → { campo, texto } ou null. passo: só o que esse passo pede. */
  function faltaNoForm(f, fer, passo) {
    var c = cfg(f.tipo);
    if (!f.tipo) return { campo: 'tipo', texto: 'Escolhe o tipo.' };
    if (passo === 1 && !c.ferias) return null;
    if (!dia(f.inicio)) return { campo: 'inicio', texto: 'Escolhe o dia de início.' };
    if (!dia(f.fim)) return { campo: 'fim', texto: 'Escolhe o dia de fim.' };
    if (f.fim < f.inicio) return { campo: 'fim', texto: 'O fim não pode ser antes do início.' };
    if (corridos(f.inicio, f.fim) > LIMITES.diasMax) return { campo: 'fim', texto: 'No máximo ' + LIMITES.diasMax + ' dias num pedido.' };
    if (c.ferias && !uteis(f.inicio, f.fim, fer)) return { campo: 'fim', texto: 'O período escolhido não tem dias úteis (só fins-de-semana ou feriados).' };
    if (c.horas && f.horasCompleto === false) {
      if (!RE_HORA.test(f.horaInicio || '') || !RE_HORA.test(f.horaFim || '')) return { campo: 'horas', texto: 'Preenche a hora de início e a hora de fim.' };
      if (f.horaFim <= f.horaInicio) return { campo: 'horas', texto: 'A hora de fim tem de ser depois da hora de início.' };
    }
    if (c.motivos && c.motivos.indexOf(f.motivo) < 0) return { campo: 'motivo', texto: 'Escolhe o motivo.' };
    if (c.parentesco && !String(f.parentesco || '').trim()) return { campo: 'parentesco', texto: 'Preenche o parentesco.' };
    if (c.especificar && !String(f.especificar || '').trim()) return { campo: 'especificar', texto: 'Preenche o campo «Especificar».' };
    if ((c.parentesco && String(f.parentesco).trim().length > LIMITES.texto) || (c.especificar && String(f.especificar).trim().length > LIMITES.texto)) return { campo: c.parentesco ? 'parentesco' : 'especificar', texto: 'No máximo ' + LIMITES.texto + ' caracteres.' };
    if (c.oo) {
      var oo = f.oo || ooVazio();
      if (oo.modo === 'OBRA' && !lista(oo.obras).length) return { campo: 'oo', texto: 'Escolhe pelo menos uma obra.' };
      if (oo.modo === 'VISITAS' && !lista(oo.visitas).some(function (v) { return v && v.clienteId && v.contactoId; })) return { campo: 'oo', texto: 'Adiciona pelo menos uma visita completa (empresa + contacto).' };
    }
    if (String(f.nota || '').trim().length > LIMITES.nota) return { campo: 'nota', texto: 'A nota tem mais de ' + LIMITES.nota + ' caracteres.' };
    return null;
  }
  /** Os campos do comando (a lista fechada do contrato, 2.3). Ao corrigir vão todos (a nota vazia apaga a nota). */
  function camposDe(f, excessoVisto) {
    var c = cfg(f.tipo), x = { tipo: f.tipo, inicio: f.inicio, fim: f.fim }, nota = String(f.nota || '').trim();
    if (c.horas) { x.horasCompleto = f.horasCompleto !== false; if (!x.horasCompleto) { x.horaInicio = f.horaInicio; x.horaFim = f.horaFim; } }
    if (nota || f.accao === 'corrigir') x.nota = nota;
    if (c.motivos) x.motivo = f.motivo;
    if (c.parentesco) x.parentesco = String(f.parentesco || '').trim();
    if (c.especificar) x.especificar = String(f.especificar || '').trim();
    if (c.oo) { var oo = f.oo || ooVazio(); x.outOffice = { modo: oo.modo, obras: oo.modo === 'OBRA' ? lista(oo.obras).slice(0, LIMITES.obras) : [], visitas: oo.modo === 'VISITAS' ? lista(oo.visitas).filter(function (v) { return v && v.clienteId && v.contactoId; }).slice(0, LIMITES.visitas).map(function (v) { return { clienteId: v.clienteId, contactoId: v.contactoId }; }) : [] }; }
    if (!c.ferias && !c.presenca) x.anexo = !!f.anexo;
    if (c.ferias && excessoVisto && excessoVisto.length) x.excessoVisto = excessoVisto.map(function (e) { return { ano: e.ano, dias: e.dias }; });
    return x;
  }

  // ── Os avisos antes de enviar (só avisos: o servidor decide) ──
  function parcial(r) { return r.horasCompleto === false && !!r.horaInicio && !!r.horaFim; }
  /** vacationPeriodsClash (ferias-helpers.js): duas presenças só chocam se ambas forem de dia completo; com uma ausência a
      sério, um dia completo choca com tudo e dois parciais só se as horas se cruzarem. a, b: { tipo, inicio, fim, horas… } */
  function chocam(a, b) {
    if (a.inicio > b.fim || b.inicio > a.fim) return false;
    if (cfg(a.tipo).presenca && cfg(b.tipo).presenca) return !parcial(a) && !parcial(b);
    if (!parcial(a) || !parcial(b)) return true;
    return a.horaInicio < b.horaFim && b.horaInicio < a.horaFim;
  }
  /** O meu pedido activo (pendente ou aprovado) que choca com o do formulário, ou null. */
  function sobreposicao(d, f) {
    if (!dia(f.inicio) || !dia(f.fim)) return null;
    var este = { tipo: f.tipo, inicio: f.inicio, fim: f.fim, horasCompleto: !cfg(f.tipo).horas || f.horasCompleto !== false, horaInicio: f.horaInicio, horaFim: f.horaFim };
    return lista(d && d.pedidos).filter(function (p) { return p.id !== f.id && (p.estado === 'PENDING' || p.estado === 'APPROVED') && dia(p.inicio) && dia(p.fim) && chocam(p, este); })[0] || null;
  }
  /** Quanto um pedido de férias passa do saldo no ano da leitura (vacationExcessoAoMarcar: conta os OUTROS pendentes; ao
      corrigir, o próprio volta ao livre). → [{ ano, dias }]. Os anos de que a página não tem o saldo ficam ao servidor
      (ACIMA_DO_SALDO, que pede a confirmação no «Por enviar»). */
  function excesso(d, f, fer) {
    if (!cfg(f.tipo).ferias || !d || !d.saldo || !dia(f.inicio) || !dia(f.fim)) return [];
    var ano = Number(d.ano) || Number(d.saldo.ano), dias = uteisNoAno(f.inicio, f.fim, ano, fer);
    if (!dias) return [];
    var livre = Number(d.saldo.livres) || 0;
    var proprio = f.id ? lista(d.pedidos).filter(function (p) { return p.id === f.id; })[0] : null;
    if (proprio && cfg(proprio.tipo).ferias && (proprio.estado === 'PENDING' || proprio.estado === 'APPROVED')) livre += uteisNoAno(proprio.inicio, proprio.fim, ano, fer);
    var depois = livre - dias;
    return depois < 0 ? [{ ano: ano, dias: Math.min(dias, -depois) }] : [];
  }
  /** Os livres depois deste pedido (no ano da leitura), como a linha «Livres depois» do protótipo. */
  function livresDepois(d, f, fer) {
    if (!d || !d.saldo) return null;
    var ano = Number(d.ano), livre = Number(d.saldo.livres) || 0, proprio = f.id ? lista(d.pedidos).filter(function (p) { return p.id === f.id; })[0] : null;
    if (proprio && cfg(proprio.tipo).ferias && (proprio.estado === 'PENDING' || proprio.estado === 'APPROVED')) livre += uteisNoAno(proprio.inicio, proprio.fim, ano, fer);
    return livre - uteisNoAno(f.inicio, f.fim, ano, fer);
  }
  /** O pedido toca um ano de que a página não tem o saldo (o servidor confirma o excesso desse ano)? */
  function foraDoAno(d, f) { var a = String((d && d.ano) || ''); return !!f.inicio && !!f.fim && (f.inicio.slice(0, 4) !== a || f.fim.slice(0, 4) !== a); }

  // ── O resumo do Out of Office (vacationOutOfficeSummaryText), com os nomes da leitura ──
  function resumoOO(oo, d) {
    if (!oo) return '';
    if (oo.modo === 'SEDE') return 'Deslocação à Sede DOE';
    if (oo.modo === 'OBRA') { var os = lista(oo.obras).map(function (id) { var o = lista(d && d.obras).filter(function (x) { return x.id === id; })[0]; return o ? (o.codigo ? o.codigo + ' — ' : '') + o.nome : ''; }).filter(Boolean); return os.length ? 'Obra: ' + os.join('; ') : ''; }
    var emp = lista(d && d.visitas && d.visitas.empresas), vs = lista(oo.visitas).map(function (v) { var e = emp.filter(function (x) { return x.id === v.clienteId; })[0], c = e ? lista(e.contactos).filter(function (x) { return x.id === v.contactoId; })[0] : null; return e ? e.nome + (c ? ' (' + c.nome + ')' : '') : ''; }).filter(Boolean);
    return vs.length ? 'Visita: ' + vs.join('; ') : '';
  }
  /** O motivo como o registo o guarda (o computador põe no `motivo` o subtipo da doença, o parentesco ou o especificar). */
  function motivoDe(c, d) {
    var t = cfg(c.tipo);
    if (t.oo) return resumoOO(c.outOffice, d);
    if (t.motivos) return c.motivo || '';
    if (t.parentesco) return c.parentesco || '';
    if (t.especificar) return c.especificar || '';
    return '';
  }

  // ── A fila (itens com tipo 'aus') ──
  /** Um item da fila para um comando. o: { accao, registo (o de agora, ao corrigir e cancelar), form, excessoVisto, contaId,
      contaNome, novoId, agora, adiarMs (o Desfazer: só segue depois), id (o registo, ao pedir: gerado se faltar) }. */
  function itemComando(o) {
    var agora = o.agora || new Date(), r = o.registo || null, f = o.form || null;
    var accao = o.accao, campos = accao === 'cancelar' ? {} : camposDe(f, o.excessoVisto);
    var registoId = accao === 'pedir' ? (o.id || (f && f.id) || novoIdAus(o.novoId)) : String((r && r.id) || (f && f.id) || '');
    return { id: 'q-' + uuid(o.novoId), tipo: 'aus', estado: 'a-enviar', contaId: String(o.contaId || ''), contaNome: String(o.contaNome || ''),
      registoId: registoId, accao: accao, campos: campos, pedidoId: novoPedidoId(o.novoId), versao: accao === 'pedir' ? '' : String((r && r.versao) || (f && f.versao) || ''),
      tipoAus: (r && r.tipo) || campos.tipo || '', resumo: resumoCurto(accao === 'cancelar' ? r : campos),
      criadoEm: agora.toISOString(), adiadoAte: o.adiarMs ? new Date(agora.getTime() + o.adiarMs).toISOString() : '', tentou: false,
      resposta: null, registo: null, erro: '', code: '', details: null, avisos: [], fotos: [] };
  }
  function resumoCurto(x) { if (!x) return ''; var a = x.inicio, b = x.fim; return (cfg(x.tipo).l || '') + (a ? ' · ' + P.intervalo(a, b) : ''); }
  /** O corpo do POST /movel/pessoal/ausencias: { accao, pedidoId, id, versao?, …campos }. */
  function corpoComando(q) {
    var c = { accao: q.accao, pedidoId: q.pedidoId, id: q.registoId };
    if (q.accao !== 'pedir') c.versao = q.versao;
    Object.keys(q.campos || {}).forEach(function (k) { c[k] = copia(q.campos[k]); });
    return c;
  }
  /** O registo que nasce no telemóvel (o pedir por enviar), para se ver logo; a resposta do servidor substitui-o. */
  function registoProvisorio(q, d, fer) {
    var c = q.campos || {}, t = cfg(c.tipo), pres = !!t.presenca, ch = d && d.chefia;
    return { id: q.registoId, tipo: c.tipo, rotulo: t.l, inicio: c.inicio, fim: c.fim, dias: t.ferias ? uteis(c.inicio, c.fim, fer) : corridos(c.inicio, c.fim), diasUteis: uteis(c.inicio, c.fim, fer),
      horasCompleto: c.horasCompleto !== false, horaInicio: c.horaInicio || null, horaFim: c.horaFim || null,
      estado: pres ? 'APPROVED' : 'PENDING', registado: pres, etapa: pres ? null : (t.ferias && ch ? 'DEPT' : 'RH'), decideNome: pres ? null : (t.ferias && ch ? ch.nome : 'RH'),
      motivo: motivoDe(c, d), nota: c.nota || '', outOffice: c.outOffice ? copia(c.outOffice) : null, anexo: !!c.anexo, justificativos: 0, decisao: null,
      historico: [{ em: q.criadoEm, texto: 'Por enviar (telemóvel)' }], versao: '', pode: [], via: 'movel', porEnviar: true, filaId: q.id };
  }
  /** O registo como fica com um comando por enviar (corrigir, cancelar): para se ver logo, sem acções até o servidor responder. */
  function aplicarLocal(p, q, d) {
    var r = copia(p), c = q.campos || {}, t = cfg(r.tipo);
    if (q.accao === 'cancelar') r.estado = 'CANCELLED';
    else if (q.accao === 'corrigir') {
      ['inicio', 'fim', 'horaInicio', 'horaFim', 'nota'].forEach(function (k) { if (c[k] !== undefined) r[k] = c[k]; });
      if (c.horasCompleto !== undefined) r.horasCompleto = c.horasCompleto !== false;
      if (r.horasCompleto) { r.horaInicio = null; r.horaFim = null; }
      if (c.anexo !== undefined) r.anexo = !!c.anexo;
      if (c.outOffice) r.outOffice = copia(c.outOffice);
      var m = motivoDe(Object.assign({ tipo: r.tipo }, c), d); if (m || t.motivos || t.parentesco || t.especificar || t.oo) r.motivo = m;
      if (t.ferias && r.estado === 'APPROVED') { r.estado = 'PENDING'; r.decisao = null; r.etapa = d && d.chefia ? 'DEPT' : 'RH'; r.decideNome = d && d.chefia ? d.chefia.nome : 'RH'; }   // «Reaberto para nova aprovação após edição»
    }
    r.porEnviar = true; r.pode = []; r.filaId = q.id;
    return r;
  }
  /** Os itens da fila desta conta, das ausências, que ainda não foram entregues. */
  function meus(fila, contaId) { return lista(fila).filter(function (q) { return q && q.tipo === 'aus' && q.contaId === contaId && q.estado !== 'entregue'; }); }
  /** Um parado de vez (o registo «não entrou») ou à espera (vai seguir). */
  function parado(q) { return q.estado === 'parado'; }
  /** A leitura com os comandos por enviar por cima (por ordem). Os parados não mudam o registo: marcam-no (`comErro`).
      O saldo acerta-se pelos pedidos de férias que mudam (a mesma conta, por dia útil no ano), para o «livres» não mentir
      até à leitura seguinte. → uma cópia de d, ou d se não há nada. */
  function comPendentes(d, fila, contaId, fer) {
    var ms = meus(fila, contaId);
    if (!d || !ms.length) return d;
    var x = copia(d), porId = {};
    x.pedidos = lista(x.pedidos);
    x.pedidos.forEach(function (p, i) { porId[p.id] = i; });
    ms.slice().sort(function (a, b) { return String(a.criadoEm).localeCompare(String(b.criadoEm)); }).forEach(function (q) {
      var i = porId[q.registoId];
      if (parado(q)) { if (i != null) { x.pedidos[i].comErro = q.erro || 'Não entrou'; x.pedidos[i].filaId = q.id; } return; }
      if (q.accao === 'pedir') { if (i == null) { x.pedidos.unshift(registoProvisorio(q, x, fer)); porId = {}; x.pedidos.forEach(function (p, j) { porId[p.id] = j; }); } return; }
      if (i != null) x.pedidos[i] = aplicarLocal(x.pedidos[i], q, x);
    });
    if (x.saldo) x.saldo = saldoAjustado(x.saldo, lista(d.pedidos), x.pedidos, Number(x.ano) || Number(x.saldo.ano), fer);
    return x;
  }
  function conta(l, ano, fer) {
    var s = { ap: 0, pe: 0 };
    l.forEach(function (p) { if (!cfg(p.tipo).ferias || !dia(p.inicio) || !dia(p.fim)) return; var n = uteisNoAno(p.inicio, p.fim, ano, fer); if (p.estado === 'APPROVED') s.ap += n; else if (p.estado === 'PENDING') s.pe += n; });
    return s;
  }
  function saldoAjustado(s, antes, depois, ano, fer) {
    var a = conta(antes, ano, fer), b = conta(depois, ano, fer), dAp = b.ap - a.ap, dPe = b.pe - a.pe, r = copia(s);
    if (!dAp && !dPe) { r.proxAno = proxAjustado(s, antes, depois, ano, fer); return r; }
    r.aprovados = (Number(s.aprovados) || 0) + dAp; r.marcados = Math.max(0, (Number(s.marcados) || 0) + dAp); r.pendentes = (Number(s.pendentes) || 0) + dPe;
    r.porMarcar = (Number(s.porMarcar) || 0) - dAp; r.livres = (Number(s.livres) || 0) - dAp - dPe;
    r.proxAno = proxAjustado(s, antes, depois, ano, fer); r.comPorEnviar = true;
    return r;
  }
  function proxAjustado(s, antes, depois, ano, fer) {
    var p = copia(s.proxAno || { ano: ano + 1, dias: 0 }), a = conta(antes, ano + 1, fer), b = conta(depois, ano + 1, fer);
    p.dias = Math.max(0, (Number(p.dias) || 0) + (b.ap + b.pe) - (a.ap + a.pe));
    return p;
  }
  /** O registo de uma resposta (ou do MUDOU) entra na cópia, no lugar do antigo (ou à frente, se é novo). */
  function porRegisto(d, registo) {
    if (!d || !registo || !registo.id) return d;
    var l = lista(d.pedidos), i = -1;
    l.forEach(function (p, j) { if (p.id === registo.id) i = j; });
    if (i >= 0) l[i] = copia(registo); else l.unshift(copia(registo));
    d.pedidos = l;
    return d;
  }

  /** O registo que o servidor devolveu (num comando aceite, ou o de agora num 409 MUDOU) entra na cópia e o saldo acerta-se
      pela diferença (a página não relê depois de um comando: contrato 2.4). Muda d e devolve-o. */
  function aplicarResposta(d, registo, fer) {
    if (!d || !registo || !registo.id) return d;
    var antes = copia(lista(d.pedidos));
    porRegisto(d, registo);
    if (d.saldo) { var s = saldoAjustado(d.saldo, antes, d.pedidos, Number(d.ano) || Number(d.saldo.ano), fer); delete s.comPorEnviar; d.saldo = s; }
    return d;
  }

  // ── Erros → o que fazer (2.4) ──
  var MENSAGENS = {
    SOBREPOSICAO: 'Não foi aceite: já tens outro pedido nesses dias.',
    MES_FECHADO: 'Este mês já fechou: só o RH marca ou corrige ausências nele.',
    FALTA_DECIDIDA: 'Esta falta já foi validada pelo RH: para a mudar, fala com o RH.',
    BLOQUEADA_RH: 'Esta ausência foi registada pelo RH: para a mudar, fala com o RH.',
    JA_COMECOU: 'Já começou: para mudar, fala com a tua chefia ou com o RH.',
    ACIMA_DO_SALDO: 'O saldo mudou: este pedido fica agora acima do saldo. Confirma outra vez.',
    MUDOU: 'Isto mudou entretanto (no computador ou noutro telemóvel). Revê e envia outra vez.',
    TRANSICAO_INVALIDA: 'Já não se pode fazer isto neste estado.',
    NAO_ENCONTRADO: 'Este pedido já não existe nas tuas ausências.',
    ID_ALHEIO: 'Este pedido é de outra pessoa.',
    ID_EM_USO: 'Este pedido já existe noutra conta. Faz um pedido novo.',
    ID_INVALIDO: 'Erro interno da página (identificador). Avisa o escritório.',
    VALIDATION_ERROR: 'Há um campo por corrigir.',
    TEXTO_PERIGOSO: 'A nota tem uma parte que não posso gravar. Tira-a e envia outra vez.',
    SEM_PESSOAL: 'O Pessoal é só para quem tem conta na aplicação do computador.',
    CONTA_EXTERNA: 'Esta conta é externa: o Pessoal é só para quem trabalha na DOE.',
    SEM_PERFIL: 'A tua conta não está ligada a nenhuma pessoa activa no DOE. Pede à administração.',
    PAPEL_SEM_ESCRITA: 'O teu papel (só leitura) não tem o Pessoal.',
  };
  // Os que se resolvem a mudar o pedido («Mudar»: o formulário com o que se tinha, um pedidoId novo); os outros só «Desistir».
  var MUDAVEIS = { SOBREPOSICAO: true, MES_FECHADO: true, ACIMA_DO_SALDO: true, MUDOU: true, VALIDATION_ERROR: true, TEXTO_PERIGOSO: true };
  var PARAM = ['SOBREPOSICAO', 'MES_FECHADO', 'FALTA_DECIDIDA', 'BLOQUEADA_RH', 'JA_COMECOU', 'ACIMA_DO_SALDO', 'MUDOU', 'TRANSICAO_INVALIDA', 'NAO_ENCONTRADO', 'ID_ALHEIO', 'ID_EM_USO', 'ID_INVALIDO', 'VALIDATION_ERROR', 'TEXTO_PERIGOSO', 'SEM_PESSOAL', 'CONTA_EXTERNA', 'SEM_PERFIL', 'PAPEL_SEM_ESCRITA'];
  var A_PREPARAR = 'As férias e faltas pelo telemóvel ainda estão a ser preparadas no servidor. Fica no telemóvel; tento mais tarde.';
  /** O texto da sobreposição com os detalhes do servidor (o pedido com que choca é sempre da própria pessoa). */
  function textoSobreposicao(dt) {
    if (!dt || !dt.inicio) return MENSAGENS.SOBREPOSICAO;
    var t = cfg(dt.tipo), nome = t.ferias ? 'férias' : t.l.toLowerCase();
    return 'Não foi aceite: já tens ' + nome + ' nesses dias (' + P.intervalo(dt.inicio, dt.fim) + (ESTADO_TXT[dt.estado] ? ', ' + ESTADO_TXT[dt.estado] : '') + ').';
  }
  function textoAcima(dt) {
    var ex = lista(dt && dt.excesso), n = ex.reduce(function (s, e) { return s + (Number(e.dias) || 0); }, 0);
    return n ? 'O saldo mudou: este pedido fica agora ' + pl(n, 'dia', 'dias') + ' acima. Confirma outra vez.' : MENSAGENS.ACIMA_DO_SALDO;
  }
  /** → { accao: 'parar'|'repetir'|'login', texto, code, details, mudar, confirmar, longo, retryAfter, rede, revogado } */
  function mensagem(e, item) {
    var c = (e && e.code) || '', s = (e && e.status) || 0, m = (e && e.message) || '', dt = (e && e.details) || {};
    if (e && e.rede) return D.mensagemDiario(e);
    // a Edge sem a rota (anterior à F2, ou recuada): não é um login; fica e repete-se mais tarde
    if (c === 'TOKEN_DE_AMBITO' || c === 'ROUTE_NOT_FOUND' || c === 'NOT_FOUND' || (s === 404 && !c)) return { accao: 'repetir', longo: true, recuada: true, code: c, texto: A_PREPARAR };
    if (c === 'PESSOAL_POR_INSTALAR') return { accao: 'repetir', longo: true, code: c, texto: A_PREPARAR };
    if (c === 'LIMITE_DIARIO') return { accao: 'repetir', longo: true, code: c, texto: 'Chegaste ao limite de ' + (dt.max || 20) + ' pedidos de ausências por dia. Fica no telemóvel; segue amanhã.' };
    if (PARAM.indexOf(c) >= 0) {
      var t = c === 'SOBREPOSICAO' ? (m || textoSobreposicao(dt)) : (c === 'ACIMA_DO_SALDO' ? textoAcima(dt) : (m || MENSAGENS[c]));
      if (c === 'VALIDATION_ERROR' && !m && dt.campo) t = 'Há um campo por corrigir (' + dt.campo + ').';
      return { accao: 'parar', code: c, details: copia(dt), texto: t, mudar: !!MUDAVEIS[c], confirmar: c === 'ACIMA_DO_SALDO' };
    }
    var x = D.mensagemDiario(e);
    if (x.accao === 'login') return x;
    if (x.accao === 'repetir') return x;
    if (s >= 500 || s === 429) return { accao: 'repetir', texto: 'O servidor está ocupado. Fica no telemóvel; tento outra vez.', retryAfter: (e && e.retryAfter) || 0 };
    return { accao: 'parar', code: c, details: copia(dt), texto: m || 'Não foi aceite.', mudar: false };
  }
  /** Leva um comando ao servidor (chamado pelo drenar da casca, item a item). Repetir é seguro: o mesmo pedidoId.
      → { estado: 'entregue'|'pendente'|'parar'|'login'|'alheio', mensagem, rede, retryAfter, longo, revogado, registo } */
  async function processar(item, deps) {
    if (deps.contaId && item.contaId && item.contaId !== deps.contaId()) return { estado: 'alheio', mensagem: 'Isto é de ' + (item.contaNome || 'outra conta') + '; só essa conta o pode enviar.' };
    if (deps.online && deps.online() === false) return { estado: 'pendente', rede: true, mensagem: D.mensagemDiario({ rede: true, online: false }).texto };
    // «tentou» fica: uma falha de rede DEPOIS de sair não prova que o pedido não chegou (revisão da F2, e3: o
    // navigator.onLine a falso no catch não diz se o servidor gravou). Daí em diante só se repete com o MESMO pedidoId.
    item.tentou = true; await deps.guardar(item);
    var x = await D.pedir(deps, 'POST', ROTA, corpoComando(item));
    // Um pedir cujo registo já existe no servidor com outro conteúdo (a resposta do 1.º envio perdeu-se e a pessoa mudou-o
    // depois): o servidor devolve o que lá está, como `repetido` ou num 409 com `details.registo`. Fica o do servidor e diz-se.
    var jaLa = item.accao === 'pedir' && !x.ok && x.status === 409 && x.details && x.details.registo && x.details.registo.id === item.registoId ? x.details.registo : null;
    if (x.ok || jaLa) {
      var dt = jaLa ? { registo: jaLa, repetido: true, versao: jaLa.versao, avisos: [] } : (x.data || {});
      item.resposta = { versao: dt.versao || (dt.registo && dt.registo.versao) || '', repetido: !!dt.repetido };
      item.registo = dt.registo || null; item.avisos = lista(dt.avisos).map(textoAviso).filter(Boolean);
      item.jaEntrou = item.accao === 'pedir' && !!dt.repetido && !!item.registo && !mesmoPedido(item.campos, item.registo);
      if (item.jaEntrou) item.avisos.unshift(textoJaEntrou(item.registo));
      item.estado = 'entregue'; item.erro = ''; item.code = ''; item.details = null;
      await deps.guardar(item);
      return { estado: 'entregue', registo: item.registo, avisos: item.avisos, jaEntrou: item.jaEntrou };
    }
    var m = mensagem(x, item);
    if (m.accao === 'parar') { item.estado = 'parado'; item.erro = m.texto; item.code = m.code || ''; item.details = m.details || null; item.mudar = !!m.mudar; item.confirmar = !!m.confirmar; await deps.guardar(item); return { estado: 'parar', mensagem: m.texto, code: m.code }; }
    if (m.accao === 'login') { await deps.guardar(item); return { estado: 'login', mensagem: m.texto, revogado: !!m.revogado }; }
    item.erro = m.rede ? '' : (m.texto || ''); await deps.guardar(item);
    return { estado: 'pendente', mensagem: m.texto, rede: !!m.rede, retryAfter: m.retryAfter || 0, longo: !!m.longo, recuada: !!m.recuada };
  }
  /** O registo do servidor é o que este pedido mandou? (o tipo, as datas, as horas e a nota) */
  function mesmoPedido(c, r) {
    c = c || {};
    if (!r) return true;
    var compl = c.horasCompleto !== false, rc = r.horasCompleto !== false;
    return r.tipo === c.tipo && r.inicio === c.inicio && r.fim === c.fim && rc === compl
      && (compl || (r.horaInicio === c.horaInicio && r.horaFim === c.horaFim)) && String(r.nota || '') === String(c.nota || '').trim();
  }
  function textoJaEntrou(r) {
    var t = cfg(r.tipo);
    return 'Este pedido já tinha entrado antes, como ' + (t.ferias ? 'férias' : String(t.l || '').toLowerCase()) + ' de ' + P.intervalo(r.inicio, r.fim) + ': ficou o que está no servidor. O que mudaste não foi aplicado; corrige o pedido se for preciso.';
  }
  /** Os avisos de uma resposta ({ campo, motivo, valor? }): campos ignorados pelo servidor. Só o que a pessoa precisa de saber. */
  function textoAviso(a) {
    if (!a) return '';
    if (a.motivo === 'ignorado' || a.motivo === 'campo-ignorado') return '';
    if (a.motivo === 'sem-alteracoes') return 'Nada mudou: o pedido já estava assim.';
    if (a.campo === 'obras') return 'Uma das obras já não está activa: ficou de fora.';
    if (a.campo === 'visitas') return 'Uma das visitas já não existe no Comercial: ficou de fora.';
    return '';
  }
  /** Um comando que parou e a pessoa quer enviar outra vez (o «Mudar» confirmado, o «Confirmar» do acima do saldo, o
      «Tentar outra vez» de um cancelar que mudou): um pedidoId NOVO (é outra intenção), a versao de agora. */
  function reenviar(q, o) {
    o = o || {};
    if (q.tentou && q.estado !== 'parado') return null;   // já saiu sem resposta: pode ter entrado; só se repete com o mesmo pedidoId
    q.estado = 'a-enviar'; q.erro = ''; q.code = ''; q.details = null; q.mudar = false; q.confirmar = false; q.tentou = false; q.resposta = null; q.registo = null;
    q.pedidoId = novoPedidoId(o.novoId);
    if (o.campos) { q.campos = o.campos; q.resumo = resumoCurto(q.campos); }
    if (o.versao !== undefined) q.versao = String(o.versao || '');
    if (o.excessoVisto) q.campos = Object.assign({}, q.campos, { excessoVisto: copia(o.excessoVisto) });
    q.criadoEm = (o.agora || new Date()).toISOString(); q.adiadoAte = o.adiarMs ? new Date((o.agora || new Date()).getTime() + o.adiarMs).toISOString() : '';
    return q;
  }

  // ── O que a fila diz (o «Por enviar» e o cartão do Pessoal) ──
  function tituloItem(q) {
    var t = cfg(q.tipoAus || (q.campos && q.campos.tipo)), nome = t.ferias ? 'Férias' : t.l;
    if (q.accao === 'cancelar') return 'Cancelar · ' + nome;
    if (q.accao === 'corrigir') return 'Corrigir · ' + nome;
    return t.ferias ? 'Pedido de férias' : nome;
  }
  function resumoItem(q) {
    var c = q.campos || {};
    if (q.accao === 'cancelar') return q.resumo || '';
    var t = cfg(c.tipo), n = t.ferias ? null : corridos(c.inicio, c.fim);
    return (c.inicio ? P.intervalo(c.inicio, c.fim) : '') + (n && !t.presenca ? ' · ' + pl(n, 'dia', 'dias') : '') + (c.horasCompleto === false && c.horaInicio ? ' · ' + c.horaInicio + '–' + c.horaFim : '');
  }

  return {
    ROTA: ROTA, FUNC: FUNC, LIMITES: LIMITES, TIPOS: TIPOS, FERIAS: FERIAS, MODOS_OO: MODOS_OO, MENSAGENS: MENSAGENS, A_PREPARAR: A_PREPARAR,
    cfg: cfg, disponivel: disponivel, novoIdAus: novoIdAus, novoPedidoId: novoPedidoId,
    uteis: uteis, uteisNoAno: uteisNoAno, corridos: corridos, feriadosNoPeriodo: feriadosNoPeriodo, mesFechado: mesFechado, fimDoMes: fimDoMes,
    formNovo: formNovo, formDoRegisto: formDoRegisto, formDoItem: formDoItem, faltaNoForm: faltaNoForm, camposDe: camposDe,
    chocam: chocam, sobreposicao: sobreposicao, excesso: excesso, livresDepois: livresDepois, foraDoAno: foraDoAno, resumoOO: resumoOO, motivoDe: motivoDe,
    itemComando: itemComando, corpoComando: corpoComando, registoProvisorio: registoProvisorio, aplicarLocal: aplicarLocal, meus: meus,
    comPendentes: comPendentes, porRegisto: porRegisto, aplicarResposta: aplicarResposta, saldoAjustado: saldoAjustado, mensagem: mensagem, textoSobreposicao: textoSobreposicao, processar: processar, reenviar: reenviar,
    tituloItem: tituloItem, resumoItem: resumoItem, textoAviso: textoAviso, mesmoPedido: mesmoPedido,
  };
}));
