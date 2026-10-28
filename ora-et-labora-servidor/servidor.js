'use strict';
/*
 * Ora et Labora — servidor da equipe.
 * Guarda tudo num arquivo JSON (sem banco externo), cuida do login de cada pessoa,
 * esconde a área privada de quem não é o dono, guarda os anexos e manda o resumo diário no WhatsApp.
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORTA = process.env.PORT || 3000;
function discoEm(p) { try { return fs.statSync(p).isDirectory() && fs.statSync(p).dev !== fs.statSync(__dirname).dev; } catch (e) { return false; } }
const DADOS = path.resolve(process.env.ORA_DADOS || process.env.RAILWAY_VOLUME_MOUNT_PATH || (discoEm('/data') ? '/data' : path.join(__dirname, 'dados')));
const ARQ = path.join(DADOS, 'ora.json');
const ANEXOS = path.join(DADOS, 'anexos');
const BACKUPS = path.join(DADOS, 'backups');
const FUSO = process.env.FUSO || 'America/Sao_Paulo';
const APP_URL = (process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '')).replace(/\/$/, '');
const COLS = new Set(['missoes', 'reunioes', 'tags', 'criativos', 'habitos', 'registros', 'revisoes', 'exames', 'oferecimentos', 'meta', 'prefs']);
const SEMPRE_PRIVADAS = new Set(['habitos', 'registros', 'revisoes', 'exames', 'oferecimentos', 'prefs']);
const DIAS_SESSAO = 60;

/* ---------- Armazenamento ---------- */
fs.mkdirSync(ANEXOS, { recursive: true });
fs.mkdirSync(BACKUPS, { recursive: true });
let db = { usuarios: [], sessoes: {}, itens: {}, anexos: {}, seq: 0, enviados: {} };
if (fs.existsSync(ARQ)) {
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(ARQ, 'utf8'))); }
  catch (e) { console.error('Não consegui ler ' + ARQ + '. Corrija ou restaure um backup da pasta backups/. Nada foi apagado.', e.message); process.exit(1); }
}
let timerGravar = null;
function gravar() { clearTimeout(timerGravar); timerGravar = setTimeout(gravarAgora, 300); }
let ultimoErroGravar = '', ultimaGravacao = 0;
function gravarAgora() {
  timerGravar = null;
  if (!db.criadoEm) db.criadoEm = new Date().toISOString();
  try {
    const tmp = ARQ + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, ARQ);
    ultimaGravacao = Date.now(); ultimoErroGravar = '';
  } catch (e) { ultimoErroGravar = e.message; console.error('[dados] NÃO consegui gravar em ' + ARQ + ': ' + e.message); }
}

/* ---------- Disco: os dados sobrevivem a uma atualização? ---------- */
const NO_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
const ORIGEM_DADOS = process.env.ORA_DADOS ? 'variável ORA_DADOS' : process.env.RAILWAY_VOLUME_MOUNT_PATH ? 'volume do Railway' : DADOS === '/data' ? 'disco encontrado em /data' : 'pasta padrão do app (apagada a cada atualização)';
function discoSeparado() { try { return fs.statSync(DADOS).dev !== fs.statSync(__dirname).dev; } catch (e) { return false; } }
function dadosPersistentes() {
  if (!NO_RAILWAY) return true;
  const vol = process.env.RAILWAY_VOLUME_MOUNT_PATH || (DADOS === '/data' ? '/data' : '');
  return !!vol && (DADOS === path.resolve(vol) || DADOS.startsWith(path.resolve(vol) + path.sep)) && discoSeparado();
}
const INICIADO = new Date();
function encerrar() { if (timerGravar) gravarAgora(); process.exit(0); }
process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);

function backupDiario() {
  const { data } = agoraNoFuso();
  const alvo = path.join(BACKUPS, 'ora-' + data + '.json');
  if (!fs.existsSync(alvo) && db.usuarios.length) {
    if (timerGravar) gravarAgora();
    if (fs.existsSync(ARQ)) fs.copyFileSync(ARQ, alvo);
    const antigos = fs.readdirSync(BACKUPS).filter(f => /^ora-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    antigos.slice(0, Math.max(0, antigos.length - 14)).forEach(f => fs.unlinkSync(path.join(BACKUPS, f)));
  }
}

/* ---------- Utilidades ---------- */
function agoraNoFuso() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const g = t => (p.find(x => x.type === t) || {}).value;
  return { data: g('year') + '-' + g('month') + '-' + g('day'), hora: g('hour') + ':' + g('minute') };
}
function id(prefixo) { return prefixo + crypto.randomBytes(9).toString('base64url'); }
function normNome(n) { return String(n || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
function hashSenha(senha) { const sal = crypto.randomBytes(16).toString('hex'); return sal + ':' + crypto.scryptSync(String(senha), sal, 64).toString('hex'); }
function senhaConfere(senha, guardado) {
  const [sal, h] = String(guardado || '').split(':'); if (!sal || !h) return false;
  const x = crypto.scryptSync(String(senha), sal, 64), y = Buffer.from(h, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function cookies(req) {
  const o = {}; (req.headers.cookie || '').split(';').forEach(c => { const i = c.indexOf('='); if (i > 0) o[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); });
  return o;
}
function perfil(u) { return { id: u.id, nome: u.nome, admin: !!u.admin, whatsapp: u.whatsapp || '', resumoHora: u.resumoHora || '07:30', resumoAtivo: !!u.resumoAtivo }; }
function equipePublica() { return db.usuarios.map(u => ({ id: u.id, nome: u.nome, admin: !!u.admin })); }
function validarNome(n) { n = String(n || '').trim(); if (n.length < 1 || n.length > 40) throw new Erro('O nome precisa ter entre 1 e 40 letras.'); return n; }
function validarSenha(s) { s = String(s || ''); if (s.length < 4 || s.length > 100) throw new Erro('A senha precisa ter pelo menos 4 caracteres.'); return s; }
class Erro extends Error { constructor(m, status) { super(m); this.status = status || 400; } }

function abrirSessao(req, res, u) {
  const t = crypto.randomBytes(32).toString('hex');
  db.sessoes[t] = { uid: u.id, criada: Date.now() }; gravar();
  res.set('Set-Cookie', 'ora_sessao=' + t + '; HttpOnly; Path=/; Max-Age=' + (DIAS_SESSAO * 86400) + '; SameSite=Lax' + (req.secure ? '; Secure' : ''));
}
function usuarioDe(req) {
  const t = cookies(req).ora_sessao, s = t && db.sessoes[t];
  if (!s) return null;
  if (Date.now() - s.criada > DIAS_SESSAO * 864e5) { delete db.sessoes[t]; gravar(); return null; }
  return db.usuarios.find(u => u.id === s.uid) || null;
}

/* ---------- Aplicação ---------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'same-origin'); res.set('X-Frame-Options', 'SAMEORIGIN'); next(); });

const ICONE = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1c1c1a"/><path d="M16 5v22M9 12h14" stroke="#fafaf8" stroke-width="3" stroke-linecap="round"/></svg>');
function pagina() {
  const corpo = fs.readFileSync(path.join(__dirname, 'publico', 'index.html'), 'utf8');
  return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="' + ICONE + '"><script>window.ORA_SERVIDOR=true</script>' + corpo + '</html>';
}
const PAGINA = pagina();
app.get('/', (req, res) => { res.set('Cache-Control', 'no-cache'); res.type('html').send(PAGINA); });
app.get('/saude', (req, res) => res.type('text').send('ok'));
app.get('/diagnostico', (req, res) => {
  let arq = 'ainda não existe';
  try { const st = fs.statSync(ARQ); arq = (st.size / 1024).toFixed(1) + ' KB, gravado em ' + st.mtime.toISOString(); } catch (e) {}
  let teste = 'ok';
  try { const t = path.join(DADOS, '.teste-escrita'); fs.writeFileSync(t, String(Date.now())); fs.unlinkSync(t); } catch (e) { teste = 'FALHOU: ' + e.message; }
  let backups = [];
  try { backups = fs.readdirSync(BACKUPS).filter(f => f.endsWith('.json')).sort(); } catch (e) {}
  const ok = dadosPersistentes() && teste === 'ok' && !ultimoErroGravar;
  res.set('Cache-Control', 'no-store').type('text').send([
    'Ora et Labora · diagnóstico dos dados',
    '',
    ok ? 'RESULTADO: OK — os dados ficam no disco e sobrevivem às atualizações.' : 'RESULTADO: PROBLEMA — veja as linhas abaixo.',
    '',
    'Pasta dos dados ........ ' + DADOS,
    'De onde veio ........... ' + ORIGEM_DADOS,
    'Volume do Railway ...... ' + (process.env.RAILWAY_VOLUME_MOUNT_PATH ? process.env.RAILWAY_VOLUME_MOUNT_PATH + (process.env.RAILWAY_VOLUME_NAME ? ' (' + process.env.RAILWAY_VOLUME_NAME + ')' : '') : (NO_RAILWAY ? 'NENHUM ligado a este serviço' : 'não está no Railway')),
    'Disco separado do app .. ' + (discoSeparado() ? 'sim' : 'NÃO'),
    'Teste de escrita ....... ' + teste,
    'Última gravação ........ ' + (ultimoErroGravar ? 'ERRO: ' + ultimoErroGravar : ultimaGravacao ? new Date(ultimaGravacao).toISOString() : 'nenhuma desde que o servidor ligou'),
    'Arquivo ora.json ....... ' + arq,
    'Dados criados em ....... ' + (db.criadoEm || '—'),
    'Contas cadastradas ..... ' + db.usuarios.length,
    'Itens guardados ........ ' + Object.keys(db.itens || {}).length,
    'Cópias de segurança .... ' + (backups.length ? backups.length + ' (última: ' + backups[backups.length - 1] + ')' : 'nenhuma ainda'),
    'Servidor ligado em ..... ' + INICIADO.toISOString(),
    '',
    'Se "Dados criados em" for anterior a "Servidor ligado em", os dados sobreviveram à última atualização.'
  ].join('\n'));
});

/* Proteção simples contra requisições de outros sites: toda chamada que altera algo precisa do cabeçalho X-Ora. */
app.use('/api', (req, res, next) => { if (req.method !== 'GET' && req.get('X-Ora') !== '1') return res.status(403).json({ erro: 'Requisição recusada.' }); next(); });
function exigir(req, res, next) { const u = usuarioDe(req); if (!u) return res.status(401).json({ erro: 'Sua sessão terminou. Entre de novo.' }); req.u = u; next(); }
function exigirAdmin(req, res, next) { if (!req.u.admin) return res.status(403).json({ erro: 'Só o administrador pode fazer isso.' }); next(); }
const rota = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(e => { if (!(e instanceof Erro)) console.error(e); res.status(e.status || 500).json({ erro: e instanceof Erro ? e.message : 'Erro no servidor.' }); });

/* Anexos (antes do leitor de JSON, para aceitar qualquer tipo de arquivo) */
const SEGUROS = /^(image\/(png|jpe?g|gif|webp|avif)|video\/|audio\/|text\/plain|application\/pdf$)/;
app.post('/api/anexos', exigir, express.raw({ type: () => true, limit: '50mb' }), rota((req, res) => {
  if (!req.body || !req.body.length) throw new Erro('Arquivo vazio.');
  const aid = id('a'), nome = (() => { try { return decodeURIComponent(req.get('X-Nome') || '') || 'arquivo'; } catch (e) { return 'arquivo'; } })().slice(0, 200);
  fs.writeFileSync(path.join(ANEXOS, aid), req.body);
  db.anexos[aid] = { nome, tipo: String(req.get('Content-Type') || 'application/octet-stream').slice(0, 100), tam: req.body.length, dono: req.u.id, em: new Date().toISOString() };
  gravar(); res.json({ id: aid });
}));
app.get('/api/anexos/:id', exigir, rota((req, res) => {
  const a = /^a[\w-]+$/.test(req.params.id) && db.anexos[req.params.id];
  if (!a) throw new Erro('Anexo não encontrado.', 404);
  const inline = !req.query.baixar && SEGUROS.test(a.tipo);
  res.set('Content-Type', inline ? a.tipo : 'application/octet-stream');
  res.set('Content-Disposition', (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(a.nome));
  if (a.tipo !== 'application/pdf') res.set('Content-Security-Policy', 'sandbox; default-src \'none\'; img-src \'self\'; media-src \'self\'');
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.join(ANEXOS, req.params.id));
}));
app.delete('/api/anexos/:id', exigir, rota((req, res) => {
  const aid = req.params.id;
  if (/^a[\w-]+$/.test(aid) && db.anexos[aid]) { try { fs.unlinkSync(path.join(ANEXOS, aid)); } catch (e) {} delete db.anexos[aid]; gravar(); }
  res.json({ ok: true });
}));

/* ---------- Reuniões gravadas: áudio em partes de ~5 min, transcritas no Groq ---------- */
const GRAVACOES = path.join(DADOS, 'gravacoes');
fs.mkdirSync(GRAVACOES, { recursive: true });
const gravacoes = new Map(); // id -> { dono, reuniao, partes: [{n, texto, erro, arq}], pendentes: Set }
function arqGravacao(gid) { return path.join(GRAVACOES, gid + '.json'); }
function salvarGravacao(gid, g) { try { fs.writeFileSync(arqGravacao(gid), JSON.stringify({ dono: g.dono, reuniao: g.reuniao, em: g.em, partes: g.partes })); } catch (e) {} }
function acharGravacao(gid, u) {
  if (!/^g[\w-]+$/.test(gid)) throw new Erro('Gravação não encontrada.', 404);
  let g = gravacoes.get(gid);
  if (!g && fs.existsSync(arqGravacao(gid))) { try { g = JSON.parse(fs.readFileSync(arqGravacao(gid), 'utf8')); g.pendentes = new Map(); gravacoes.set(gid, g); } catch (e) {} }
  if (!g || g.dono !== u.id) throw new Erro('Gravação não encontrada.', 404);
  return g;
}
async function transcreverGroq(buf, tipo) {
  if (!process.env.GROQ_API_KEY) throw new Erro('A transcrição não está ligada: falta a chave GROQ_API_KEY no Railway.');
  const fd = new FormData();
  const ext = /mp4|m4a/.test(tipo) ? 'm4a' : /ogg/.test(tipo) ? 'ogg' : 'webm';
  fd.append('file', new Blob([buf], { type: tipo || 'audio/webm' }), 'parte.' + ext);
  fd.append('model', process.env.GROQ_MODELO || 'whisper-large-v3-turbo');
  fd.append('language', 'pt');
  fd.append('response_format', 'text');
  fd.append('temperature', '0');
  const r = await fetch(process.env.ORA_GROQ_URL || 'https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.GROQ_API_KEY }, body: fd });
  const t = await r.text();
  if (!r.ok) throw new Erro('O Groq recusou a transcrição (' + r.status + '): ' + t.slice(0, 200));
  return t.trim();
}
async function transcreverParte(g, parte) {
  try { const buf = fs.readFileSync(parte.arq); parte.texto = await transcreverGroq(buf, parte.tipo); parte.erro = null; }
  catch (e) { parte.erro = e.message; }
}
app.post('/api/gravacao/:gid/parte', exigir, express.raw({ type: () => true, limit: '60mb' }), rota(async (req, res) => {
  const gid = req.params.gid, g = acharGravacao(gid, req.u), n = Math.max(0, Math.min(999, parseInt(req.query.n, 10) || 0));
  if (!req.body || !req.body.length) return res.json({ ok: true, vazio: true });
  const arq = path.join(GRAVACOES, gid + '-' + n + '.audio');
  fs.writeFileSync(arq, req.body);
  let parte = g.partes.find(x => x.n === n);
  if (!parte) { parte = { n }; g.partes.push(parte); }
  parte.arq = arq; parte.tipo = String(req.get('Content-Type') || 'audio/webm').slice(0, 60); parte.bytes = req.body.length;
  const p = transcreverParte(g, parte).then(() => salvarGravacao(gid, g));
  g.pendentes.set(n, p); await p; g.pendentes.delete(n);
  res.json({ ok: !parte.erro, erro: parte.erro || null, caracteres: (parte.texto || '').length });
}));

app.use('/api', express.json({ limit: '5mb' }));

/* Login */
const tentativas = new Map();
function limitar(req) {
  const ip = req.ip, agora = Date.now(), l = (tentativas.get(ip) || []).filter(t => agora - t < 10 * 60e3);
  if (l.length >= 12) throw new Erro('Muitas tentativas. Espere alguns minutos.', 429);
  l.push(agora); tentativas.set(ip, l);
}
app.get('/api/estado', (req, res) => res.json({ primeiroAcesso: db.usuarios.length === 0, logado: !!usuarioDe(req), semDisco: !dadosPersistentes() }));
app.post('/api/primeiro-acesso', rota((req, res) => {
  if (db.usuarios.length) throw new Erro('O administrador já foi criado. Entre com seu nome e senha.', 403);
  const u = { id: id('u'), nome: validarNome(req.body.nome), senha: hashSenha(validarSenha(req.body.senha)), admin: true, whatsapp: '', resumoHora: '07:30', resumoAtivo: false, criado: new Date().toISOString() };
  db.usuarios.push(u); abrirSessao(req, res, u); res.json({ eu: perfil(u) });
}));
app.post('/api/entrar', rota((req, res) => {
  limitar(req);
  const u = db.usuarios.find(x => normNome(x.nome) === normNome(req.body.nome));
  if (!u || !senhaConfere(req.body.senha, u.senha)) throw new Erro('Nome ou senha incorretos.', 401);
  abrirSessao(req, res, u); res.json({ eu: perfil(u) });
}));
app.post('/api/sair', (req, res) => {
  const t = cookies(req).ora_sessao; if (t && db.sessoes[t]) { delete db.sessoes[t]; gravar(); }
  res.set('Set-Cookie', 'ora_sessao=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax'); res.json({ ok: true });
});

/* Sincronização: cada missão, reunião, hábito etc. é um item. Itens privados só voltam para o dono. */
app.get('/api/sync', exigir, rota((req, res) => {
  const desde = Number(req.query.desde) || 0, u = req.u, itens = [];
  for (const k in db.itens) {
    const i = db.itens[k];
    if (i.seq <= desde) continue;
    if (!i.privado || i.dono === u.id) itens.push({ col: i.col, id: i.id, dados: i.apagado ? null : i.dados, apagado: !!i.apagado });
    else if (i.col === 'missoes') itens.push({ col: i.col, id: i.id, dados: null, apagado: true }); // virou pessoal de outra pessoa: some da tela dos demais
  }
  res.json({ agora: db.seq, itens, equipe: equipePublica(), eu: perfil(u) });
}));
app.post('/api/itens', exigir, rota((req, res) => {
  const ops = Array.isArray(req.body.ops) ? req.body.ops.slice(0, 2000) : [], u = req.u;
  let aceitos = 0;
  for (const op of ops) {
    if (!op || !COLS.has(op.col) || typeof op.id !== 'string' || !op.id || op.id.length > 120 || /[\u0000-\u001f]/.test(op.id)) continue;
    if (op.col === 'prefs' && op.id !== u.id) continue;
    if (op.col === 'meta' && op.id !== 'cidade') continue;
    const k = op.col + '|' + op.id, atual = db.itens[k];
    if (atual && atual.privado && atual.dono !== u.id) continue;
    if (op.apagado) {
      if (atual && !atual.apagado) { db.itens[k] = { col: op.col, id: op.id, dono: atual.dono, privado: atual.privado, apagado: true, dados: null, seq: ++db.seq }; aceitos++; }
      continue;
    }
    const dados = op.dados;
    if (!dados || typeof dados !== 'object' || Array.isArray(dados) || JSON.stringify(dados).length > 400000) continue;
    const privado = SEMPRE_PRIVADAS.has(op.col) || (op.col === 'missoes' && !!dados.privada);
    if (privado) {
      const levandoParaSi = op.col === 'missoes' && atual && !atual.privado && atual.dados && atual.dados.resp === u.id;
      if (atual && !atual.apagado && atual.dono !== u.id && !levandoParaSi) continue;
      if ('dono' in dados || op.col === 'missoes') dados.dono = u.id;
    }
    db.itens[k] = { col: op.col, id: op.id, dono: privado ? u.id : (atual && atual.dono) || u.id, privado, apagado: false, dados, seq: ++db.seq };
    aceitos++;
  }
  if (aceitos) gravar();
  res.json({ agora: db.seq, aceitos });
}));

/* Equipe */
app.get('/api/equipe', exigir, (req, res) => res.json({ equipe: equipePublica() }));
app.post('/api/equipe', exigir, exigirAdmin, rota((req, res) => {
  const nome = validarNome(req.body.nome);
  if (db.usuarios.some(x => normNome(x.nome) === normNome(nome))) throw new Erro('Já existe alguém com esse nome.');
  const u = { id: id('u'), nome, senha: hashSenha(validarSenha(req.body.senha)), admin: false, whatsapp: '', resumoHora: '07:30', resumoAtivo: false, criado: new Date().toISOString() };
  db.usuarios.push(u); gravar(); res.json({ equipe: equipePublica() });
}));
app.patch('/api/equipe/:id', exigir, exigirAdmin, rota((req, res) => {
  const u = db.usuarios.find(x => x.id === req.params.id); if (!u) throw new Erro('Pessoa não encontrada.', 404);
  if (req.body.nome !== undefined) u.nome = validarNome(req.body.nome);
  if (req.body.senha) { u.senha = hashSenha(validarSenha(req.body.senha)); for (const t in db.sessoes) if (db.sessoes[t].uid === u.id) delete db.sessoes[t]; }
  if (req.body.admin !== undefined && u.id !== req.u.id) u.admin = !!req.body.admin;
  gravar(); res.json({ equipe: equipePublica() });
}));
app.delete('/api/equipe/:id', exigir, exigirAdmin, rota((req, res) => {
  if (req.params.id === req.u.id) throw new Erro('Você não pode remover a si mesmo.');
  const u = db.usuarios.find(x => x.id === req.params.id); if (!u) throw new Erro('Pessoa não encontrada.', 404);
  db.usuarios = db.usuarios.filter(x => x.id !== u.id);
  for (const t in db.sessoes) if (db.sessoes[t].uid === u.id) delete db.sessoes[t];
  for (const k in db.itens) { const i = db.itens[k]; if (i.privado && i.dono === u.id && !i.apagado) db.itens[k] = Object.assign({}, i, { apagado: true, dados: null, seq: ++db.seq }); }
  gravar(); res.json({ equipe: equipePublica() });
}));
app.patch('/api/eu', exigir, rota((req, res) => {
  const u = req.u, b = req.body;
  if (b.nome !== undefined) { const n = validarNome(b.nome); if (db.usuarios.some(x => x.id !== u.id && normNome(x.nome) === normNome(n))) throw new Erro('Já existe alguém com esse nome.'); u.nome = n; }
  if (b.senha) u.senha = hashSenha(validarSenha(b.senha));
  if (b.whatsapp !== undefined) u.whatsapp = String(b.whatsapp).replace(/[^\d+() -]/g, '').slice(0, 20);
  if (b.resumoHora !== undefined && /^\d{2}:\d{2}$/.test(b.resumoHora)) u.resumoHora = b.resumoHora;
  if (b.resumoAtivo !== undefined) u.resumoAtivo = !!b.resumoAtivo;
  gravar(); res.json({ eu: perfil(u) });
}));

/* ---------- Resumo diário no WhatsApp ---------- */
const CITACOES = [
  ['Fazei tudo por amor, nada por obrigação.', 'São Francisco de Sales'],
  ['A ociosidade é inimiga da alma.', 'São Bento'],
  ['Não podemos fazer grandes coisas, apenas pequenas coisas com grande amor.', 'Santa Teresa de Calcutá'],
  ['Servi ao Senhor com alegria.', 'São João Bosco'],
  ['Em tudo amar e servir.', 'Santo Inácio de Loyola'],
  ['Reza, espera e não te preocupes.', 'São Pio de Pietrelcina'],
  ['Tudo o que fizerdes, fazei-o de bom coração, como para o Senhor.', 'São Paulo, Colossenses 3,23']
];
function itensVisiveis(col, u) {
  const l = [];
  for (const k in db.itens) { const i = db.itens[k]; if (i.col === col && !i.apagado && (!i.privado || i.dono === u.id)) l.push(i.dados); }
  return l;
}
function montarResumo(u) {
  const { data } = agoraNoFuso();
  const tags = {}; itensVisiveis('tags', u).forEach(t => { tags[t.id] = t.nome; });
  const abertas = itensVisiveis('missoes', u).filter(m => !m.feita);
  const minhas = abertas.filter(m => !m.privada && m.resp === u.id);
  const hoje = minhas.filter(m => m.data === data), atras = minhas.filter(m => m.data && m.data < data).sort((a, b) => a.data < b.data ? -1 : 1);
  const aprovar = abertas.filter(m => !m.privada && m.aprovador === u.id && m.aprov && m.aprov.estado === 'aguardando');
  const ajustes = minhas.filter(m => m.aprov && m.aprov.estado === 'ajustes');
  const pessoais = abertas.filter(m => m.privada && m.dono === u.id && m.data && m.data <= data);
  const reunioes = itensVisiveis('reunioes', u).filter(r => r.data === data && (r.pessoas || []).includes(u.id)).sort((a, b) => (a.inicio || '') < (b.inicio || '') ? -1 : 1);
  const habitos = itensVisiveis('habitos', u).filter(h => h.dono === u.id);
  const linha = m => '• ' + m.titulo + ((m.tags || []).length ? ' — ' + m.tags.map(t => tags[t]).filter(Boolean).join(', ') : '');
  const dataTxt = new Date(data + 'T12:00:00Z').toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const p = ['*Bom dia, ' + u.nome + '!*', '_' + dataTxt.charAt(0).toUpperCase() + dataTxt.slice(1) + '_', ''];
  const bloco = (tit, l) => { if (l.length) p.push('*' + tit + ' (' + l.length + ')*', ...l, ''); };
  bloco('Reuniões', reunioes.map(r => '• ' + (r.inicio || '') + ' ' + r.titulo + (r.local ? ' — ' + r.local : '')));
  bloco('Missões de hoje', hoje.map(linha));
  bloco('Atrasadas', atras.map(linha));
  bloco('Para você aprovar', aprovar.map(linha));
  bloco('Ajustes pedidos', ajustes.map(m => linha(m) + (m.aprov.nota ? '\n   _' + m.aprov.nota + '_' : '')));
  bloco('Pessoal', pessoais.map(m => '• ' + m.titulo));
  bloco('Hábitos', habitos.map(h => '• ' + h.nome + (h.minimo ? ' (mínimo: ' + h.minimo + ')' : '')));
  if (p.length === 3) p.push('Nenhuma missão para hoje. Deo gratias!', '');
  const c = CITACOES[Math.floor(Math.random() * CITACOES.length)];
  p.push('“' + c[0] + '” — ' + c[1]);
  if (APP_URL) p.push('', 'Abrir o Ora et Labora: ' + APP_URL);
  return p.join('\n');
}
function numeroWhatsapp(n) { let d = String(n || '').replace(/\D/g, ''); if (d.length === 10 || d.length === 11) d = '55' + d; return d; }
function provedor() {
  if (process.env.ZAPI_INSTANCIA && process.env.ZAPI_TOKEN) return 'zapi';
  if (process.env.EVOLUTION_URL && process.env.EVOLUTION_INSTANCIA && process.env.EVOLUTION_CHAVE) return 'evolution';
  return null;
}
async function enviarWhatsapp(num, texto) {
  const phone = numeroWhatsapp(num), qual = provedor();
  if (phone.length < 12) throw new Erro('Número de WhatsApp inválido. Use DDD + número.');
  if (!qual) throw new Erro('O WhatsApp do servidor ainda não foi configurado. Veja o passo do WhatsApp no guia.');
  let r;
  if (qual === 'zapi') {
    const h = { 'Content-Type': 'application/json' }; if (process.env.ZAPI_CLIENT_TOKEN) h['Client-Token'] = process.env.ZAPI_CLIENT_TOKEN;
    r = await fetch('https://api.z-api.io/instances/' + encodeURIComponent(process.env.ZAPI_INSTANCIA) + '/token/' + encodeURIComponent(process.env.ZAPI_TOKEN) + '/send-text',
      { method: 'POST', headers: h, body: JSON.stringify({ phone, message: texto }) });
  } else {
    r = await fetch(process.env.EVOLUTION_URL.replace(/\/$/, '') + '/message/sendText/' + encodeURIComponent(process.env.EVOLUTION_INSTANCIA),
      { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: process.env.EVOLUTION_CHAVE }, body: JSON.stringify({ number: phone, text: texto }) });
  }
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Erro('O provedor de WhatsApp recusou o envio (' + r.status + '). ' + t.slice(0, 160), 502); }
}
app.post('/api/whatsapp/teste', exigir, rota(async (req, res) => {
  if (!req.u.whatsapp) throw new Erro('Salve seu número de WhatsApp primeiro.');
  await enviarWhatsapp(req.u.whatsapp, montarResumo(req.u));
  res.json({ ok: true });
}));
function minutos(h) { const [a, b] = String(h).split(':').map(Number); return a * 60 + b; }
async function rodarResumos() {
  const { data, hora } = agoraNoFuso(), agora = minutos(hora);
  for (const u of db.usuarios) {
    if (!u.resumoAtivo || !u.whatsapp || db.enviados[u.id] === data) continue;
    const alvo = minutos(u.resumoHora || '07:30');
    if (agora < alvo || agora > alvo + 120) continue;
    db.enviados[u.id] = data; gravar();
    try { await enviarWhatsapp(u.whatsapp, montarResumo(u)); console.log('[resumo] enviado para ' + u.nome); }
    catch (e) { console.error('[resumo] falhou para ' + u.nome + ': ' + e.message); }
  }
}
setInterval(() => { rodarResumos().catch(e => console.error(e)); backupDiario(); }, 30000);

app.get('/api/ia/estado', exigir, (req, res) => res.json({ transcricao: !!process.env.GROQ_API_KEY, extracao: !!process.env.ANTHROPIC_API_KEY }));
app.post('/api/gravacao', exigir, rota((req, res) => {
  const gid = id('g'), g = { dono: req.u.id, reuniao: String(req.body.reuniao || '').slice(0, 120), em: new Date().toISOString(), partes: [], pendentes: new Map() };
  gravacoes.set(gid, g); salvarGravacao(gid, g);
  res.json({ id: gid, transcricao: !!process.env.GROQ_API_KEY, extracao: !!process.env.ANTHROPIC_API_KEY });
}));
/* Claude lê a transcrição e devolve ata + demandas no formato das missões */
const FERRAMENTA_ATA = {
  name: 'registrar_reuniao',
  description: 'Registra a ata da reunião e as demandas (tarefas) que surgiram nela.',
  input_schema: {
    type: 'object',
    properties: {
      resumo: { type: 'string', description: 'Resumo da reunião em 2 a 5 frases, em português.' },
      decisoes: { type: 'array', items: { type: 'string' }, description: 'Decisões tomadas, uma por item. Vazio se não houve.' },
      demandas: {
        type: 'array',
        description: 'Cada tarefa concreta que alguém precisa fazer depois da reunião. Não invente tarefas; só o que foi combinado ou pedido.',
        items: {
          type: 'object',
          properties: {
            titulo: { type: 'string', description: 'Título curto e acionável, começando por verbo (até 90 caracteres).' },
            descricao: { type: 'string', description: 'Detalhes úteis ditos na reunião: contexto, links, como entregar. Pode ficar vazio.' },
            responsavel: { type: 'string', description: 'Nome exato de alguém da lista da equipe, ou vazio se não ficou claro.' },
            data: { type: 'string', description: 'Prazo no formato AAAA-MM-DD, calculado a partir da data de hoje. Vazio se não houve prazo.' },
            cliente: { type: 'string', description: 'Nome exato de um cliente da lista, ou vazio.' },
            peso: { type: 'string', enum: ['minima', 'leve', 'media', 'ardua', 'heroica'], description: 'Esforço: minima (minutos), leve (até 1h), media (meio dia), ardua (1 a 2 dias), heroica (vários dias).' },
            tipo: { type: 'string', enum: ['', 'reuniao', 'rapida', 'mensagem', 'trafego', 'complexa'], description: 'rapida = tarefa curta; mensagem = mandar mensagem ou cobrar alguém; trafego = anúncios e campanhas; complexa = trabalho grande; reuniao = assunto para outra reunião.' },
            trecho: { type: 'string', description: 'Frase curta da transcrição que originou a demanda.' }
          },
          required: ['titulo', 'responsavel', 'data', 'peso']
        }
      }
    },
    required: ['resumo', 'decisoes', 'demandas']
  }
};
async function extrairAta(texto, ctx) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Erro('A leitura das demandas não está ligada: falta a chave ANTHROPIC_API_KEY no Railway.');
  ctx = ctx && typeof ctx === 'object' ? ctx : {};
  const lista = (a) => (Array.isArray(a) ? a : []).map(x => String(x).slice(0, 60)).slice(0, 80).join(', ') || '(nenhum)';
  const sistema = 'Você é o secretário de uma agência de marketing brasileira. Lê a transcrição de uma reunião (feita automaticamente, pode ter erros de reconhecimento de voz e não identifica quem fala) e registra a ata e as demandas. Escreva em português do Brasil. Use apenas nomes das listas dadas; se um nome ouvido for parecido com um da lista, use o da lista. Prazos relativos ("sexta", "semana que vem", "amanhã") viram datas a partir de hoje. Não crie demandas genéricas nem repetidas.';
  const usuario = 'Hoje: ' + String(ctx.hoje || '').slice(0, 60) + '\nReunião: ' + String(ctx.titulo || '').slice(0, 200) +
    '\nParticipantes: ' + lista(ctx.participantes) + '\nEquipe (responsáveis possíveis): ' + lista(ctx.equipe) + '\nClientes: ' + lista(ctx.clientes) +
    (ctx.quem ? '\nQuem gravou: ' + String(ctx.quem).slice(0, 60) + ' (quando alguém diz "eu faço", e não dá para saber quem, deixe o responsável vazio)' : '') +
    '\n\nTranscrição:\n"""\n' + texto.slice(0, 180000) + '\n"""';
  const r = await fetch(process.env.ORA_ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODELO || 'claude-sonnet-5-5', max_tokens: 6000, system: sistema, tools: [FERRAMENTA_ATA], tool_choice: { type: 'tool', name: 'registrar_reuniao' }, messages: [{ role: 'user', content: usuario }] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Erro('O Claude recusou a leitura (' + r.status + '): ' + String((j.error && j.error.message) || '').slice(0, 200));
  const bloco = (j.content || []).find(c => c.type === 'tool_use');
  if (!bloco || !bloco.input) throw new Erro('O Claude não devolveu a ata. Tente de novo.');
  const a = bloco.input;
  return { resumo: String(a.resumo || ''), decisoes: (a.decisoes || []).map(String).slice(0, 40), demandas: (a.demandas || []).slice(0, 60).map(d => ({ titulo: String(d.titulo || '').slice(0, 200), descricao: String(d.descricao || '').slice(0, 2000), responsavel: String(d.responsavel || ''), data: /^\d{4}-\d{2}-\d{2}$/.test(d.data || '') ? d.data : '', cliente: String(d.cliente || ''), peso: d.peso || 'media', tipo: d.tipo || '', trecho: String(d.trecho || '').slice(0, 300) })) };
}
function guardarTranscricao(texto, nome, u) {
  const aid = id('a'), buf = Buffer.from(texto, 'utf8');
  fs.writeFileSync(path.join(ANEXOS, aid), buf);
  db.anexos[aid] = { nome: String(nome || 'transcricao').slice(0, 180) + '.txt', tipo: 'text/plain; charset=utf-8', tam: buf.length, dono: u.id, em: new Date().toISOString() };
  gravar(); return { id: aid, nome: db.anexos[aid].nome, tipo: 'text/plain', tam: buf.length };
}
app.post('/api/gravacao/:gid/finalizar', exigir, rota(async (req, res) => {
  const gid = req.params.gid, g = acharGravacao(gid, req.u);
  await Promise.all(Array.from(g.pendentes.values()));
  for (const p of g.partes) if (!p.texto && p.arq && fs.existsSync(p.arq)) await transcreverParte(g, p);   /* tenta de novo o que falhou */
  salvarGravacao(gid, g);
  const falhas = g.partes.filter(p => !p.texto && p.erro);
  const texto = g.partes.slice().sort((a, b) => a.n - b.n).map(p => p.texto || '').filter(Boolean).join('\n\n');
  if (!texto) throw new Erro(falhas.length ? falhas[0].erro : 'Não deu para ouvir nada na gravação. Confira se o áudio da aba foi compartilhado.');
  const ctx = req.body.contexto || {};
  const anexo = guardarTranscricao(texto, 'Transcrição · ' + (ctx.titulo || 'reunião'), req.u);
  let ata = null, erroAta = null;
  try { ata = await extrairAta(texto, Object.assign({}, ctx, { quem: req.u.nome })); } catch (e) { erroAta = e.message; }
  for (const p of g.partes) if (p.arq) { try { fs.unlinkSync(p.arq); } catch (e) {} }   /* o áudio não fica guardado, só o texto */
  try { fs.unlinkSync(arqGravacao(gid)); } catch (e) {}
  gravacoes.delete(gid);
  res.json({ transcricao: anexo, caracteres: texto.length, ata, erroAta, partesComFalha: falhas.length });
}));
app.post('/api/ia/extrair', exigir, rota(async (req, res) => {
  const texto = String(req.body.texto || '').trim();
  if (texto.length < 40) throw new Erro('Cole a transcrição inteira da reunião.');
  const ctx = req.body.contexto || {};
  const anexo = guardarTranscricao(texto, 'Transcrição · ' + (ctx.titulo || 'reunião'), req.u);
  const ata = await extrairAta(texto, Object.assign({}, ctx, { quem: req.u.nome }));
  res.json({ transcricao: anexo, ata });
}));

app.use((req, res) => res.status(404).type('text').send('Página não encontrada.'));
app.listen(PORTA, () => {
  backupDiario();
  if (!dadosPersistentes()) console.warn('[dados] ATENÇÃO: os dados estão em ' + DADOS + ', fora de um volume. Eles serão apagados na próxima atualização. Crie um Volume no Railway com Mount path /data.');
  console.log('Ora et Labora rodando na porta ' + PORTA + ' · dados em ' + DADOS + ' · WhatsApp: ' + (provedor() || 'não configurado') + ' · transcrição: ' + (process.env.GROQ_API_KEY ? 'Groq' : 'desligada') + ' · demandas: ' + (process.env.ANTHROPIC_API_KEY ? 'Claude' : 'desligado'));
});
