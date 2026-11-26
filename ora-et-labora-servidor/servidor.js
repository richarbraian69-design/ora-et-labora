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
const COLS = new Set(['missoes', 'reunioes', 'tags', 'criativos', 'habitos', 'registros', 'revisoes', 'exames', 'oferecimentos', 'modelos', 'dras', 'copies', 'meta', 'prefs']);
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
  const icones = fs.existsSync(path.join(__dirname, 'publico', 'icones', 'apple-touch-icon.png'))
    ? '<link rel="icon" type="image/png" sizes="32x32" href="/icones/favicon-32.png"><link rel="icon" type="image/png" sizes="64x64" href="/icones/favicon-64.png"><link rel="apple-touch-icon" sizes="180x180" href="/icones/apple-touch-icon.png"><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#14110D"><meta name="apple-mobile-web-app-title" content="Ora et Labora"><meta name="application-name" content="Ora et Labora"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">'
    : '<link rel="icon" href="' + ICONE + '">';
  return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + icones + '<script>window.ORA_SERVIDOR=true</script>' + corpo + '</html>';
}
const MANIFESTO = JSON.stringify({
  name: 'Ora et Labora', short_name: 'Ora et Labora', start_url: '/', scope: '/', display: 'standalone',
  background_color: '#14110D', theme_color: '#14110D', lang: 'pt-BR',
  icons: [
    { src: '/icones/icone-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icones/icone-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icones/icone-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    { src: '/icones/icone-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
});
app.get('/manifest.webmanifest', (req, res) => { res.set('Cache-Control', 'public, max-age=86400'); res.type('application/manifest+json').send(MANIFESTO); });
app.use('/icones', express.static(path.join(__dirname, 'publico', 'icones'), { maxAge: '7d', index: false, fallthrough: false }));
app.get(['/favicon.ico', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png'], (req, res) => {
  res.set('Cache-Control', 'public, max-age=604800');
  res.sendFile(path.join(__dirname, 'publico', 'icones', req.path === '/favicon.ico' ? 'favicon-64.png' : 'apple-touch-icon.png'));
});
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
  const sistema = (ctx.tipo === 'ata'
    ? 'Você é o secretário de uma agência de marketing brasileira. Lê a ata pronta de uma reunião (escrita por alguém da equipe ou gerada pelo Meet/Zoom) e registra um resumo curto, as decisões e as demandas que ela pede.'
    : 'Você é o secretário de uma agência de marketing brasileira. Lê a transcrição de uma reunião (feita automaticamente, pode ter erros de reconhecimento de voz e não identifica quem fala) e registra a ata e as demandas.') + ' Escreva em português do Brasil. Use apenas nomes das listas dadas; se um nome ouvido for parecido com um da lista, use o da lista. Prazos relativos ("sexta", "semana que vem", "amanhã") viram datas a partir de hoje. Não crie demandas genéricas nem repetidas.';
  const usuario = 'Hoje: ' + String(ctx.hoje || '').slice(0, 60) + '\nReunião: ' + String(ctx.titulo || '').slice(0, 200) +
    '\nParticipantes: ' + lista(ctx.participantes) + '\nEquipe (responsáveis possíveis): ' + lista(ctx.equipe) + '\nClientes: ' + lista(ctx.clientes) +
    (ctx.quem ? '\nQuem gravou: ' + String(ctx.quem).slice(0, 60) + ' (quando alguém diz "eu faço", e não dá para saber quem, deixe o responsável vazio)' : '') +
    (ctx.tipo === 'ata' ? '\n\nAta:\n"""\n' : '\n\nTranscrição:\n"""\n') + texto.slice(0, 180000) + '\n"""';
  const r = await fetch(process.env.ORA_ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    /* tool_choice "auto": alguns modelos novos não aceitam forçar a ferramenta; se vier texto, lemos o JSON dele */
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODELO || 'claude-sonnet-5-5', max_tokens: 8000, system: sistema + ' Responda sempre chamando a ferramenta registrar_reuniao, uma única vez, sem texto antes ou depois.', tools: [FERRAMENTA_ATA], tool_choice: { type: 'auto' }, messages: [{ role: 'user', content: usuario }] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Erro('O Claude recusou a leitura (' + r.status + '): ' + String((j.error && j.error.message) || '').slice(0, 200));
  const bloco = (j.content || []).find(c => c.type === 'tool_use');
  let a = bloco && bloco.input;
  if (!a) {
    const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    const ini = txt.indexOf('{'), fim = txt.lastIndexOf('}');
    try { a = JSON.parse(txt.slice(ini, fim + 1)); } catch (e) { a = null; }
  }
  if (!a || typeof a !== 'object') throw new Erro('O Claude não devolveu a ata. Tente de novo.');
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
/* ler de novo uma transcrição já guardada (quando a leitura das demandas falhou) */
app.post('/api/ia/reler', exigir, rota(async (req, res) => {
  const aid = String(req.body.anexo || ''), a = /^a[\w-]+$/.test(aid) && db.anexos[aid];
  if (!a) throw new Erro('Transcrição não encontrada.', 404);
  const texto = fs.readFileSync(path.join(ANEXOS, aid), 'utf8');
  const ata = await extrairAta(texto, Object.assign({}, req.body.contexto || {}, { quem: req.u.nome }));
  res.json({ ata });
}));
app.post('/api/ia/extrair', exigir, rota(async (req, res) => {
  const texto = String(req.body.texto || '').trim(), ehAta = req.body.tipo === 'ata';
  if (texto.length < (ehAta ? 10 : 40)) throw new Erro(ehAta ? 'Cole a ata da reunião.' : 'Cole a transcrição inteira da reunião.');
  const ctx = Object.assign({}, req.body.contexto || {}, { tipo: ehAta ? 'ata' : 'transcricao' });
  const anexo = guardarTranscricao(texto, (ehAta ? 'Ata · ' : 'Transcrição · ') + (ctx.titulo || 'reunião'), req.u);
  /* ata pronta: guarda sempre; a leitura das demandas é opcional e, se falhar, a ata fica salva mesmo assim */
  if (ehAta) {
    if (req.body.ler === false) return res.json({ transcricao: anexo, ata: null });
    let ata = null, erroAta = null;
    try { ata = await extrairAta(texto, Object.assign({}, ctx, { quem: req.u.nome })); } catch (e) { erroAta = e.message; }
    return res.json({ transcricao: anexo, ata, erroAta });
  }
  const ata = await extrairAta(texto, Object.assign({}, ctx, { quem: req.u.nome }));
  res.json({ transcricao: anexo, ata });
}));

/* ---------- Porta do JARVIS: o assistente do Mac lê e cuida das missões sem abrir a tela ----------
 * Liga com a variável JARVIS_TOKEN_SHA256 no Railway: a impressão digital (SHA-256, em hex) da chave
 * que fica só no Mac do JARVIS; assim o servidor nunca guarda a chave em si. JARVIS_TOKEN (a chave
 * inteira, 32+ caracteres) também serve. Sem nenhuma das duas, nada disto existe.
 * O JARVIS age como JARVIS_USUARIO (nome de alguém da equipe; padrão: o administrador).
 * De propósito, não apaga nada e não conclui missão (concluir dá as obras e visitas da cidade no app). */
const JARVIS_TOKEN = String(process.env.JARVIS_TOKEN || ''), JARVIS_SHA = String(process.env.JARVIS_TOKEN_SHA256 || '').trim().toLowerCase();
function hashToken(t) { return crypto.createHash('sha256').update(String(t)).digest(); }
const JARVIS_HASH = /^[0-9a-f]{64}$/.test(JARVIS_SHA) ? Buffer.from(JARVIS_SHA, 'hex') : JARVIS_TOKEN.length >= 32 ? hashToken(JARVIS_TOKEN) : null;
function exigirJarvis(req, res, next) {
  if (!JARVIS_HASH) return res.status(404).type('text').send('Página não encontrada.');
  const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
  if (!m || !crypto.timingSafeEqual(hashToken(m[1]), JARVIS_HASH)) {
    try { limitar(req); } catch (e) { return res.status(429).json({ erro: e.message }); }
    return res.status(401).json({ erro: 'Chave do JARVIS inválida.' });
  }
  const alvo = normNome(process.env.JARVIS_USUARIO || '');
  const u = (alvo && db.usuarios.find(x => normNome(x.nome) === alvo)) || db.usuarios.find(x => x.admin);
  if (!u) return res.status(503).json({ erro: 'Ainda não há ninguém cadastrado no Ora et Labora.' });
  req.u = u; next();
}
const TIPOS = ['reuniao', 'rapida', 'mensagem', 'trafego', 'complexa'];
function nomePessoa(uid) { const p = db.usuarios.find(x => x.id === uid); return p ? p.nome : null; }
function clientesMapa(u) { const o = {}; itensVisiveis('tags', u).forEach(t => { if (t && t.id) o[t.id] = t.nome; }); return o; }
function acharPorNome(lista, nome, oque) {   // exato; senão, começo do nome; senão, contém (só se for único)
  const n = normNome(nome); if (!n) return null;
  let l = lista.filter(x => normNome(x.nome) === n);
  if (!l.length && n.length >= 3) l = lista.filter(x => normNome(x.nome).startsWith(n));
  if (!l.length && n.length >= 3) l = lista.filter(x => normNome(x.nome).includes(n));
  if (l.length === 1) return l[0];
  throw new Erro(l.length ? oque + ' "' + nome + '" é ambíguo: ' + l.map(x => x.nome).join(', ') + '.' : oque + ' "' + nome + '" não encontrado.', l.length ? 409 : 404);
}
function pessoaId(nome) { return acharPorNome(db.usuarios, nome, 'Pessoa').id; }
function clientesIds(nomes, u) {
  const tags = itensVisiveis('tags', u).filter(t => t && t.id && t.nome);
  return (Array.isArray(nomes) ? nomes : [nomes]).filter(Boolean).slice(0, 10).map(n => acharPorNome(tags, String(n), 'Cliente').id);
}
function dataOk(d) { if (d === null || d === '') return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) throw new Erro('Data no formato AAAA-MM-DD.'); return String(d); }
function texto(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max); }
function missaoItem(mid, u) {
  const i = db.itens['missoes|' + mid];
  if (!i || i.apagado || (i.privado && i.dono !== u.id)) throw new Erro('Missão não encontrada.', 404);
  return i;
}
function registrarHist(m, u, t) { m.historico = m.historico || []; m.historico.push({ em: new Date().toISOString(), por: u.id, t: t + ' (pelo JARVIS)' }); if (m.historico.length > 60) m.historico = m.historico.slice(-60); }
function gravarMissao(m, i, u) { db.itens['missoes|' + m.id] = { col: 'missoes', id: m.id, dono: i ? i.dono : u.id, privado: !!m.privada, apagado: false, dados: m, seq: ++db.seq }; gravar(); }
function resumoMissao(m, cli, hoje, completa) {
  const r = { id: m.id, titulo: m.titulo, resp: nomePessoa(m.resp), data: m.data || null, feita: !!m.feita, atrasada: !m.feita && !!m.data && m.data < hoje,
    peso: m.peso || 'media', tipo: m.tipo || null, clientes: (m.tags || []).map(t => cli[t]).filter(Boolean), privada: !!m.privada,
    aprovador: m.aprovador ? nomePessoa(m.aprovador) : null, aprovacao: m.aprov ? m.aprov.estado || null : null,
    subtarefas: (m.subs || []).length, comentarios: (m.comentarios || []).length, repete: m.recorrencia || null };
  if (!completa) { if (m.descricao) r.descricao = String(m.descricao).slice(0, 280); return r; }
  return Object.assign(r, { descricao: m.descricao || '', feitaEm: m.feitaEm || null, criadaPor: nomePessoa(m.criadaPor), criadaEm: m.criadaEm || null,
    subs: (m.subs || []).map(s => ({ titulo: s.titulo, resp: nomePessoa(s.resp), feita: !!s.feita })),
    ultimosComentarios: (m.comentarios || []).slice(-10).map(c => ({ por: nomePessoa(c.por), em: c.em, texto: c.texto })),
    historico: (m.historico || []).slice(-10).map(h => ({ por: nomePessoa(h.por), em: h.em, t: h.t })) });
}
const jarvis = express.Router();
jarvis.use(exigirJarvis);
jarvis.get('/contexto', (req, res) => {
  const { data, hora } = agoraNoFuso();
  res.json({ eu: req.u.nome, hoje: data, hora, equipe: db.usuarios.map(u => u.nome), clientes: Object.values(clientesMapa(req.u)).sort(), pesos: ['minima', 'leve', 'media', 'ardua', 'heroica'], tipos: TIPOS });
});
jarvis.get('/missoes', rota((req, res) => {
  const q = req.query, u = req.u, hoje = agoraNoFuso().data, cli = clientesMapa(u);
  const estado = ['abertas', 'feitas', 'todas'].includes(q.estado) ? q.estado : 'abertas';
  const resp = q.resp ? pessoaId(q.resp) : null, cliente = q.cliente ? clientesIds(q.cliente, u)[0] : null;
  const de = q.de ? dataOk(q.de) : null, ate = q.ate ? dataOk(q.ate) : null, busca = normNome(q.busca || '');
  const limite = Math.max(1, Math.min(200, parseInt(q.limite, 10) || 50));
  let l = itensVisiveis('missoes', u).filter(m => m && m.id && (estado === 'todas' || (estado === 'feitas') === !!m.feita));
  if (resp) l = l.filter(m => m.resp === resp);
  if (cliente) l = l.filter(m => (m.tags || []).includes(cliente));
  if (de) l = l.filter(m => m.data && m.data >= de);
  if (ate) l = l.filter(m => m.data && m.data <= ate);
  if (busca) l = l.filter(m => normNome(m.titulo + ' ' + (m.descricao || '')).includes(busca));
  l.sort((a, b) => (a.data || '9999') < (b.data || '9999') ? -1 : (a.data || '9999') > (b.data || '9999') ? 1 : 0);
  res.json({ hoje, total: l.length, missoes: l.slice(0, limite).map(m => resumoMissao(m, cli, hoje)) });
}));
jarvis.get('/resumo', (req, res) => {
  manterSeries();
  const u = req.u, hoje = agoraNoFuso().data, cli = clientesMapa(u);
  const abertas = itensVisiveis('missoes', u).filter(m => m && !m.feita), r = m => resumoMissao(m, cli, hoje);
  const minhas = abertas.filter(m => (m.privada ? m.dono : m.resp) === u.id);
  res.json({ hoje, eu: u.nome,
    hojeMinhas: minhas.filter(m => m.data === hoje).map(r),
    atrasadasMinhas: minhas.filter(m => m.data && m.data < hoje).map(r),
    paraEuAprovar: abertas.filter(m => !m.privada && m.aprovador === u.id && m.aprov && m.aprov.estado === 'aguardando').map(r),
    ajustesPedidos: minhas.filter(m => m.aprov && m.aprov.estado === 'ajustes').map(r),
    equipeAtrasadas: abertas.filter(m => !m.privada && m.data && m.data < hoje && m.resp !== u.id).map(r),
    reunioesHoje: itensVisiveis('reunioes', u).filter(x => x && x.data === hoje && !x.feita).sort((a, b) => (a.inicio || '') < (b.inicio || '') ? -1 : 1).map(x => resumoReuniao(x, cli)) });
});
jarvis.get('/missoes/:id', rota((req, res) => {
  res.json(resumoMissao(missaoItem(req.params.id, req.u).dados, clientesMapa(req.u), agoraNoFuso().data, true));
}));
function aplicarCampos(m, b, u) {
  if (b.titulo !== undefined) { m.titulo = texto(b.titulo, 200); if (!m.titulo) throw new Erro('A missão precisa de um título.'); }
  if (b.descricao !== undefined) m.descricao = texto(b.descricao, 5000);
  if (b.resp !== undefined) m.resp = b.resp ? pessoaId(b.resp) : u.id;
  if (b.data !== undefined) m.data = dataOk(b.data);
  if (b.peso !== undefined) { if (!PESOS_OK.has(b.peso)) throw new Erro('Peso: minima, leve, media, ardua ou heroica.'); m.peso = b.peso; }
  if (b.tipo !== undefined) m.tipo = b.tipo ? texto(b.tipo, 30) : null;
  if (b.clientes !== undefined) m.tags = clientesIds(b.clientes, u);
  if (b.aprovador !== undefined) m.aprovador = b.aprovador ? pessoaId(b.aprovador) : null;
  if (b.recorrencia !== undefined) m.recorrencia = recOk(b.recorrencia);
}
const PESOS_OK = new Set(['minima', 'leve', 'media', 'ardua', 'heroica']);
// O dono (primeiro administrador) aprova toda missão de equipe cujo responsável é outra pessoa.
function aprovDono(m) { const d = db.usuarios.find(x => x.admin); if (d && !m.privada && !m.feita && m.resp && m.resp !== d.id) m.aprovador = d.id; }
jarvis.post('/missoes', rota((req, res) => {
  const u = req.u, b = req.body || {}, agora = new Date().toISOString();
  const m = { id: 'm' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex').slice(0, 4), titulo: '', descricao: '', resp: u.id, data: null, peso: 'media',
    feita: false, feitaEm: null, tags: [], anexos: [], subs: [], recorrencia: null, tipo: null, aprovador: null, aprov: null,
    privada: !!b.privada, dono: b.privada ? u.id : null, area: null, criadaPor: u.id, criadaEm: agora };
  aplicarCampos(m, Object.assign({ titulo: '' }, b), u);
  if (m.privada) m.resp = u.id;
  aprovDono(m);
  registrarHist(m, u, 'criou a missão');
  gravarMissao(m, null, u);
  res.json(resumoMissao(m, clientesMapa(u), agoraNoFuso().data, true));
}));
jarvis.patch('/missoes/:id', rota((req, res) => {
  const u = req.u, i = missaoItem(req.params.id, u), m = JSON.parse(JSON.stringify(i.dados)), b = req.body || {};
  const mudou = ['titulo', 'descricao', 'resp', 'data', 'peso', 'tipo', 'clientes', 'aprovador', 'recorrencia'].filter(k => b[k] !== undefined);
  if (!mudou.length) throw new Erro('Nada para mudar. Campos: titulo, descricao, resp, data, peso, tipo, clientes, aprovador, recorrencia.');
  if (b.recorrencia !== undefined && b.recorrencia && !m.data && b.data === undefined) throw new Erro('Missão que se repete precisa de data.');
  if (m.feita) throw new Erro('Essa missão já foi cumprida; reabra pelo app se precisar mudar.');
  aplicarCampos(m, b, u);
  if (m.privada) m.resp = m.dono;
  aprovDono(m);
  registrarHist(m, u, 'mudou ' + mudou.join(', '));
  gravarMissao(m, i, u);
  res.json(resumoMissao(m, clientesMapa(u), agoraNoFuso().data, true));
}));
jarvis.post('/missoes/:id/comentarios', rota((req, res) => {
  const u = req.u, i = missaoItem(req.params.id, u), m = JSON.parse(JSON.stringify(i.dados)), t = texto((req.body || {}).texto, 3000);
  if (!t) throw new Erro('Comentário vazio.');
  const mencoes = db.usuarios.filter(p => normNome(t).includes('@' + normNome(p.nome))).map(p => p.id);
  m.comentarios = m.comentarios || [];
  m.comentarios.push({ id: 'c' + crypto.randomBytes(6).toString('hex'), por: u.id, em: new Date().toISOString(), texto: t, mencoes, via: 'jarvis' });
  gravarMissao(m, i, u);
  res.json({ ok: true, comentarios: m.comentarios.length });
}));
/* ── Reuniões, concluir e subtarefas pelo JARVIS (15/11/2026). Fazem o mesmo que a tela:
   recorrência, aprovação e histórico. Apagar continua só no app. ── */
function resumoReuniao(r, cli, prevista) {
  return { id: r.id, prevista: !!prevista, titulo: r.titulo, data: r.data, inicio: r.inicio || '', fim: r.fim || '', local: r.local || '', descricao: r.descricao ? String(r.descricao).slice(0, 280) : '',
    pessoas: (r.pessoas || []).map(nomePessoa).filter(Boolean), clientes: (r.tags || []).map(t => cli[t]).filter(Boolean), feita: !!r.feita, repete: r.recorrencia || null,
    ata: !!(r.ata && (r.ata.transcricao || r.ata.resumo)), ata_em: (r.ata && r.ata.em) || '' };
}
function horaOk(h, campo) { if (h === null || h === '') return ''; if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(h))) throw new Erro(campo + ' no formato HH:MM.'); return String(h); }
function reuniaoItem(rid) {
  const i = db.itens['reunioes|' + rid];
  if (!i || i.apagado || !i.dados) throw new Erro('Reunião não encontrada.', 404);
  return i;
}
function gravarReuniao(r, i, u) { db.itens['reunioes|' + r.id] = { col: 'reunioes', id: r.id, dono: i ? i.dono : u.id, privado: false, apagado: false, dados: r, seq: ++db.seq }; gravar(); }
function camposReuniao(r, b, u) {
  if (b.titulo !== undefined) { r.titulo = texto(b.titulo, 200); if (!r.titulo) throw new Erro('A reunião precisa de um título.'); }
  if (b.data !== undefined) { r.data = dataOk(b.data); if (!r.data) throw new Erro('A reunião precisa de uma data.'); }
  if (b.inicio !== undefined) { r.inicio = horaOk(b.inicio, 'Início'); if (!r.inicio) throw new Erro('A reunião precisa de um horário de início.'); }
  if (b.fim !== undefined) r.fim = horaOk(b.fim, 'Fim');
  if (r.fim && r.fim <= r.inicio) throw new Erro('O fim precisa ser depois do início.');
  if (b.local !== undefined) r.local = texto(b.local, 200);
  if (b.descricao !== undefined) r.descricao = texto(b.descricao, 5000);
  if (b.pessoas !== undefined) { const l = (Array.isArray(b.pessoas) ? b.pessoas : [b.pessoas]).filter(Boolean).slice(0, 30).map(n => pessoaId(String(n))); r.pessoas = l.length ? Array.from(new Set(l)) : [u.id]; }
  if (b.clientes !== undefined) r.tags = clientesIds(b.clientes, u);
  if (b.recorrencia !== undefined) { r.recorrencia = recOk(b.recorrencia); if (r.recorrencia && !r.serie) r.serie = r.id; }
}
/* repetição: os mesmos valores da tela (Não se repete, Todo dia, Dias úteis, Toda semana, Quinzenal,
   Todo mês, e o personalizado "cada:N:dia|semana|mes|ano[:dias da semana 0-6]") */
const REC_NOMES = { 'diaria': 'diaria', 'todo dia': 'diaria', 'todos os dias': 'diaria', 'uteis': 'uteis', 'dias uteis': 'uteis',
  'semanal': 'semanal', 'toda semana': 'semanal', 'quinzenal': 'quinzenal', 'mensal': 'mensal', 'todo mes': 'mensal' };
function recOk(v) {
  if (v === null || v === undefined || v === '' || v === false || normNome(v) === 'nao se repete') return null;
  const n = normNome(v);
  if (REC_NOMES[n]) return REC_NOMES[n];
  if (lerRec(n)) return n;
  throw new Erro('Repetição: diaria, uteis, semanal, quinzenal, mensal, ou "cada:N:dia|semana|mes|ano" (semana pode ter os dias: cada:1:semana:1,3 = segunda e quarta).');
}
function proximaReuniaoData(base, rec, minimo) {
  const d = new Date(base + 'T00:00:00Z'), dd = d.getUTCDate(), lim = new Date(minimo + 'T00:00:00Z');
  let g = 0;
  do { if (!passoRec(d, rec, dd)) return null; } while (d < lim && ++g < 3000);
  return d.toISOString().slice(0, 10);
}
function maisDias(ds, n) { const d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function ultimasDasSeries() {
  const series = {};
  for (const k in db.itens) {
    const i = db.itens[k];
    if (i.col !== 'reunioes' || i.apagado || !i.dados || !i.dados.serie) continue;
    const u = series[i.dados.serie];
    if (!u || i.dados.data > u.dados.data) series[i.dados.serie] = i;
  }
  return series;
}
/* o mesmo que a tela faz ao abrir (manterSeriesReunioes): a reunião que se repete ganha a próxima
   quando a última já passou ou foi feita. O id é o mesmo que a tela daria, então não duplica. */
function manterSeries() {
  const hoje = agoraNoFuso().data, series = ultimasDasSeries();
  let criou = false;
  for (const k in series) {
    const i = series[k], u = i.dados;
    if (!u.recorrencia || (u.data >= hoje && !u.feita)) continue;
    const nd = proximaReuniaoData(u.data, u.recorrencia, u.data < hoje ? hoje : maisDias(hoje, 1)); if (!nd) continue;
    const nid = 'r' + k + '@' + nd; if (db.itens['reunioes|' + nid]) continue;
    const r = { id: nid, serie: k, titulo: u.titulo, data: nd, inicio: u.inicio, fim: u.fim || '', pessoas: (u.pessoas || []).slice(), local: u.local || '',
      descricao: u.descricao || '', tags: (u.tags || []).slice(), recorrencia: u.recorrencia, exemplo: !!u.exemplo, criadaPor: u.criadaPor, feita: false };
    db.itens['reunioes|' + nid] = { col: 'reunioes', id: nid, dono: i.dono, privado: false, apagado: false, dados: r, seq: ++db.seq };
    criou = true;
  }
  if (criou) gravar();
}
/* as próximas vezes de cada série até `ate`, que ainda não existem como reunião (como a agenda da tela mostra) */
function previstasAte(de, ate, u) {
  const hoje = agoraNoFuso().data, out = [], series = ultimasDasSeries(), reais = new Set(itensVisiveis('reunioes', u).map(r => r && r.data + '|' + normNome(r.titulo)));
  for (const k in series) {
    const x = series[k].dados; if (!x.recorrencia) continue;
    const d = new Date(x.data + 'T00:00:00Z'), dd = d.getUTCDate();
    let g = 0;
    while (passoRec(d, x.recorrencia, dd) && ++g < 400) {
      const ds = d.toISOString().slice(0, 10); if (ds > ate) break;
      if (ds >= hoje && ds >= de && !reais.has(ds + '|' + normNome(x.titulo)) && !db.itens['reunioes|r' + k + '@' + ds]) out.push(Object.assign({}, x, { id: 'r' + k + '@' + ds, data: ds, feita: false }));
    }
  }
  return out;
}
jarvis.get('/reunioes', rota((req, res) => {
  const q = req.query, u = req.u, hoje = agoraNoFuso().data, cli = clientesMapa(u);
  const de = q.de ? dataOk(q.de) : hoje, ate = q.ate ? dataOk(q.ate) : null, busca = normNome(q.busca || '');
  const cliente = q.cliente ? clientesIds(q.cliente, u)[0] : null, pessoa = q.pessoa ? pessoaId(q.pessoa) : null;
  const limite = Math.max(1, Math.min(200, parseInt(q.limite, 10) || 60));
  manterSeries();
  const prev = new Set();
  let l = itensVisiveis('reunioes', u).filter(r => r && r.id && r.data && r.data >= de && (!ate || r.data <= ate));
  previstasAte(de, ate || maisDias(de, 60), u).forEach(r => { prev.add(r.id); l.push(r); });
  if (q.feitas !== '1') l = l.filter(r => !r.feita);
  if (cliente) l = l.filter(r => (r.tags || []).includes(cliente));
  if (pessoa) l = l.filter(r => (r.pessoas || []).includes(pessoa));
  if (busca) l = l.filter(r => normNome(r.titulo + ' ' + (r.descricao || '') + ' ' + (r.local || '')).includes(busca));
  l.sort((a, b) => (a.data + (a.inicio || '')) < (b.data + (b.inicio || '')) ? -1 : 1);
  res.json({ hoje, total: l.length, reunioes: l.slice(0, limite).map(r => resumoReuniao(r, cli, prev.has(r.id))) });
}));
/* a ata de uma reunião para o JARVIS (26/11): resumo, decisões, demandas e o texto da transcrição
   (o anexo que a tela guardou ao colar ou gravar). Só leitura. */
jarvis.get('/reunioes/:id/ata', rota((req, res) => {
  const r = reuniaoItem(req.params.id).dados, cli = clientesMapa(req.u), a = r.ata || {};
  let transcricao = '';
  const anexo = a.transcricao && a.transcricao.id;
  if (anexo && /^a[\w-]+$/.test(anexo) && db.anexos[anexo]) {
    try { transcricao = fs.readFileSync(path.join(ANEXOS, anexo), 'utf8').slice(0, 250000); } catch (e) { transcricao = ''; }
  }
  const hoje = agoraNoFuso().data;
  /* missões que já nasceram desta reunião (a tela guarda os ids em ata.demandas) e as sugestões que ficaram sem virar missão */
  const missoes = (a.demandas || []).slice(0, 60).map(mid => { try { return resumoMissao(missaoItem(String(mid), req.u).dados, cli, hoje, true); } catch (e) { return null; } }).filter(Boolean);
  const sugestoes = (a.sugestoes || []).slice(0, 60).filter(d => d && typeof d === 'object')
    .map(d => ({ titulo: d.titulo || '', descricao: d.descricao || '', responsavel: d.responsavel || '', data: d.data || '', cliente: d.cliente || '', trecho: d.trecho || '' }));
  res.json(Object.assign(resumoReuniao(r, cli), { descricao: r.descricao || '', pronta: !!a.pronta, resumo: a.resumo || '',
    decisoes: a.decisoes || [], missoes, sugestoes, transcricao, por: a.por ? nomePessoa(a.por) || '' : '' }));
}));
jarvis.post('/reunioes', rota((req, res) => {
  const u = req.u, b = req.body || {};
  const r = { id: 'm' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex').slice(0, 4), exemplo: false, criadaPor: u.id, feita: false,
    titulo: '', data: null, inicio: '', fim: '', pessoas: [u.id], local: '', descricao: '', tags: [], recorrencia: null };
  camposReuniao(r, Object.assign({ titulo: '', data: null, inicio: '' }, b), u);
  gravarReuniao(r, null, u);
  res.json(resumoReuniao(r, clientesMapa(u)));
}));
jarvis.patch('/reunioes/:id', rota((req, res) => {
  const u = req.u, b = req.body || {};
  manterSeries();
  if (!db.itens['reunioes|' + req.params.id]) {
    const p = previstasAte('0000-00-00', maisDias(agoraNoFuso().data, 400), u).find(x => x.id === req.params.id);
    if (p) { const base = ultimasDasSeries()[p.serie]; db.itens['reunioes|' + p.id] = { col: 'reunioes', id: p.id, dono: base ? base.dono : u.id, privado: false, apagado: false, dados: p, seq: ++db.seq }; }
  }
  const i = reuniaoItem(req.params.id), orig = i.dados, r = JSON.parse(JSON.stringify(orig));
  const campos = ['titulo', 'data', 'inicio', 'fim', 'local', 'descricao', 'pessoas', 'clientes', 'recorrencia'];
  const mudou = campos.filter(k => b[k] !== undefined);
  if (!mudou.length && b.feita === undefined) throw new Erro('Nada para mudar. Campos: ' + campos.join(', ') + ', feita, toda_serie.');
  const hoje = agoraNoFuso().data, cli = clientesMapa(u);
  camposReuniao(r, b, u);
  if (b.feita !== undefined) { r.feita = !!b.feita; r.feitaEm = r.feita ? new Date().toISOString() : null; r.feitaPor = r.feita ? u.id : null; }
  let outras = 0, avulsa = false;
  if (orig.serie && orig.recorrencia && b.toda_serie) {
    // muda a série toda: as próximas vezes que já existem recebem o mesmo (menos a data e o "feita")
    const comum = Object.assign({}, b); delete comum.data; delete comum.feita; delete comum.toda_serie;
    for (const k in db.itens) {
      const x = db.itens[k];
      if (x.col !== 'reunioes' || x.apagado || !x.dados || x.id === r.id || x.dados.serie !== orig.serie || x.dados.feita || x.dados.data < hoje) continue;
      const y = JSON.parse(JSON.stringify(x.dados)); camposReuniao(y, comum, u); gravarReuniao(y, x, u); outras++;
    }
  } else if (orig.serie && orig.recorrencia && b.data !== undefined && r.data !== orig.data) {
    // remarcar UMA vez de uma reunião que se repete: a série segue no dia de sempre e esta vira avulsa
    const ult = ultimasDasSeries()[orig.serie];
    if (ult && ult.id === orig.id) {
      let nd = proximaReuniaoData(orig.data, orig.recorrencia, maisDias(orig.data, 1)), g = 0;
      while (nd && db.itens['reunioes|r' + orig.serie + '@' + nd] && ++g < 20) nd = proximaReuniaoData(nd, orig.recorrencia, maisDias(nd, 1));
      const nid = nd && 'r' + orig.serie + '@' + nd;
      if (nid && !db.itens['reunioes|' + nid]) {
        const n = Object.assign(JSON.parse(JSON.stringify(orig)), { id: nid, data: nd, feita: false, feitaEm: null, feitaPor: null });
        db.itens['reunioes|' + nid] = { col: 'reunioes', id: nid, dono: i.dono, privado: false, apagado: false, dados: n, seq: ++db.seq };
      }
    }
    delete r.serie; r.recorrencia = null; avulsa = true;
  }
  gravarReuniao(r, i, u);   // a próxima de uma reunião que se repete a tela cria sozinha, como faz quando é marcada lá
  res.json(Object.assign(resumoReuniao(r, cli), { avulsa, outrasDaSerie: outras }));
}));

/* recorrência das missões: a mesma conta da tela (passoRec/proximaData) */
function lerRec(rec) {
  const p = String(rec || '').split(':'); if (p[0] !== 'cada') return null;
  const n = Math.max(1, Math.min(99, parseInt(p[1], 10) || 1)), un = p[2];
  if (!['dia', 'semana', 'mes', 'ano'].includes(un)) return null;
  const dias = (p[3] || '').split(',').filter(x => x !== '').map(Number).filter(x => x >= 0 && x <= 6);
  return { n, u: un, dias: un === 'semana' ? dias : [] };
}
function diasNoMes(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); }
function passoRec(d, rec, dd) {
  const mais = n => d.setUTCDate(d.getUTCDate() + n);
  if (rec === 'diaria') mais(1);
  else if (rec === 'uteis') { do { mais(1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6); }
  else if (rec === 'semanal') mais(7);
  else if (rec === 'quinzenal') mais(14);
  else if (rec === 'mensal') { d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(Math.min(dd, diasNoMes(d))); }
  else {
    const c = lerRec(rec); if (!c) return false;
    if (c.u === 'dia') mais(c.n);
    else if (c.u === 'semana' && !c.dias.length) mais(7 * c.n);
    else if (c.u === 'semana') {
      for (let k = 0; k < 8; k++) {
        mais(1);
        if (d.getUTCDay() === 1 && c.n > 1) mais(7 * (c.n - 1));
        if (c.dias.includes(d.getUTCDay())) break;
      }
    }
    else if (c.u === 'mes') { d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + c.n); d.setUTCDate(Math.min(dd, diasNoMes(d))); }
    else if (c.u === 'ano') { const mo = d.getUTCMonth(); d.setUTCDate(1); d.setUTCFullYear(d.getUTCFullYear() + c.n); d.setUTCMonth(mo); d.setUTCDate(Math.min(dd, diasNoMes(d))); }
    else return false;
  }
  return true;
}
function proximaData(base, rec, hoje) {
  if (!rec) return null;
  const b = new Date((base || hoje) + 'T00:00:00Z'), d = new Date(b), h = new Date(hoje + 'T00:00:00Z'), dd = b.getUTCDate();
  let guarda = 0;
  do { if (!passoRec(d, rec, dd)) return null; } while (d <= h && ++guarda < 3000);
  return d.toISOString().slice(0, 10);
}
function missaoNova(dados) { return Object.assign({ id: 'm' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex').slice(0, 4) }, dados); }
function precisaAprovacao(m) { return !!(m.aprovador && !m.privada && m.aprovador !== m.resp); }
jarvis.post('/missoes/:id/concluir', rota((req, res) => {
  const u = req.u, i = missaoItem(req.params.id, u), m = JSON.parse(JSON.stringify(i.dados)), b = req.body || {}, hoje = agoraNoFuso().data;
  if (m.feita) throw new Erro('Essa missão já foi cumprida.', 409);
  const links = (Array.isArray(b.links) ? b.links : b.links ? [b.links] : []).map(x => texto(x, 600)).filter(x => /^https?:\/\//i.test(x)).slice(0, 10);
  const comentario = texto(b.comentario, 3000);
  if (precisaAprovacao(m) && u.id !== m.aprovador) {
    // a tela faz o mesmo: quem precisa de aprovação envia, e a missão é cumprida quando for aprovada
    if (m.aprov && m.aprov.estado === 'aguardando') throw new Erro('Já está aguardando a aprovação de ' + nomePessoa(m.aprovador) + '.', 409);
    m.aprov = { estado: 'aguardando', em: new Date().toISOString(), por: u.id, links }; if (comentario) m.aprov.comentario = comentario;
    registrarHist(m, u, 'enviou para a aprovação de ' + nomePessoa(m.aprovador));
    gravarMissao(m, i, u);
    return res.json({ enviadaParaAprovacao: true, aprovador: nomePessoa(m.aprovador), missao: resumoMissao(m, clientesMapa(u), hoje) });
  }
  const aprovou = precisaAprovacao(m) && u.id === m.aprovador;
  (m.subs || []).forEach(s => { s.feita = true; });
  m.feita = true; m.feitaEm = new Date().toISOString();
  if (!m.privada) m.cidadeXp = 0;   // a cidade saiu do app; 0 faz o "voltar a fazer" da tela não descontar nada
  registrarHist(m, u, aprovou ? 'aprovou a entrega' : 'cumpriu a missão');
  if (aprovou) { if (m.aprov && m.aprov.links && m.aprov.links.length) m.entrega = m.aprov.links.slice(); if (m.aprov && m.aprov.comentario) m.entregaComentario = m.aprov.comentario; m.aprovadaPor = u.id; m.aprov = null; }
  else if (links.length) { m.entrega = links; if (comentario) m.entregaComentario = comentario; }
  gravarMissao(m, i, u);
  let proxima = null;
  const nd = m.recorrencia ? proximaData(m.data, m.recorrencia, hoje) : null;
  if (nd) {
    const c = missaoNova({ titulo: m.titulo, descricao: m.descricao || '', resp: m.resp, data: nd, peso: m.peso, feita: false, feitaEm: null, exemplo: !!m.exemplo, tags: (m.tags || []).slice(), anexos: [],
      subs: (m.subs || []).map(s => ({ id: 'm' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex').slice(0, 4), titulo: s.titulo, descricao: s.descricao || '', resp: s.resp, data: null, feita: false, tags: (s.tags || []).slice(), anexos: [] })),
      recorrencia: m.recorrencia, tipo: m.tipo || null, aprovador: m.aprovador || null, aprov: null, privada: !!m.privada, dono: m.dono || null, area: m.area || null,
      criadaPor: m.criadaPor || u.id, criadaEm: new Date().toISOString(), origem: m.origem || m.id });
    gravarMissao(c, i.privado ? { dono: i.dono } : null, u);
    proxima = { id: c.id, data: nd };
  }
  res.json({ cumprida: true, aprovou, proxima, missao: resumoMissao(m, clientesMapa(u), hoje) });
}));
jarvis.post('/missoes/:id/reabrir', rota((req, res) => {
  const u = req.u, i = missaoItem(req.params.id, u), m = JSON.parse(JSON.stringify(i.dados)), hoje = agoraNoFuso().data;
  if (!m.feita) throw new Erro('Essa missão não está cumprida.');
  const quando = m.feitaEm || '';
  m.feita = false; m.feitaEm = null; m.oferecida = false; delete m.cidadeXp;
  if (m.aprovadaPor) delete m.aprovadaPor;
  if (m.aprov && m.aprov.estado !== 'ajustes') m.aprov = null;
  registrarHist(m, u, 'voltou a missão para fazer');
  gravarMissao(m, i, u);
  let removida = null;
  if (m.recorrencia) {   // a repetição criada quando ela foi cumprida some, como na tela (senão a próxima fica duplicada)
    const raiz = m.origem || m.id;
    const filhas = itensVisiveis('missoes', u).filter(x => x && x.id !== m.id && !x.feita && x.origem === raiz && (!quando || (x.criadaEm || '') >= quando))
      .sort((a, b) => (a.criadaEm || '') < (b.criadaEm || '') ? 1 : -1);
    if (filhas[0]) { const k = 'missoes|' + filhas[0].id, f = db.itens[k]; db.itens[k] = { col: 'missoes', id: f.id, dono: f.dono, privado: f.privado, apagado: true, dados: null, seq: ++db.seq }; removida = filhas[0].id; gravar(); }
  }
  res.json({ reaberta: true, repeticaoRemovida: removida, missao: resumoMissao(m, clientesMapa(u), hoje) });
}));
jarvis.post('/missoes/:id/ajustes', rota((req, res) => {
  const u = req.u, i = missaoItem(req.params.id, u), m = JSON.parse(JSON.stringify(i.dados)), nota = texto((req.body || {}).nota, 3000);
  if (!nota) throw new Erro('Diga o que precisa ajustar.');
  if (!(m.aprov && m.aprov.estado === 'aguardando') || m.aprovador !== u.id) throw new Erro('Essa missão não está esperando a sua aprovação.', 409);
  m.aprov = { estado: 'ajustes', nota, em: new Date().toISOString(), por: u.id }; m.ajustes = (m.ajustes || 0) + 1;
  registrarHist(m, u, 'pediu ajustes: ' + nota);
  gravarMissao(m, i, u);
  res.json({ ok: true, missao: resumoMissao(m, clientesMapa(u), agoraNoFuso().data) });
}));
/* subtarefas: criar, editar, marcar e desmarcar (o índice é a posição na lista, começando em 1) */
jarvis.post('/missoes/:id/subtarefas', rota((req, res) => {
  const u = req.u, i = missaoItem(req.params.id, u), m = JSON.parse(JSON.stringify(i.dados)), b = req.body || {};
  if (m.feita) throw new Erro('Essa missão já foi cumprida; reabra antes de mexer nas subtarefas.');
  const titulos = (Array.isArray(b.titulos) ? b.titulos : [b.titulo]).map(t => texto(t, 200)).filter(Boolean).slice(0, 30);
  if (!titulos.length) throw new Erro('A subtarefa precisa de um título.');
  const resp = b.resp ? pessoaId(b.resp) : m.resp || u.id;
  m.subs = m.subs || [];
  titulos.forEach(t => m.subs.push({ id: 'm' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex').slice(0, 4), titulo: t, descricao: '', resp, data: null, feita: false, tags: [], anexos: [] }));
  registrarHist(m, u, titulos.length > 1 ? 'criou ' + titulos.length + ' subtarefas' : 'criou a subtarefa "' + titulos[0] + '"');
  gravarMissao(m, i, u);
  res.json(resumoMissao(m, clientesMapa(u), agoraNoFuso().data, true));
}));
jarvis.patch('/missoes/:id/subtarefas/:n', rota((req, res) => {
  const u = req.u, i = missaoItem(req.params.id, u), m = JSON.parse(JSON.stringify(i.dados)), b = req.body || {};
  const n = parseInt(req.params.n, 10), s = (m.subs || [])[n - 1];
  if (!s) throw new Erro('Subtarefa ' + req.params.n + ' não existe (a missão tem ' + (m.subs || []).length + ').', 404);
  if (m.feita) throw new Erro('Essa missão já foi cumprida; reabra antes de mexer nas subtarefas.');
  const mudou = [];
  if (b.titulo !== undefined) { s.titulo = texto(b.titulo, 200); if (!s.titulo) throw new Erro('A subtarefa precisa de um título.'); mudou.push('título'); }
  if (b.resp !== undefined) { s.resp = b.resp ? pessoaId(b.resp) : m.resp; mudou.push('responsável'); }
  if (b.feita !== undefined) { s.feita = !!b.feita; s.feitaEm = s.feita ? new Date().toISOString() : null; s.cidadeXp = 0; mudou.push(s.feita ? 'cumpriu' : 'reabriu'); }
  if (!mudou.length) throw new Erro('Nada para mudar. Campos: titulo, resp, feita.');
  registrarHist(m, u, 'subtarefa "' + s.titulo + '": ' + mudou.join(', '));
  gravarMissao(m, i, u);
  res.json(resumoMissao(m, clientesMapa(u), agoraNoFuso().data, true));
}));
/* Liturgia das Horas: as horas rezadas hoje e marcar/desmarcar uma, como o botão "Amém, rezei"
   da tela (um oferecimento privado do tipo 'hora'; vale +5 de Piedade, contado pela tela). */
const HORAS_LIT = ['laudes', 'tercia', 'sexta', 'noa', 'vesperas', 'completas'];
function horasRezadas(u, data) {
  return itensVisiveis('oferecimentos', u).filter(o => o && o.dono === u.id && o.tipo === 'hora' && o.data === data);
}
function respostaHoras(u, data) {
  const prefs = db.itens['prefs|' + u.id], feitas = horasRezadas(u, data);
  return { data, feitas: HORAS_LIT.filter(k => feitas.some(o => o.hora === k)),
    versiculos: feitas.filter(o => o.versiculo).map(o => ({ hora: o.hora, versiculo: o.versiculo })),
    lembrar: !(prefs && !prefs.apagado && prefs.dados && prefs.dados.horas === false) };
}
jarvis.get('/horas', rota((req, res) => {
  const data = req.query.data ? dataOk(String(req.query.data)) : agoraNoFuso().data;
  res.json(respostaHoras(req.u, data));
}));
jarvis.post('/horas', rota((req, res) => {
  const u = req.u, b = req.body || {}, hora = String(b.hora || ''), hoje = agoraNoFuso().data;
  if (!HORAS_LIT.includes(hora)) throw new Erro('Hora desconhecida: use ' + HORAS_LIT.join(', ') + '.');
  const feitas = horasRezadas(u, hoje).filter(o => o.hora === hora);
  if (b.feita === false) {
    feitas.forEach(o => { const k = 'oferecimentos|' + o.id, i = db.itens[k]; if (i) db.itens[k] = Object.assign({}, i, { apagado: true, dados: null, seq: ++db.seq }); });
    if (feitas.length) gravar();
  } else if (!feitas.length) {
    const oid = 'm' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex').slice(0, 4);
    const o = { id: oid, dono: u.id, tipo: 'hora', hora, data: hoje, em: new Date().toISOString(), via: 'jarvis' };
    db.itens['oferecimentos|' + oid] = { col: 'oferecimentos', id: oid, dono: u.id, privado: true, apagado: false, dados: o, seq: ++db.seq };
    gravar();
  }
  res.json(respostaHoras(u, hoje));
}));
/* Trabalho focado (o botão Foco da tela): blocos de 90 min com caminhada. O estado fica nas
   preferências da pessoa (prefs.foco), como a tela guarda, e a tela recebe pela sincronização. */
const FOCO_MIN = 90;
function prefsDe(u) { const i = db.itens['prefs|' + u.id]; return i && !i.apagado && i.dados ? JSON.parse(JSON.stringify(i.dados)) : {}; }
function gravarPrefs(u, p) { db.itens['prefs|' + u.id] = { col: 'prefs', id: u.id, dono: u.id, privado: true, apagado: false, dados: p, seq: ++db.seq }; gravar(); }
function focoMsDe(f) { if (!f) return 0; return (f.acum || 0) + (f.estado === 'foco' && f.inicio ? Date.now() - Date.parse(f.inicio) : 0); }
function focoRegistrarEm(p, ms, completo, hoje) {
  p.focoDias = p.focoDias || {}; const d = p.focoDias[hoje] || { min: 0, blocos: 0 };
  d.min += Math.round(ms / 60000); if (completo) d.blocos += 1; p.focoDias[hoje] = d;
  const ks = Object.keys(p.focoDias).sort(); while (ks.length > 120) delete p.focoDias[ks.shift()];
}
function respostaFoco(u) {
  const p = prefsDe(u), f = p.foco || null, hoje = agoraNoFuso().data;
  let missao = null;
  if (f && f.missao) { const m = itensVisiveis('missoes', u).find(x => x && x.id === f.missao); if (m) missao = { id: m.id, titulo: m.titulo }; }
  return { agora: new Date().toISOString(), alvoMin: FOCO_MIN,
    foco: f ? { estado: f.estado, inicio: f.inicio || null, acum: f.acum || 0, checks: f.checks || {},
                ms: f.estado === 'caminhada' ? Date.now() - Date.parse(f.inicio) : focoMsDe(f) } : null,
    missao, hoje: (p.focoDias || {})[hoje] || { min: 0, blocos: 0 }, ultimoWhats: p.ultimoWhats || null };
}
jarvis.get('/foco', rota((req, res) => res.json(respostaFoco(req.u))));
jarvis.post('/foco', rota((req, res) => {
  const u = req.u, b = req.body || {}, acao = String(b.acao || ''), hoje = agoraNoFuso().data;
  const p = prefsDe(u), f = p.foco || null, agora = new Date().toISOString();
  if (acao === 'iniciar') {
    let missao = b.missao ? String(b.missao) : null;
    if (missao && !itensVisiveis('missoes', u).some(x => x && x.id === missao)) throw new Erro('Missão não encontrada.', 404);
    if (f && f.estado === 'foco' && missao) f.missao = missao;
    else {
      // voltar da caminhada (ou recomeçar) mantém a missão do bloco anterior, como a tela
      if (!missao && f && f.missao) missao = f.missao;
      p.foco = { estado: 'foco', inicio: agora, acum: 0, missao, avisado: false };
    }
  } else if (acao === 'pausar') {
    if (!f || f.estado !== 'foco') throw new Erro('Não há bloco de foco rodando.', 409);
    f.acum = focoMsDe(f); f.estado = 'pausa'; f.inicio = null;
  } else if (acao === 'retomar') {
    if (!f || f.estado !== 'pausa') throw new Erro('O foco não está pausado.', 409);
    f.estado = 'foco'; f.inicio = agora;
  } else if (acao === 'caminhar') {
    if (!f) throw new Erro('Não há bloco de foco.', 409);
    if (f.estado !== 'caminhada') { const ms = focoMsDe(f); if (ms > 60000) focoRegistrarEm(p, ms, ms >= FOCO_MIN * 60000, hoje); }
    p.foco = { estado: 'caminhada', inicio: agora, acum: 0, missao: f.missao || null, checks: {} };
  } else if (acao === 'encerrar') {
    if (f && f.estado !== 'caminhada') { const ms = focoMsDe(f); if (ms > 60000) focoRegistrarEm(p, ms, ms >= FOCO_MIN * 60000, hoje); }
    p.foco = null;
  } else if (acao === 'check') {
    const k = String(b.item || ''), v = !!b.feito;
    if (k !== 'caminhar' && k !== 'whats') throw new Erro('Use item "caminhar" ou "whats".');
    if (!f || f.estado !== 'caminhada') throw new Erro('A lista é da pausa de caminhada.', 409);
    f.checks = f.checks || {}; p.focoDias = p.focoDias || {}; const d = p.focoDias[hoje] || { min: 0, blocos: 0 };
    if (v && !f.checks[k]) { if (k === 'whats') { d.whats = (d.whats || 0) + 1; p.ultimoWhats = agora; } else d.caminhadas = (d.caminhadas || 0) + 1; }
    if (!v && f.checks[k]) { if (k === 'whats') d.whats = Math.max(0, (d.whats || 0) - 1); else d.caminhadas = Math.max(0, (d.caminhadas || 0) - 1); }
    f.checks[k] = v; p.focoDias[hoje] = d;
  } else throw new Erro('Ação do foco: iniciar, pausar, retomar, caminhar, encerrar ou check.');
  gravarPrefs(u, p);
  res.json(respostaFoco(u));
}));
app.use('/api/jarvis', jarvis);

app.use((req, res) => res.status(404).type('text').send('Página não encontrada.'));
app.listen(PORTA, () => {
  backupDiario();
  if (!dadosPersistentes()) console.warn('[dados] ATENÇÃO: os dados estão em ' + DADOS + ', fora de um volume. Eles serão apagados na próxima atualização. Crie um Volume no Railway com Mount path /data.');
  console.log('Ora et Labora rodando na porta ' + PORTA + ' · dados em ' + DADOS + ' · WhatsApp: ' + (provedor() || 'não configurado') + ' · transcrição: ' + (process.env.GROQ_API_KEY ? 'Groq' : 'desligada') + ' · demandas: ' + (process.env.ANTHROPIC_API_KEY ? 'Claude' : 'desligado'));
});
