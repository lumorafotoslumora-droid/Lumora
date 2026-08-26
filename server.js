// Lumora — eigenständiger Node.js-Server (nur Node-Bordmittel, keine externen Pakete nötig)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data', 'db.json');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const PUBLIC_DIR = path.join(ROOT, 'public');

const ADMIN_NAME = 'Matic';
const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

// Verzeichnisse sicherstellen (wichtig, falls der Ordner z.B. von GitHub leer war
// und deshalb beim Hochladen des Projekts gar nicht mit übertragen wurde — Git
// kann leere Ordner nicht speichern)
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

// ---------- Persistenz (einfache JSON-Datei als Datenbank) ----------
function loadDB(){
  if(!fs.existsSync(DATA_FILE)){
    const initial = {
      users: [],
      images: [],
      purchases: [], // {userId, imageId, purchasedAt}
      promos: { firstFree:false, twoForOne:false, percent:false, percentValue:20 },
      firstFreeUsed: {} // userId -> true
    };
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function saveDB(db){
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

let db = loadDB();

// Admin-Konto beim ersten Start anlegen
function ensureAdmin(){
  if(!db.users.find(u => u.role === 'admin')){
    const { salt, hash } = hashPassword('VIP');
    db.users.push({
      id: genId(), name: ADMIN_NAME, email: null, role: 'admin',
      salt, hash, birthday: null, createdAt: new Date().toISOString()
    });
    saveDB(db);
  }
}
ensureAdmin();

// ---------- Hilfsfunktionen ----------
function genId(){ return crypto.randomBytes(9).toString('hex'); }
function genCode(){ return String(1000000 + Math.floor(Math.random() * 9000000)); }

function hashPassword(password){
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash){
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(check), Buffer.from(hash));
}

const sessions = new Map(); // token -> userId

function parseCookies(req){
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if(idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}
function getSessionUser(req){
  const cookies = parseCookies(req);
  const token = cookies['lumora_session'];
  if(!token) return null;
  const userId = sessions.get(token);
  if(!userId) return null;
  return db.users.find(u => u.id === userId) || null;
}
function setSessionCookie(res, token){
  res.setHeader('Set-Cookie', `lumora_session=${token}; HttpOnly; Path=/; Max-Age=${60*60*24*30}; SameSite=Lax`);
}
function clearSessionCookie(res){
  res.setHeader('Set-Cookie', `lumora_session=; HttpOnly; Path=/; Max-Age=0`);
}

function readJsonBody(req){
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if(size > 30 * 1024 * 1024){ reject(new Error('Payload zu groß')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if(chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch(e){ reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj){
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function purgeExpiredGrace(){
  const now = Date.now();
  let changed = false;
  db.images.forEach(img => {
    const before = img.graceCodes.length;
    img.graceCodes = img.graceCodes.filter(g => g.expires > now);
    if(img.graceCodes.length !== before) changed = true;
  });
  if(changed) saveDB(db);
}

function publicUser(u){
  return { id: u.id, name: u.name, email: u.email, role: u.role, birthday: u.birthday, createdAt: u.createdAt };
}

function publicImage(img, user){
  const purchased = user ? db.purchases.some(p => p.userId === user.id && p.imageId === img.id) : false;
  const isAdmin = user && user.role === 'admin';
  const isOwner = user && user.role === 'employee' && img.uploadedBy === user.id;
  const out = {
    id: img.id,
    url: '/uploads/' + img.filename,
    type: img.type,
    price: img.price,
    free: img.free,
    purchased,
    canDownload: img.free || purchased,
    uploadedByName: img.uploadedByName,
    createdAt: img.createdAt
  };
  if(isAdmin || isOwner){
    out.code = img.code;
    out.graceCodes = img.graceCodes;
    out.canManage = true;
    out.canSetPrice = isAdmin;
  }
  return out;
}

// ---------- Warenkorb / Rabatt-Berechnung (serverseitig, damit niemand manipulieren kann) ----------
function computeTotals(imageIds, user){
  const items = imageIds
    .map(id => db.images.find(i => i.id === id))
    .filter(img => img && !img.free && !db.purchases.some(p => p.userId === user.id && p.imageId === img.id))
    .map(img => ({ id: img.id, price: img.price }));

  const promos = db.promos;
  let remaining = [...items];
  let discount = 0;
  const usedFirstFree = !!db.firstFreeUsed[user.id];

  let freebieId = null;
  if(promos.firstFree && !usedFirstFree && remaining.length > 0){
    remaining.sort((a,b) => a.price - b.price);
    freebieId = remaining[0].id;
    discount += remaining[0].price;
    remaining = remaining.filter(it => it.id !== freebieId);
  }

  let twoForOneIds = [];
  if(promos.twoForOne){
    let sorted = [...remaining].sort((a,b) => a.price - b.price);
    for(let i=0; i+1<sorted.length; i+=2){
      discount += sorted[i].price;
      twoForOneIds.push(sorted[i].id);
    }
    remaining = remaining.filter(it => !twoForOneIds.includes(it.id));
  }

  const rawSubtotal = items.reduce((s,it) => s + it.price, 0);
  const subtotalAfterBundles = remaining.reduce((s,it) => s + it.price, 0);
  const percentOff = promos.percent ? subtotalAfterBundles * (promos.percentValue/100) : 0;
  const total = Math.max(0, subtotalAfterBundles - percentOff);

  return { itemIds: items.map(i=>i.id), rawSubtotal, discount, percentOff, total, freebieId, usesFirstFree: !!freebieId };
}

// ---------- Statisches Ausliefern ----------
const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.webp':'image/webp', '.gif':'image/gif',
  '.mp4':'video/mp4', '.webm':'video/webm', '.mov':'video/quicktime', '.json':'application/json'
};
function serveStaticFile(res, filePath){
  fs.readFile(filePath, (err, data) => {
    if(err){ res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': data.length });
    res.end(data);
  });
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(parsed.pathname);
  const method = req.method;

  try {
    // Uploads (öffentlich abrufbar, wie Bild-Hosting)
    if(pathname.startsWith('/uploads/') && method === 'GET'){
      const filePath = path.join(UPLOADS_DIR, path.basename(pathname));
      return serveStaticFile(res, filePath);
    }

    // API
    if(pathname.startsWith('/api/')){
      return await handleApi(req, res, pathname, method, parsed);
    }

    // Frontend statisch
    let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
    if(!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
    if(!fs.existsSync(filePath)) filePath = path.join(PUBLIC_DIR, 'index.html');
    return serveStaticFile(res, filePath);

  } catch(err){
    console.error(err);
    return sendJson(res, 500, { error: 'Serverfehler: ' + err.message });
  }
});

async function handleApi(req, res, pathname, method, parsed){
  const user = getSessionUser(req);

  // ---- Auth ----
  if(pathname === '/api/register' && method === 'POST'){
    const body = await readJsonBody(req);
    const name = (body.name || '').trim();
    const birthday = (body.birthday || '').trim();
    const email = (body.email || '').trim().toLowerCase();
    const password = body.password || '';
    if(!name || !birthday || !email || !password) return sendJson(res, 400, { error: 'Bitte alle Felder ausfüllen.' });
    if(!email.includes('@') || !email.includes('.')) return sendJson(res, 400, { error: 'Ungültige E-Mail-Adresse.' });
    if(!(password.length >= 8 && /[A-Z]/.test(password) && /[0-9]/.test(password)))
      return sendJson(res, 400, { error: 'Passwort erfüllt nicht alle Anforderungen.' });
    if(db.users.some(u => (u.email && u.email.toLowerCase() === email) || u.name.toLowerCase() === email))
      return sendJson(res, 400, { error: 'Für diese E-Mail existiert bereits ein Konto.' });

    const { salt, hash } = hashPassword(password);
    const newUser = { id: genId(), name, email, role: 'customer', salt, hash, birthday, createdAt: new Date().toISOString() };
    db.users.push(newUser);
    saveDB(db);

    const token = genId();
    sessions.set(token, newUser.id);
    setSessionCookie(res, token);
    return sendJson(res, 200, { user: publicUser(newUser) });
  }

  if(pathname === '/api/login' && method === 'POST'){
    const body = await readJsonBody(req);
    const id = (body.id || '').trim();
    const password = body.password || '';
    const found = db.users.find(u =>
      u.name.toLowerCase() === id.toLowerCase() ||
      (u.email && u.email.toLowerCase() === id.toLowerCase())
    );
    if(!found || !verifyPassword(password, found.salt, found.hash))
      return sendJson(res, 401, { error: 'Zugangsdaten nicht korrekt.' });

    const token = genId();
    sessions.set(token, found.id);
    setSessionCookie(res, token);
    return sendJson(res, 200, { user: publicUser(found) });
  }

  if(pathname === '/api/logout' && method === 'POST'){
    const cookies = parseCookies(req);
    if(cookies['lumora_session']) sessions.delete(cookies['lumora_session']);
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  if(pathname === '/api/me' && method === 'GET'){
    return sendJson(res, 200, { user: user ? publicUser(user) : null });
  }

  if(pathname === '/api/change-password' && method === 'POST'){
    if(!user) return sendJson(res, 401, { error: 'Nicht angemeldet.' });
    const body = await readJsonBody(req);
    if(!verifyPassword(body.oldPassword || '', user.salt, user.hash))
      return sendJson(res, 400, { error: 'Aktuelles Passwort ist falsch.' });
    const np = body.newPassword || '';
    if(!(np.length >= 8 && /[A-Z]/.test(np) && /[0-9]/.test(np)))
      return sendJson(res, 400, { error: 'Neues Passwort erfüllt nicht alle Anforderungen.' });
    const { salt, hash } = hashPassword(np);
    user.salt = salt; user.hash = hash;
    saveDB(db);
    return sendJson(res, 200, { ok: true });
  }

  // ---- Bilder / Videos ----
  if(pathname === '/api/images' && method === 'GET'){
    purgeExpiredGrace();
    return sendJson(res, 200, { images: db.images.map(img => publicImage(img, user)) });
  }

  if(pathname === '/api/images' && method === 'POST'){
    if(!user || (user.role !== 'admin' && user.role !== 'employee')) return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    const body = await readJsonBody(req);
    const dataUrl = body.dataUrl || '';
    const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
    if(!match) return sendJson(res, 400, { error: 'Ungültige Datei.' });
    const mime = match[1];
    const base64 = match[2];
    const isVideo = mime.startsWith('video/');
    const isImage = mime.startsWith('image/');
    if(!isVideo && !isImage) return sendJson(res, 400, { error: 'Nur Bild- oder Videodateien erlaubt.' });

    const ext = (mime.split('/')[1] || 'bin').replace('quicktime','mov').split('+')[0];
    const filename = genId() + '.' + ext;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), Buffer.from(base64, 'base64'));

    const img = {
      id: genId(), filename, mime, type: isVideo ? 'video' : 'image',
      price: 4.99, free: false,
      uploadedBy: user.id, uploadedByName: user.name,
      code: genCode(), graceCodes: [],
      createdAt: new Date().toISOString()
    };
    db.images.push(img);
    saveDB(db);
    return sendJson(res, 200, { image: publicImage(img, user) });
  }

  const imgMatch = pathname.match(/^\/api\/images\/([a-f0-9]+)$/);
  if(imgMatch && (method === 'DELETE' || method === 'PATCH')){
    if(!user) return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    const img = db.images.find(i => i.id === imgMatch[1]);
    if(!img) return sendJson(res, 404, { error: 'Nicht gefunden.' });
    const canManage = user.role === 'admin' || (user.role === 'employee' && img.uploadedBy === user.id);
    if(!canManage) return sendJson(res, 403, { error: 'Keine Berechtigung.' });

    if(method === 'DELETE'){
      db.images = db.images.filter(i => i.id !== img.id);
      db.purchases = db.purchases.filter(p => p.imageId !== img.id);
      try { fs.unlinkSync(path.join(UPLOADS_DIR, img.filename)); } catch(e){}
      saveDB(db);
      return sendJson(res, 200, { ok: true });
    }
    if(method === 'PATCH'){
      if(user.role !== 'admin') return sendJson(res, 403, { error: 'Nur Admin darf Preise ändern.' });
      const body = await readJsonBody(req);
      if(typeof body.free === 'boolean') img.free = body.free;
      if(typeof body.price === 'number' && body.price >= 0) img.price = body.price;
      saveDB(db);
      return sendJson(res, 200, { image: publicImage(img, user) });
    }
  }

  const sentMatch = pathname.match(/^\/api\/images\/([a-f0-9]+)\/mark-sent$/);
  if(sentMatch && method === 'POST'){
    if(!user || (user.role !== 'admin' && user.role !== 'employee')) return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    const img = db.images.find(i => i.id === sentMatch[1]);
    if(!img) return sendJson(res, 404, { error: 'Nicht gefunden.' });
    img.graceCodes.push({ code: img.code, expires: Date.now() + GRACE_PERIOD_MS });
    img.code = genCode();
    saveDB(db);
    return sendJson(res, 200, { image: publicImage(img, user) });
  }

  if(pathname === '/api/redeem' && method === 'POST'){
    purgeExpiredGrace();
    const body = await readJsonBody(req);
    const code = (body.code || '').trim();
    if(!/^\d{7}$/.test(code)) return sendJson(res, 400, { error: 'Bitte einen 7-stelligen Code eingeben.' });

    let img = db.images.find(i => i.code === code);
    if(!img){
      img = db.images.find(i => i.graceCodes.some(g => g.code === code));
      if(img) img.graceCodes = img.graceCodes.filter(g => g.code !== code);
    }
    if(!img) return sendJson(res, 404, { error: 'Dieser Code ist ungültig oder abgelaufen.' });
    saveDB(db);

    if(user && !db.purchases.some(p => p.userId === user.id && p.imageId === img.id)){
      db.purchases.push({ userId: user.id, imageId: img.id, purchasedAt: new Date().toISOString() });
      saveDB(db);
    }
    return sendJson(res, 200, { url: '/uploads/' + img.filename, image: publicImage(img, user) });
  }

  // ---- Mitarbeiter ----
  if(pathname === '/api/employees' && method === 'GET'){
    if(!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    return sendJson(res, 200, { employees: db.users.filter(u => u.role === 'employee').map(publicUser) });
  }
  if(pathname === '/api/employees' && method === 'POST'){
    if(!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    const body = await readJsonBody(req);
    const name = (body.name || '').trim();
    const password = body.password || '';
    if(!name || !password) return sendJson(res, 400, { error: 'Name und Passwort erforderlich.' });
    if(db.users.some(u => u.name.toLowerCase() === name.toLowerCase()))
      return sendJson(res, 400, { error: 'Dieser Name ist bereits vergeben.' });
    const { salt, hash } = hashPassword(password);
    const emp = { id: genId(), name, email: null, role: 'employee', salt, hash, birthday: null, createdAt: new Date().toISOString() };
    db.users.push(emp);
    saveDB(db);
    return sendJson(res, 200, { employee: publicUser(emp) });
  }
  const empMatch = pathname.match(/^\/api\/employees\/([a-f0-9]+)$/);
  if(empMatch && method === 'DELETE'){
    if(!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    db.users = db.users.filter(u => u.id !== empMatch[1]);
    saveDB(db);
    return sendJson(res, 200, { ok: true });
  }

  // ---- Aktionen ----
  if(pathname === '/api/promos' && method === 'GET'){
    return sendJson(res, 200, { promos: db.promos });
  }
  if(pathname === '/api/promos' && method === 'POST'){
    if(!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    const body = await readJsonBody(req);
    db.promos = {
      firstFree: !!body.firstFree,
      twoForOne: !!body.twoForOne,
      percent: !!body.percent,
      percentValue: Number(body.percentValue) || 0
    };
    saveDB(db);
    return sendJson(res, 200, { promos: db.promos });
  }

  // ---- Warenkorb / Kasse ----
  if(pathname === '/api/cart/preview' && method === 'POST'){
    if(!user) return sendJson(res, 401, { error: 'Bitte anmelden.' });
    const body = await readJsonBody(req);
    const totals = computeTotals(body.itemIds || [], user);
    return sendJson(res, 200, { totals });
  }
  if(pathname === '/api/checkout' && method === 'POST'){
    if(!user) return sendJson(res, 401, { error: 'Bitte anmelden.' });
    // Echte Zahlungsabwicklung ist noch nicht angebunden — Kauf bewusst gesperrt,
    // damit niemand Bilder ohne Bezahlung bekommt. Bilder werden aktuell nur
    // manuell per Code freigegeben (siehe "Verwaltung" → Code senden).
    return sendJson(res, 503, { error: 'Ein Update wird bald durchgeführt. Die Bezahlfunktion ist aktuell noch nicht verfügbar.' });
  }

  if(pathname === '/api/purchases' && method === 'GET'){
    if(!user) return sendJson(res, 401, { error: 'Bitte anmelden.' });
    const ids = db.purchases.filter(p => p.userId === user.id).map(p => p.imageId);
    const purchasedImages = db.images.filter(img => ids.includes(img.id)).map(img => publicImage(img, user));
    return sendJson(res, 200, { images: purchasedImages, count: purchasedImages.length });
  }

  return sendJson(res, 404, { error: 'Endpunkt nicht gefunden.' });
}

server.listen(PORT, () => {
  console.log(`Lumora-Server läuft auf http://localhost:${PORT}`);
});
