// Lumora — eigenständiger Node.js-Server (nur Node-Bordmittel, keine externen Pakete nötig)
const http = require('http');
const https = require('https');
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
      purchases: [],
      promos: { firstFree:false, twoForOne:false, percent:false, percentValue:20 },
      firstFreeUsed: {},
      raffleEntries: [],
      raffleSettings: { enabled: true },
      supportMessages: [] // {id, name, email, message, createdAt}
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
if(!Array.isArray(db.raffleEntries)) db.raffleEntries = [];
if(!db.raffleSettings) db.raffleSettings = { enabled: true };
if(!Array.isArray(db.supportMessages)) db.supportMessages = [];

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

function sendVerificationEmail(toEmail, verifyUrl){
  return new Promise((resolve) => {
    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.SENDER_EMAIL || 'lumora.fotos.lumora@gmail.com';
    if(!apiKey){
      console.warn('BREVO_API_KEY ist nicht gesetzt — Bestätigungs-E-Mail wurde NICHT verschickt. (Umgebungsvariable bei Render unter "Environment" eintragen.)');
      return resolve(false);
    }
    const payload = JSON.stringify({
      sender: { email: senderEmail, name: 'Lumora' },
      to: [{ email: toEmail }],
      subject: 'Bestätige deine E-Mail-Adresse bei Lumora',
      htmlContent: `
        <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
          <h2>Willkommen bei Lumora! 📸</h2>
          <p>Bitte bestätige deine E-Mail-Adresse, damit dein Konto vollständig aktiviert ist.</p>
          <p><a href="${verifyUrl}" style="background:#8f97ff; color:#141220; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:bold; display:inline-block;">E-Mail bestätigen</a></p>
          <p style="color:#888; font-size:13px;">Falls der Button nicht funktioniert, kopiere diesen Link in deinen Browser:<br>${verifyUrl}</p>
        </div>`
    });
    const options = {
      hostname: 'api.brevo.com',
      path: '/v3/smtp/email',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey, 'Content-Length': Buffer.byteLength(payload) }
    };
    const emailReq = https.request(options, (emailRes) => {
      let data = '';
      emailRes.on('data', c => data += c);
      emailRes.on('end', () => {
        if(emailRes.statusCode >= 200 && emailRes.statusCode < 300) resolve(true);
        else { console.error('E-Mail-Versand fehlgeschlagen:', emailRes.statusCode, data); resolve(false); }
      });
    });
    emailReq.on('error', (e) => { console.error('E-Mail-Versand-Fehler:', e.message); resolve(false); });
    emailReq.write(payload);
    emailReq.end();
  });
}

function isValidEmail(email){
  // Deutlich strengere Prüfung als nur "enthält @ und .": korrekte Struktur,
  // keine Leerzeichen, echte Domain-Endung mit mind. 2 Buchstaben.
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/.test(email);
}

function isValidBirthday(str){
  const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if(mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const date = new Date(y, mo - 1, d);
  // Prüft, ob das Datum wirklich existiert (fängt z.B. 30. Februar ab)
  if(date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return false;
  const today = new Date(); today.setHours(23,59,59,999);
  if(date > today) return false; // kein Geburtstag in der Zukunft
  if(y < 1900) return false;
  return true;
}

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
  return { id: u.id, name: u.name, email: u.email, role: u.role, birthday: u.birthday, createdAt: u.createdAt, emailVerified: !!u.emailVerified };
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

    // ---- E-Mail-Bestätigung ----
    if(pathname === '/api/verify-email' && method === 'GET'){
      const token = parsed.searchParams.get('token');
      const u = db.users.find(x => x.verifyToken && x.verifyToken === token);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if(!u){
        return res.end('<html><body style="font-family:sans-serif; background:#121119; color:#f1f0f7; padding:60px; text-align:center;"><h2>Ungültiger oder bereits verwendeter Link.</h2></body></html>');
      }
      u.emailVerified = true;
      delete u.verifyToken;
      saveDB(db);
      return res.end('<html><body style="font-family:sans-serif; background:#121119; color:#f1f0f7; padding:60px; text-align:center;"><h2>✅ E-Mail bestätigt!</h2><p>Du kannst dieses Fenster jetzt schließen und dich auf Lumora einloggen.</p></body></html>');
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
    if(!isValidEmail(email)) return sendJson(res, 400, { error: 'Diese E-Mail-Adresse sieht ungültig aus. Bitte überprüfen.' });
    if(!isValidBirthday(birthday)) return sendJson(res, 400, { error: 'Dieses Geburtsdatum ist ungültig (z.B. Datum existiert nicht oder liegt in der Zukunft).' });
    if(!(password.length >= 8 && /[A-Z]/.test(password) && /[0-9]/.test(password)))
      return sendJson(res, 400, { error: 'Passwort erfüllt nicht alle Anforderungen.' });
    if(db.users.some(u => (u.email && u.email.toLowerCase() === email) || u.name.toLowerCase() === email))
      return sendJson(res, 400, { error: 'Für diese E-Mail existiert bereits ein Konto.' });

    const { salt, hash } = hashPassword(password);
    const verifyToken = crypto.randomBytes(24).toString('hex');
    const newUser = {
      id: genId(), name, email, role: 'customer', salt, hash, birthday,
      emailVerified: false, verifyToken,
      createdAt: new Date().toISOString()
    };
    db.users.push(newUser);
    saveDB(db);

    const proto = req.headers['x-forwarded-proto'] || 'http';
    const verifyUrl = `${proto}://${req.headers.host}/api/verify-email?token=${verifyToken}`;
    sendVerificationEmail(email, verifyUrl);

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

  if(pathname === '/api/resend-verification' && method === 'POST'){
    if(!user) return sendJson(res, 401, { error: 'Bitte anmelden.' });
    if(user.role !== 'customer') return sendJson(res, 400, { error: 'Nur für Kundenkonten relevant.' });
    if(user.emailVerified) return sendJson(res, 400, { error: 'Deine E-Mail ist bereits bestätigt.' });
    const verifyToken = crypto.randomBytes(24).toString('hex');
    user.verifyToken = verifyToken;
    saveDB(db);
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const verifyUrl = `${proto}://${req.headers.host}/api/verify-email?token=${verifyToken}`;
    const sent = await sendVerificationEmail(user.email, verifyUrl);
    if(!sent) return sendJson(res, 500, { error: 'E-Mail-Versand ist aktuell nicht eingerichtet oder fehlgeschlagen.' });
    return sendJson(res, 200, { ok: true });
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

  // ---- Gewinnspiel ----
  if(pathname === '/api/raffle/settings' && method === 'GET'){
    return sendJson(res, 200, { settings: db.raffleSettings });
  }
  if(pathname === '/api/raffle/settings' && method === 'POST'){
    if(!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    const body = await readJsonBody(req);
    db.raffleSettings.enabled = !!body.enabled;
    saveDB(db);
    return sendJson(res, 200, { settings: db.raffleSettings });
  }
  if(pathname === '/api/raffle/enter' && method === 'POST'){
    if(!db.raffleSettings.enabled) return sendJson(res, 403, { error: 'Das Gewinnspiel ist aktuell nicht aktiv.' });
    const body = await readJsonBody(req);
    const email = (body.email || '').trim().toLowerCase();
    if(!isValidEmail(email)) return sendJson(res, 400, { error: 'Diese E-Mail-Adresse sieht ungültig aus. Bitte überprüfen.' });
    const already = db.raffleEntries.some(e => e.email === email);
    if(!already){
      db.raffleEntries.push({ id: genId(), email, enteredAt: new Date().toISOString() });
      saveDB(db);
    }
    return sendJson(res, 200, { ok: true, alreadyEntered: already });
  }
  if(pathname === '/api/raffle/entries' && method === 'GET'){
    if(!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    return sendJson(res, 200, { entries: db.raffleEntries });
  }
  if(pathname === '/api/raffle/draw' && method === 'POST'){
    if(!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    if(db.raffleEntries.length === 0) return sendJson(res, 400, { error: 'Es gibt noch keine Teilnehmer.' });
    const winner = db.raffleEntries[Math.floor(Math.random() * db.raffleEntries.length)];
    return sendJson(res, 200, { winner });
  }
  const raffleMatch = pathname.match(/^\/api\/raffle\/entries\/([a-f0-9]+)$/);
  if(raffleMatch && method === 'DELETE'){
    if(!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    db.raffleEntries = db.raffleEntries.filter(e => e.id !== raffleMatch[1]);
    saveDB(db);
    return sendJson(res, 200, { ok: true });
  }

  // ---- Website live aktualisieren (ohne Serverneustart, damit keine Daten verloren gehen) ----
  if(pathname === '/api/admin/update-frontend' && method === 'POST'){
    if(!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    const body = await readJsonBody(req);
    const html = body.html || '';
    if(!html.includes('<html') || !html.includes('</html>')) return sendJson(res, 400, { error: 'Das sieht nicht wie eine vollständige HTML-Datei aus. Bitte den kompletten Code einfügen.' });
    fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), html, 'utf8');
    return sendJson(res, 200, { ok: true });
  }

  // ---- Support-Nachrichten (wie ein Kontaktformular / Postfach) ----
  if(pathname === '/api/support/message' && method === 'POST'){
    const body = await readJsonBody(req);
    const name = (body.name || '').trim();
    const email = (body.email || '').trim();
    const message = (body.message || '').trim();
    if(!message) return sendJson(res, 400, { error: 'Bitte eine Nachricht eingeben.' });
    if(email && !isValidEmail(email)) return sendJson(res, 400, { error: 'Diese E-Mail-Adresse sieht ungültig aus.' });
    db.supportMessages.push({ id: genId(), name: name || (user ? user.name : 'Anonym'), email, message, createdAt: new Date().toISOString() });
    saveDB(db);
    return sendJson(res, 200, { ok: true });
  }
  if(pathname === '/api/support/messages' && method === 'GET'){
    if(!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    return sendJson(res, 200, { messages: [...db.supportMessages].reverse() });
  }
  const supportMatch = pathname.match(/^\/api\/support\/messages\/([a-f0-9]+)$/);
  if(supportMatch && method === 'DELETE'){
    if(!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    db.supportMessages = db.supportMessages.filter(m => m.id !== supportMatch[1]);
    saveDB(db);
    return sendJson(res, 200, { ok: true });
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
