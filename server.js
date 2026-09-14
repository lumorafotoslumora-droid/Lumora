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
const SUPPORTED_LANGUAGES = ['de','en','es','fr','it','pt','nl','pl','sl','tr','ru','ar','zh','ja','ko','hi'];

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
      supportMessages: [],
      newsletterSubscribers: [],
      dailyEmail: { lastSentAt: null, pendingNote: '', intervalHours: 24 },
      raffleEmail: { lastPromoSentAt: null, intervalHours: 3 },
      pendingCheckouts: {} // sessionId -> {userId, itemIds, usesFirstFree, createdAt}
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
if(!Array.isArray(db.newsletterSubscribers)) db.newsletterSubscribers = [];
if(!db.dailyEmail) db.dailyEmail = { lastSentAt: null, pendingNote: '', intervalHours: 24 };
if(typeof db.dailyEmail.lastSentAt === 'undefined'){
  // Migration von der alten kalendertag-basierten Version
  db.dailyEmail.lastSentAt = db.dailyEmail.lastSentDate ? new Date(db.dailyEmail.lastSentDate).getTime() : null;
  delete db.dailyEmail.lastSentDate;
}
if(typeof db.dailyEmail.intervalHours !== 'number') db.dailyEmail.intervalHours = 24;
if(!db.raffleEmail) db.raffleEmail = { lastPromoSentAt: null, intervalHours: 3 };
if(typeof db.raffleEmail.intervalHours !== 'number') db.raffleEmail.intervalHours = 3;
if(!db.pendingCheckouts) db.pendingCheckouts = {};
db.users.forEach(u => { if(typeof u.banned !== 'boolean') u.banned = false; if(!u.language) u.language = 'de'; });
db.images.forEach((img, i) => { if(!img.name) img.name = 'Bild ' + (i + 1); });

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

function sendEmail(toEmail, subject, htmlContent){
  return new Promise((resolve) => {
    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.SENDER_EMAIL || 'lumora.fotos.lumora@gmail.com';
    if(!apiKey){
      console.warn('BREVO_API_KEY ist nicht gesetzt — E-Mail wurde NICHT verschickt.');
      return resolve(false);
    }
    const payload = JSON.stringify({
      sender: { email: senderEmail, name: 'Lumora' },
      to: [{ email: toEmail }],
      subject,
      htmlContent
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

// ---------- Mehrsprachige E-Mail-Texte ----------
const EMAIL_I18N = {
  de: { verify_subject:'Bestätige deine E-Mail-Adresse bei Lumora', verify_title:'Willkommen bei Lumora! 📸', verify_body:'Bitte bestätige deine E-Mail-Adresse, damit dein Konto vollständig aktiviert ist.', verify_button:'E-Mail bestätigen', verify_footer:'Falls der Button nicht funktioniert, kopiere diesen Link in deinen Browser:',
    winner_subject:'🎉 Du hast gewonnen! Dein Gratis-Bild-Code (24h gültig)', winner_title:'Herzlichen Glückwunsch!', winner_body:'Du hast bei unserem Lumora-Gewinnspiel ein Gratis-Bild gewonnen!', winner_code_label:'Dein Code:', winner_button:'Jetzt einlösen', winner_warning:'⏰ Dieser Code ist nur 24 Stunden gültig!', winner_hint:'Gib ihn einfach im Feld "Bild-Code einlösen" auf unserer Startseite ein.',
    loser_subject:'Diesmal leider nicht gewonnen — aber nächstes Mal! 🍀', loser_title:'Schade! 😔', loser_body:'Dieses Mal hast du beim Lumora-Gewinnspiel leider nicht gewonnen.', loser_body2:'Vielleicht klappt\'s beim nächsten Mal!', loser_button:'Nochmal mitmachen',
    promo_subject:'🎁 Mach mit beim Lumora-Gewinnspiel!', promo_title:'🎁 Gewinnspiel bei Lumora!', promo_body:'Trag dich jetzt ein und gewinne mit etwas Glück ein Gratis-Bild!', promo_button:'Jetzt mitmachen',
    daily_new:'🆕 Es gibt {count} neue Bilder in der Galerie!', daily_new1:'🆕 Es gibt 1 neues Bild in der Galerie!', daily_generic:'Schau doch mal wieder bei Lumora vorbei — es lohnt sich immer ein Blick in die Galerie. 📸', daily_button:'Zur Galerie',
    signoff:'LG,<br>dein Lumora-Team' },
  en: { verify_subject:'Confirm your email address at Lumora', verify_title:'Welcome to Lumora! 📸', verify_body:'Please confirm your email address to fully activate your account.', verify_button:'Confirm email', verify_footer:'If the button doesn\'t work, copy this link into your browser:',
    winner_subject:'🎉 You won! Your free image code (valid 24h)', winner_title:'Congratulations!', winner_body:'You won a free image in our Lumora giveaway!', winner_code_label:'Your code:', winner_button:'Redeem now', winner_warning:'⏰ This code is only valid for 24 hours!', winner_hint:'Just enter it in the "Redeem image code" field on our homepage.',
    loser_subject:'Not this time — but maybe next time! 🍀', loser_title:'Too bad! 😔', loser_body:'You didn\'t win this time in the Lumora giveaway.', loser_body2:'Maybe next time!', loser_button:'Join again',
    promo_subject:'🎁 Join the Lumora giveaway!', promo_title:'🎁 Lumora giveaway!', promo_body:'Sign up now for a chance to win a free image!', promo_button:'Join now',
    daily_new:'🆕 There are {count} new images in the gallery!', daily_new1:'🆕 There is 1 new image in the gallery!', daily_generic:'Come check out Lumora again — it\'s always worth a look. 📸', daily_button:'Go to gallery',
    signoff:'Best,<br>the Lumora team' },
  es: { verify_subject:'Confirma tu correo electrónico en Lumora', verify_title:'¡Bienvenido a Lumora! 📸', verify_body:'Por favor confirma tu correo electrónico para activar tu cuenta por completo.', verify_button:'Confirmar correo', verify_footer:'Si el botón no funciona, copia este enlace en tu navegador:',
    winner_subject:'🎉 ¡Has ganado! Tu código de imagen gratis (válido 24h)', winner_title:'¡Felicidades!', winner_body:'¡Has ganado una imagen gratis en nuestro sorteo de Lumora!', winner_code_label:'Tu código:', winner_button:'Canjear ahora', winner_warning:'⏰ ¡Este código solo es válido por 24 horas!', winner_hint:'Solo ingrésalo en el campo "Canjear código de imagen" en nuestra página principal.',
    loser_subject:'Esta vez no, ¡pero la próxima quizás! 🍀', loser_title:'¡Qué pena! 😔', loser_body:'Esta vez no ganaste en el sorteo de Lumora.', loser_body2:'¡Quizás la próxima vez!', loser_button:'Participar de nuevo',
    promo_subject:'🎁 ¡Participa en el sorteo de Lumora!', promo_title:'🎁 ¡Sorteo en Lumora!', promo_body:'¡Regístrate ahora y gana una imagen gratis con algo de suerte!', promo_button:'Participar ahora',
    daily_new:'🆕 ¡Hay {count} imágenes nuevas en la galería!', daily_new1:'🆕 ¡Hay 1 imagen nueva en la galería!', daily_generic:'Vuelve a visitar Lumora — siempre vale la pena echar un vistazo. 📸', daily_button:'Ir a la galería',
    signoff:'Saludos,<br>el equipo de Lumora' },
  fr: { verify_subject:'Confirmez votre adresse e-mail sur Lumora', verify_title:'Bienvenue chez Lumora ! 📸', verify_body:'Merci de confirmer ton adresse e-mail pour activer entièrement ton compte.', verify_button:'Confirmer l\'e-mail', verify_footer:'Si le bouton ne fonctionne pas, copie ce lien dans ton navigateur :',
    winner_subject:'🎉 Tu as gagné ! Ton code image gratuit (valable 24h)', winner_title:'Félicitations !', winner_body:'Tu as gagné une image gratuite lors de notre tirage Lumora !', winner_code_label:'Ton code :', winner_button:'Utiliser maintenant', winner_warning:'⏰ Ce code n\'est valable que 24 heures !', winner_hint:'Il suffit de l\'entrer dans le champ "Utiliser un code image" sur notre page d\'accueil.',
    loser_subject:'Pas cette fois — mais peut-être la prochaine ! 🍀', loser_title:'Dommage ! 😔', loser_body:'Tu n\'as pas gagné cette fois au tirage Lumora.', loser_body2:'Peut-être la prochaine fois !', loser_button:'Participer à nouveau',
    promo_subject:'🎁 Participe au tirage Lumora !', promo_title:'🎁 Tirage au sort Lumora !', promo_body:'Inscris-toi maintenant pour tenter de gagner une image gratuite !', promo_button:'Participer maintenant',
    daily_new:'🆕 Il y a {count} nouvelles images dans la galerie !', daily_new1:'🆕 Il y a 1 nouvelle image dans la galerie !', daily_generic:'Reviens faire un tour sur Lumora — ça vaut toujours le coup d\'œil. 📸', daily_button:'Voir la galerie',
    signoff:'Cordialement,<br>l\'équipe Lumora' },
  it: { verify_subject:'Conferma il tuo indirizzo email su Lumora', verify_title:'Benvenuto su Lumora! 📸', verify_body:'Conferma il tuo indirizzo email per attivare completamente il tuo account.', verify_button:'Conferma email', verify_footer:'Se il pulsante non funziona, copia questo link nel browser:',
    winner_subject:'🎉 Hai vinto! Il tuo codice immagine gratis (valido 24h)', winner_title:'Congratulazioni!', winner_body:'Hai vinto un\'immagine gratuita nella nostra estrazione Lumora!', winner_code_label:'Il tuo codice:', winner_button:'Riscatta ora', winner_warning:'⏰ Questo codice è valido solo per 24 ore!', winner_hint:'Basta inserirlo nel campo "Riscatta codice immagine" sulla nostra homepage.',
    loser_subject:'Questa volta no — ma la prossima magari! 🍀', loser_title:'Peccato! 😔', loser_body:'Questa volta non hai vinto all\'estrazione Lumora.', loser_body2:'Magari la prossima volta!', loser_button:'Partecipa di nuovo',
    promo_subject:'🎁 Partecipa all\'estrazione Lumora!', promo_title:'🎁 Estrazione Lumora!', promo_body:'Iscriviti ora e vinci un\'immagine gratuita con un po\' di fortuna!', promo_button:'Partecipa ora',
    daily_new:'🆕 Ci sono {count} nuove immagini nella galleria!', daily_new1:'🆕 C\'è 1 nuova immagine nella galleria!', daily_generic:'Torna a dare un\'occhiata a Lumora — vale sempre la pena. 📸', daily_button:'Vai alla galleria',
    signoff:'Saluti,<br>il team Lumora' },
  pt: { verify_subject:'Confirme seu e-mail na Lumora', verify_title:'Bem-vindo à Lumora! 📸', verify_body:'Confirme seu endereço de e-mail para ativar totalmente sua conta.', verify_button:'Confirmar e-mail', verify_footer:'Se o botão não funcionar, copie este link no navegador:',
    winner_subject:'🎉 Você ganhou! Seu código de imagem grátis (válido por 24h)', winner_title:'Parabéns!', winner_body:'Você ganhou uma imagem grátis no nosso sorteio Lumora!', winner_code_label:'Seu código:', winner_button:'Resgatar agora', winner_warning:'⏰ Este código é válido apenas por 24 horas!', winner_hint:'Basta inserir no campo "Resgatar código de imagem" na nossa página inicial.',
    loser_subject:'Desta vez não — mas talvez na próxima! 🍀', loser_title:'Que pena! 😔', loser_body:'Desta vez você não ganhou no sorteio Lumora.', loser_body2:'Talvez na próxima vez!', loser_button:'Participar novamente',
    promo_subject:'🎁 Participe do sorteio Lumora!', promo_title:'🎁 Sorteio Lumora!', promo_body:'Cadastre-se agora e ganhe uma imagem grátis com um pouco de sorte!', promo_button:'Participar agora',
    daily_new:'🆕 Há {count} novas imagens na galeria!', daily_new1:'🆕 Há 1 nova imagem na galeria!', daily_generic:'Volte a dar uma olhada na Lumora — sempre vale a pena. 📸', daily_button:'Ir para a galeria',
    signoff:'Abraços,<br>equipe Lumora' },
  nl: { verify_subject:'Bevestig je e-mailadres bij Lumora', verify_title:'Welkom bij Lumora! 📸', verify_body:'Bevestig je e-mailadres om je account volledig te activeren.', verify_button:'E-mail bevestigen', verify_footer:'Werkt de knop niet, kopieer dan deze link in je browser:',
    winner_subject:'🎉 Je hebt gewonnen! Je gratis afbeeldingscode (24u geldig)', winner_title:'Gefeliciteerd!', winner_body:'Je hebt een gratis afbeelding gewonnen bij onze Lumora-actie!', winner_code_label:'Je code:', winner_button:'Nu inwisselen', winner_warning:'⏰ Deze code is slechts 24 uur geldig!', winner_hint:'Vul hem in bij "Afbeeldingscode inwisselen" op onze startpagina.',
    loser_subject:'Deze keer niet — maar wie weet volgende keer! 🍀', loser_title:'Jammer! 😔', loser_body:'Deze keer heb je niet gewonnen bij de Lumora-actie.', loser_body2:'Misschien volgende keer!', loser_button:'Opnieuw meedoen',
    promo_subject:'🎁 Doe mee met de Lumora-actie!', promo_title:'🎁 Lumora-winactie!', promo_body:'Schrijf je nu in en maak kans op een gratis afbeelding!', promo_button:'Nu meedoen',
    daily_new:'🆕 Er zijn {count} nieuwe afbeeldingen in de galerij!', daily_new1:'🆕 Er is 1 nieuwe afbeelding in de galerij!', daily_generic:'Kom nog eens kijken bij Lumora — altijd de moeite waard. 📸', daily_button:'Naar de galerij',
    signoff:'Groetjes,<br>het Lumora-team' },
  pl: { verify_subject:'Potwierdź swój adres e-mail w Lumora', verify_title:'Witaj w Lumora! 📸', verify_body:'Potwierdź swój adres e-mail, aby w pełni aktywować konto.', verify_button:'Potwierdź e-mail', verify_footer:'Jeśli przycisk nie działa, skopiuj ten link do przeglądarki:',
    winner_subject:'🎉 Wygrałeś! Twój darmowy kod na zdjęcie (ważny 24h)', winner_title:'Gratulacje!', winner_body:'Wygrałeś darmowe zdjęcie w naszym losowaniu Lumora!', winner_code_label:'Twój kod:', winner_button:'Odbierz teraz', winner_warning:'⏰ Ten kod jest ważny tylko 24 godziny!', winner_hint:'Wpisz go w polu "Odbierz kod zdjęcia" na naszej stronie głównej.',
    loser_subject:'Tym razem nie — ale może następnym razem! 🍀', loser_title:'Szkoda! 😔', loser_body:'Tym razem nie wygrałeś w losowaniu Lumora.', loser_body2:'Może następnym razem!', loser_button:'Weź udział ponownie',
    promo_subject:'🎁 Weź udział w losowaniu Lumora!', promo_title:'🎁 Losowanie Lumora!', promo_body:'Zapisz się teraz i wygraj darmowe zdjęcie!', promo_button:'Dołącz teraz',
    daily_new:'🆕 W galerii jest {count} nowych zdjęć!', daily_new1:'🆕 W galerii jest 1 nowe zdjęcie!', daily_generic:'Zajrzyj ponownie do Lumora — zawsze warto. 📸', daily_button:'Przejdź do galerii',
    signoff:'Pozdrawiamy,<br>zespół Lumora' },
  sl: { verify_subject:'Potrdi svoj e-poštni naslov na Lumora', verify_title:'Dobrodošli na Lumora! 📸', verify_body:'Prosimo, potrdite svoj e-poštni naslov, da popolnoma aktivirate svoj račun.', verify_button:'Potrdi e-pošto', verify_footer:'Če gumb ne deluje, kopirajte to povezavo v brskalnik:',
    winner_subject:'🎉 Zmagali ste! Vaša koda za brezplačno sliko (velja 24h)', winner_title:'Čestitke!', winner_body:'Na našem žrebanju Lumora ste zmagali brezplačno sliko!', winner_code_label:'Vaša koda:', winner_button:'Unovči zdaj', winner_warning:'⏰ Ta koda velja samo 24 ur!', winner_hint:'Vnesite jo v polje "Unovči kodo za sliko" na naši domači strani.',
    loser_subject:'Tokrat ne — ampak morda naslednjič! 🍀', loser_title:'Škoda! 😔', loser_body:'Tokrat niste zmagali na žrebanju Lumora.', loser_body2:'Morda naslednjič!', loser_button:'Sodeluj znova',
    promo_subject:'🎁 Sodeluj v žrebanju Lumora!', promo_title:'🎁 Žrebanje Lumora!', promo_body:'Prijavite se zdaj in z malo sreče osvojite brezplačno sliko!', promo_button:'Sodeluj zdaj',
    daily_new:'🆕 V galeriji je {count} novih slik!', daily_new1:'🆕 V galeriji je 1 nova slika!', daily_generic:'Ponovno obiščite Lumora — vedno se splača pogledati. 📸', daily_button:'Na galerijo',
    signoff:'Lep pozdrav,<br>ekipa Lumora' },
  tr: { verify_subject:'Lumora\'da e-posta adresini onayla', verify_title:'Lumora\'ya hoş geldin! 📸', verify_body:'Hesabını tamamen etkinleştirmek için lütfen e-posta adresini onayla.', verify_button:'E-postayı onayla', verify_footer:'Buton çalışmazsa bu bağlantıyı tarayıcına kopyala:',
    winner_subject:'🎉 Kazandın! Ücretsiz resim kodun (24 saat geçerli)', winner_title:'Tebrikler!', winner_body:'Lumora çekilişimizde ücretsiz bir resim kazandın!', winner_code_label:'Kodun:', winner_button:'Şimdi kullan', winner_warning:'⏰ Bu kod sadece 24 saat geçerlidir!', winner_hint:'Ana sayfamızdaki "Resim kodu kullan" alanına girmen yeterli.',
    loser_subject:'Bu sefer olmadı — ama belki gelecek sefere! 🍀', loser_title:'Ne yazık ki! 😔', loser_body:'Bu sefer Lumora çekilişinde kazanamadın.', loser_body2:'Belki gelecek sefere!', loser_button:'Tekrar katıl',
    promo_subject:'🎁 Lumora çekilişine katıl!', promo_title:'🎁 Lumora çekilişi!', promo_body:'Şimdi kaydol ve şansını dene, ücretsiz resim kazan!', promo_button:'Şimdi katıl',
    daily_new:'🆕 Galeride {count} yeni resim var!', daily_new1:'🆕 Galeride 1 yeni resim var!', daily_generic:'Lumora\'ya tekrar göz at — her zaman değer. 📸', daily_button:'Galeriye git',
    signoff:'Sevgiler,<br>Lumora ekibi' },
  ru: { verify_subject:'Подтвердите свой email на Lumora', verify_title:'Добро пожаловать в Lumora! 📸', verify_body:'Пожалуйста, подтвердите свой email, чтобы полностью активировать аккаунт.', verify_button:'Подтвердить email', verify_footer:'Если кнопка не работает, скопируйте эту ссылку в браузер:',
    winner_subject:'🎉 Вы выиграли! Ваш код на бесплатное фото (действует 24ч)', winner_title:'Поздравляем!', winner_body:'Вы выиграли бесплатное фото в нашем розыгрыше Lumora!', winner_code_label:'Ваш код:', winner_button:'Использовать сейчас', winner_warning:'⏰ Этот код действителен только 24 часа!', winner_hint:'Просто введите его в поле "Использовать код фото" на нашей главной странице.',
    loser_subject:'На этот раз не повезло — может, в следующий раз! 🍀', loser_title:'Жаль! 😔', loser_body:'На этот раз вы не выиграли в розыгрыше Lumora.', loser_body2:'Может, в следующий раз!', loser_button:'Участвовать снова',
    promo_subject:'🎁 Участвуйте в розыгрыше Lumora!', promo_title:'🎁 Розыгрыш Lumora!', promo_body:'Зарегистрируйтесь сейчас и выиграйте бесплатное фото!', promo_button:'Участвовать сейчас',
    daily_new:'🆕 В галерее {count} новых фото!', daily_new1:'🆕 В галерее 1 новое фото!', daily_generic:'Загляните снова в Lumora — всегда стоит посмотреть. 📸', daily_button:'В галерею',
    signoff:'С уважением,<br>команда Lumora' },
  ar: { verify_subject:'أكّد بريدك الإلكتروني في Lumora', verify_title:'مرحبًا بك في Lumora! 📸', verify_body:'يرجى تأكيد بريدك الإلكتروني لتفعيل حسابك بالكامل.', verify_button:'تأكيد البريد الإلكتروني', verify_footer:'إذا لم يعمل الزر، انسخ هذا الرابط إلى متصفحك:',
    winner_subject:'🎉 لقد فزت! رمز صورتك المجانية (صالح 24 ساعة)', winner_title:'مبروك!', winner_body:'لقد فزت بصورة مجانية في سحب Lumora!', winner_code_label:'رمزك:', winner_button:'استبدل الآن', winner_warning:'⏰ هذا الرمز صالح لمدة 24 ساعة فقط!', winner_hint:'فقط أدخله في حقل "استبدال رمز الصورة" في صفحتنا الرئيسية.',
    loser_subject:'ليس هذه المرة — ولكن ربما في المرة القادمة! 🍀', loser_title:'للأسف! 😔', loser_body:'لم تفز هذه المرة في سحب Lumora.', loser_body2:'ربما في المرة القادمة!', loser_button:'شارك مجددًا',
    promo_subject:'🎁 شارك في سحب Lumora!', promo_title:'🎁 سحب Lumora!', promo_body:'سجّل الآن واربح صورة مجانية بقليل من الحظ!', promo_button:'شارك الآن',
    daily_new:'🆕 توجد {count} صور جديدة في المعرض!', daily_new1:'🆕 توجد صورة جديدة واحدة في المعرض!', daily_generic:'ألق نظرة على Lumora مجددًا — الأمر يستحق دائمًا. 📸', daily_button:'اذهب إلى المعرض',
    signoff:'مع تحياتنا،<br>فريق Lumora' },
  zh: { verify_subject:'请确认您在 Lumora 的邮箱地址', verify_title:'欢迎来到 Lumora！📸', verify_body:'请确认您的邮箱地址以完全激活您的账户。', verify_button:'确认邮箱', verify_footer:'如果按钮无效，请将此链接复制到浏览器中：',
    winner_subject:'🎉 恭喜中奖！您的免费图片兑换码（24小时内有效）', winner_title:'恭喜您！', winner_body:'您在我们的 Lumora 抽奖活动中赢得了一张免费图片！', winner_code_label:'您的兑换码：', winner_button:'立即兑换', winner_warning:'⏰ 此兑换码仅在24小时内有效！', winner_hint:'只需在我们主页的"兑换图片码"栏目中输入即可。',
    loser_subject:'这次没有中奖——也许下次会中！🍀', loser_title:'很遗憾！😔', loser_body:'很遗憾，您这次没有在 Lumora 抽奖中获奖。', loser_body2:'也许下次会中奖！', loser_button:'再次参加',
    promo_subject:'🎁 参加 Lumora 抽奖活动！', promo_title:'🎁 Lumora 抽奖活动！', promo_body:'立即注册，凭运气赢取免费图片！', promo_button:'立即参加',
    daily_new:'🆕 图库中有 {count} 张新图片！', daily_new1:'🆕 图库中有 1 张新图片！', daily_generic:'快来看看 Lumora 吧——总是值得一看。📸', daily_button:'前往图库',
    signoff:'此致，<br>Lumora 团队' },
  ja: { verify_subject:'Lumoraのメールアドレスを確認してください', verify_title:'Lumoraへようこそ！📸', verify_body:'アカウントを完全に有効化するために、メールアドレスを確認してください。', verify_button:'メールを確認', verify_footer:'ボタンが機能しない場合は、このリンクをブラウザにコピーしてください：',
    winner_subject:'🎉 当選しました！無料画像コード（24時間有効）', winner_title:'おめでとうございます！', winner_body:'Lumoraの抽選で無料画像に当選しました！', winner_code_label:'あなたのコード：', winner_button:'今すぐ引き換える', winner_warning:'⏰ このコードは24時間のみ有効です！', winner_hint:'トップページの「画像コードを引き換える」欄に入力するだけです。',
    loser_subject:'今回は残念でした——でも次回に期待！🍀', loser_title:'残念！😔', loser_body:'今回はLumoraの抽選に当選しませんでした。', loser_body2:'次回はきっと！', loser_button:'もう一度応募する',
    promo_subject:'🎁 Lumoraの抽選に応募しよう！', promo_title:'🎁 Lumora抽選会！', promo_body:'今すぐ登録して、運が良ければ無料画像が当たります！', promo_button:'今すぐ応募',
    daily_new:'🆕 ギャラリーに{count}枚の新しい画像があります！', daily_new1:'🆕 ギャラリーに新しい画像が1枚あります！', daily_generic:'またLumoraをチェックしてみてください——いつも見る価値があります。📸', daily_button:'ギャラリーへ',
    signoff:'よろしくお願いします、<br>Lumoraチーム' },
  ko: { verify_subject:'Lumora 이메일 주소를 확인해주세요', verify_title:'Lumora에 오신 것을 환영합니다! 📸', verify_body:'계정을 완전히 활성화하려면 이메일 주소를 확인해주세요.', verify_button:'이메일 확인', verify_footer:'버튼이 작동하지 않으면 이 링크를 브라우저에 복사하세요:',
    winner_subject:'🎉 당첨되었습니다! 무료 이미지 코드 (24시간 유효)', winner_title:'축하합니다!', winner_body:'Lumora 경품 이벤트에서 무료 이미지에 당첨되었습니다!', winner_code_label:'당신의 코드:', winner_button:'지금 사용하기', winner_warning:'⏰ 이 코드는 24시간 동안만 유효합니다!', winner_hint:'홈페이지의 "이미지 코드 사용" 칸에 입력하시면 됩니다.',
    loser_subject:'이번엔 아쉽지만 — 다음 기회에! 🍀', loser_title:'아쉽네요! 😔', loser_body:'이번 Lumora 경품 이벤트에는 당첨되지 않았습니다.', loser_body2:'다음 기회에 다시 도전하세요!', loser_button:'다시 참여하기',
    promo_subject:'🎁 Lumora 경품 이벤트에 참여하세요!', promo_title:'🎁 Lumora 경품 이벤트!', promo_body:'지금 등록하고 운이 좋으면 무료 이미지를 받아보세요!', promo_button:'지금 참여하기',
    daily_new:'🆕 갤러리에 새 이미지 {count}개가 있습니다!', daily_new1:'🆕 갤러리에 새 이미지 1개가 있습니다!', daily_generic:'Lumora를 다시 확인해보세요 — 항상 볼 가치가 있습니다. 📸', daily_button:'갤러리로 이동',
    signoff:'감사합니다,<br>Lumora 팀' },
  hi: { verify_subject:'Lumora पर अपना ईमेल पता सत्यापित करें', verify_title:'Lumora में आपका स्वागत है! 📸', verify_body:'अपने खाते को पूरी तरह सक्रिय करने के लिए कृपया अपना ईमेल पता सत्यापित करें।', verify_button:'ईमेल सत्यापित करें', verify_footer:'यदि बटन काम नहीं करता है, तो इस लिंक को अपने ब्राउज़र में कॉपी करें:',
    winner_subject:'🎉 आप जीत गए! आपका मुफ्त इमेज कोड (24 घंटे मान्य)', winner_title:'बधाई हो!', winner_body:'आपने हमारे Lumora गिवअवे में एक मुफ्त तस्वीर जीती है!', winner_code_label:'आपका कोड:', winner_button:'अभी रिडीम करें', winner_warning:'⏰ यह कोड केवल 24 घंटे के लिए मान्य है!', winner_hint:'बस इसे हमारी होमपेज पर "इमेज कोड रिडीम करें" फ़ील्ड में डालें।',
    loser_subject:'इस बार नहीं — लेकिन शायद अगली बार! 🍀', loser_title:'अफ़सोस! 😔', loser_body:'इस बार आप Lumora गिवअवे में नहीं जीते।', loser_body2:'शायद अगली बार!', loser_button:'फिर से भाग लें',
    promo_subject:'🎁 Lumora गिवअवे में भाग लें!', promo_title:'🎁 Lumora गिवअवे!', promo_body:'अभी साइन अप करें और थोड़ी किस्मत से मुफ्त तस्वीर जीतें!', promo_button:'अभी भाग लें',
    daily_new:'🆕 गैलरी में {count} नई तस्वीरें हैं!', daily_new1:'🆕 गैलरी में 1 नई तस्वीर है!', daily_generic:'फिर से Lumora देखें — हमेशा देखने लायक। 📸', daily_button:'गैलरी में जाएं',
    signoff:'सादर,<br>Lumora टीम' }
};
function et(lang, key){
  const dict = EMAIL_I18N[lang] || EMAIL_I18N.de;
  return dict[key] !== undefined ? dict[key] : (EMAIL_I18N.de[key] || key);
}

function sendVerificationEmail(toEmail, verifyUrl, lang){
  lang = lang || 'de';
  const html = `
    <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
      <h2>${et(lang,'verify_title')}</h2>
      <p>${et(lang,'verify_body')}</p>
      <p><a href="${verifyUrl}" style="background:#8f97ff; color:#141220; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:bold; display:inline-block;">${et(lang,'verify_button')}</a></p>
      <p style="color:#888; font-size:13px;">${et(lang,'verify_footer')}<br>${verifyUrl}</p>
      <p style="margin-top:24px;">${et(lang,'signoff')}</p>
    </div>`;
  return sendEmail(toEmail, et(lang,'verify_subject'), html);
}

function sendRaffleWinnerEmail(toEmail, code, siteUrl, lang){
  lang = lang || 'de';
  const html = `
    <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
      <h2>🎉 ${et(lang,'winner_title')}</h2>
      <p>${et(lang,'winner_body')}</p>
      <p>${et(lang,'winner_code_label')}</p>
      <p style="font-size:26px; font-weight:bold; letter-spacing:4px; background:#f0f0f0; padding:14px 18px; border-radius:8px; display:inline-block;">${code}</p>
      <p><a href="${siteUrl}" style="background:#8f97ff; color:#141220; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:bold; display:inline-block; margin-top:10px;">${et(lang,'winner_button')}</a></p>
      <p style="color:#d9694f; font-weight:bold; margin-top:16px;">${et(lang,'winner_warning')}</p>
      <p>${et(lang,'winner_hint')}</p>
      <p style="margin-top:24px;">${et(lang,'signoff')}</p>
    </div>`;
  return sendEmail(toEmail, et(lang,'winner_subject'), html);
}

function sendNewsletterEmail(toEmail, subject, messageText, lang){
  lang = lang || 'de';
  const htmlMessage = messageText.split('\n').filter(l => l.trim()).map(l => `<p style="margin:0 0 12px;">${l}</p>`).join('');
  const html = `
    <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
      <h2>Lumora 📸</h2>
      ${htmlMessage}
      <p style="margin-top:24px;">${et(lang,'signoff')}</p>
    </div>`;
  return sendEmail(toEmail, subject, html);
}

function buildDailyEmailHtml(newImagesCount, note, siteUrl, lang){
  lang = lang || 'de';
  const intro = newImagesCount > 0
    ? `<p>${(newImagesCount === 1 ? et(lang,'daily_new1') : et(lang,'daily_new')).replace('{count}', newImagesCount)}</p>`
    : `<p>${et(lang,'daily_generic')}</p>`;
  const noteHtml = note ? `<p style="background:#f0f0f0; padding:12px 16px; border-radius:8px;">📢 ${note}</p>` : '';
  return `
    <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
      <h2>Lumora 📸</h2>
      ${intro}
      ${noteHtml}
      <p><a href="${siteUrl}" style="background:#8f97ff; color:#141220; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:bold; display:inline-block;">${et(lang,'daily_button')}</a></p>
      <p style="margin-top:24px;">${et(lang,'signoff')}</p>
    </div>`;
}

async function runDailySend(siteUrl, force){
  const now = Date.now();
  const intervalMs = (db.dailyEmail.intervalHours || 24) * 60 * 60 * 1000;
  if(!force && db.dailyEmail.lastSentAt && (now - db.dailyEmail.lastSentAt) < intervalMs){
    return { skipped: true, reason: 'too-soon' };
  }
  if(db.newsletterSubscribers.length === 0){
    if(!force){ db.dailyEmail.lastSentAt = now; saveDB(db); }
    return { skipped: true, reason: 'no-subscribers' };
  }
  const since = now - intervalMs;
  const newImagesCount = db.images.filter(img => new Date(img.createdAt).getTime() >= since).length;
  const note = db.dailyEmail.pendingNote || '';

  let sentCount = 0;
  for(const sub of db.newsletterSubscribers){
    const lang = sub.language || 'de';
    const html = buildDailyEmailHtml(newImagesCount, note, siteUrl, lang);
    const subject = note
      ? et(lang, 'promo_subject_override') || '📢'
      : (newImagesCount > 0 ? (newImagesCount === 1 ? et(lang,'daily_new1') : et(lang,'daily_new').replace('{count}', newImagesCount)) : et(lang,'daily_generic'));
    const ok = await sendEmail(sub.email, note ? ('📢 ' + note.slice(0,60)) : subject, html);
    if(ok) sentCount++;
  }
  db.dailyEmail.lastSentAt = now;
  db.dailyEmail.pendingNote = '';
  saveDB(db);
  return { sentCount, total: db.newsletterSubscribers.length, newImagesCount };
}

function sendRaffleLoserEmail(toEmail, rejoinUrl, lang){
  lang = lang || 'de';
  const html = `
    <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
      <h2>${et(lang,'loser_title')}</h2>
      <p>${et(lang,'loser_body')}</p>
      <p>${et(lang,'loser_body2')}</p>
      <p><a href="${rejoinUrl}" style="background:#8f97ff; color:#141220; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:bold; display:inline-block;">${et(lang,'loser_button')}</a></p>
      <p style="margin-top:24px;">${et(lang,'signoff')}</p>
    </div>`;
  return sendEmail(toEmail, et(lang,'loser_subject'), html);
}

function buildRafflePromoHtml(rejoinUrl, lang){
  lang = lang || 'de';
  return `
    <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
      <h2>${et(lang,'promo_title')}</h2>
      <p>${et(lang,'promo_body')}</p>
      <p><a href="${rejoinUrl}" style="background:#8f97ff; color:#141220; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:bold; display:inline-block;">${et(lang,'promo_button')}</a></p>
      <p style="margin-top:24px;">${et(lang,'signoff')}</p>
    </div>`;
}

async function runRafflePromoSend(siteUrl, force){
  if(!db.raffleSettings.enabled) return { skipped: true, reason: 'raffle-disabled' };
  const now = Date.now();
  const intervalMs = (db.raffleEmail.intervalHours || 3) * 60 * 60 * 1000;
  if(!force && db.raffleEmail.lastPromoSentAt && (now - db.raffleEmail.lastPromoSentAt) < intervalMs){
    return { skipped: true, reason: 'too-soon' };
  }
  if(db.newsletterSubscribers.length === 0){
    if(!force){ db.raffleEmail.lastPromoSentAt = now; saveDB(db); }
    return { skipped: true, reason: 'no-subscribers' };
  }
  let sentCount = 0;
  for(const sub of db.newsletterSubscribers){
    const lang = sub.language || 'de';
    const rejoinUrl = `${siteUrl}api/raffle/rejoin?email=${encodeURIComponent(sub.email)}&lang=${lang}`;
    const ok = await sendEmail(sub.email, et(lang,'promo_subject'), buildRafflePromoHtml(rejoinUrl, lang));
    if(ok) sentCount++;
  }
  db.raffleEmail.lastPromoSentAt = now;
  saveDB(db);
  return { sentCount, total: db.newsletterSubscribers.length };
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
  const foundUser = db.users.find(u => u.id === userId) || null;
  if(foundUser && foundUser.banned){
    sessions.delete(token); // gesperrtes Konto: Sitzung sofort ungültig machen
    return null;
  }
  return foundUser;
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
  return { id: u.id, name: u.name, email: u.email, role: u.role, birthday: u.birthday, createdAt: u.createdAt, emailVerified: !!u.emailVerified, language: u.language || 'de' };
}

function publicImage(img, user){
  const purchased = user ? db.purchases.some(p => p.userId === user.id && p.imageId === img.id) : false;
  const isAdmin = user && user.role === 'admin';
  const isOwner = user && user.role === 'employee' && img.uploadedBy === user.id;
  const out = {
    id: img.id,
    name: img.name || 'Unbenanntes Bild',
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
// ---------- Stripe-Zahlungsanbindung (nur eingebaute Node-Funktionen, kein SDK nötig) ----------
function flattenStripeParams(obj, prefix, out){
  out = out || [];
  for(const key in obj){
    const val = obj[key];
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if(Array.isArray(val)){
      val.forEach((item, i) => {
        const arrKey = `${fullKey}[${i}]`;
        if(item && typeof item === 'object') flattenStripeParams(item, arrKey, out);
        else out.push(`${encodeURIComponent(arrKey)}=${encodeURIComponent(item)}`);
      });
    } else if(val && typeof val === 'object'){
      flattenStripeParams(val, fullKey, out);
    } else if(val !== undefined && val !== null){
      out.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(val)}`);
    }
  }
  return out;
}

function stripeRequest(path, params){
  return new Promise((resolve, reject) => {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if(!secretKey) return reject(new Error('Zahlungsfunktion ist noch nicht eingerichtet (STRIPE_SECRET_KEY fehlt).'));
    const body = flattenStripeParams(params).join('&');
    const options = {
      hostname: 'api.stripe.com', path, method: 'POST',
      headers: { 'Authorization': 'Bearer ' + secretKey, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    };
    const reqStripe = https.request(options, (resStripe) => {
      let data = '';
      resStripe.on('data', c => data += c);
      resStripe.on('end', () => {
        try {
          const json = JSON.parse(data);
          if(resStripe.statusCode >= 200 && resStripe.statusCode < 300) resolve(json);
          else reject(new Error((json.error && json.error.message) || 'Stripe-Fehler'));
        } catch(e){ reject(e); }
      });
    });
    reqStripe.on('error', reject);
    reqStripe.write(body);
    reqStripe.end();
  });
}

function stripeGet(path){
  return new Promise((resolve, reject) => {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if(!secretKey) return reject(new Error('Zahlungsfunktion ist noch nicht eingerichtet (STRIPE_SECRET_KEY fehlt).'));
    const options = { hostname: 'api.stripe.com', path, method: 'GET', headers: { 'Authorization': 'Bearer ' + secretKey } };
    const reqStripe = https.request(options, (resStripe) => {
      let data = '';
      resStripe.on('data', c => data += c);
      resStripe.on('end', () => {
        try {
          const json = JSON.parse(data);
          if(resStripe.statusCode >= 200 && resStripe.statusCode < 300) resolve(json);
          else reject(new Error((json.error && json.error.message) || 'Stripe-Fehler'));
        } catch(e){ reject(e); }
      });
    });
    reqStripe.on('error', reject);
    reqStripe.end();
  });
}

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

    // ---- Gewinnspiel: Wiedereinstieg per Klick-Link aus der E-Mail ----
    if(pathname === '/api/raffle/rejoin' && method === 'GET'){
      const email = (parsed.searchParams.get('email') || '').trim().toLowerCase();
      const lang = SUPPORTED_LANGUAGES.includes(parsed.searchParams.get('lang')) ? parsed.searchParams.get('lang') : 'de';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if(!isValidEmail(email)){
        return res.end('<html><body style="font-family:sans-serif; background:#121119; color:#f1f0f7; padding:60px; text-align:center;"><h2>Ungültige E-Mail-Adresse.</h2></body></html>');
      }
      if(!db.raffleSettings.enabled){
        return res.end('<html><body style="font-family:sans-serif; background:#121119; color:#f1f0f7; padding:60px; text-align:center;"><h2>Das Gewinnspiel ist aktuell nicht aktiv.</h2></body></html>');
      }
      const already = db.raffleEntries.some(e => e.email === email);
      if(!already){ db.raffleEntries.push({ id: genId(), email, enteredAt: new Date().toISOString(), language: lang }); saveDB(db); }
      const REJOIN_OK = { de:'🎉 Du bist wieder dabei!', en:'🎉 You\'re back in!', es:'🎉 ¡Ya estás de vuelta!', fr:'🎉 Tu es de nouveau inscrit !', it:'🎉 Sei di nuovo dentro!', pt:'🎉 Você está de volta!', nl:'🎉 Je doet weer mee!', pl:'🎉 Znów bierzesz udział!', tr:'🎉 Tekrar dahilsin!', ru:'🎉 Вы снова участвуете!', ar:'🎉 أنت مشارك مجددًا!', zh:'🎉 你已再次参加！', ja:'🎉 再参加しました！', ko:'🎉 다시 참여했습니다!', hi:'🎉 आप फिर से शामिल हैं!' };
      return res.end(`<html><body style="font-family:sans-serif; background:#121119; color:#f1f0f7; padding:60px; text-align:center;"><h2>${REJOIN_OK[lang] || REJOIN_OK.de}</h2></body></html>`);
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
    const language = SUPPORTED_LANGUAGES.includes(body.language) ? body.language : 'de';
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
      emailVerified: false, verifyToken, language,
      createdAt: new Date().toISOString()
    };
    db.users.push(newUser);
    saveDB(db);

    const proto = req.headers['x-forwarded-proto'] || 'http';
    const verifyUrl = `${proto}://${req.headers.host}/api/verify-email?token=${verifyToken}`;
    sendVerificationEmail(email, verifyUrl, language);

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
    if(found.banned)
      return sendJson(res, 403, { error: 'Dieses Konto wurde gesperrt.' });

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
    const sent = await sendVerificationEmail(user.email, verifyUrl, user.language);
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

    const rawName = (body.name || '').trim();
    const cleanName = rawName ? rawName.replace(/\.[^/.]+$/, '').slice(0, 80) : ('Bild ' + (db.images.length + 1));

    const img = {
      id: genId(), filename, mime, type: isVideo ? 'video' : 'image',
      name: cleanName,
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
      const body = await readJsonBody(req);
      if(typeof body.name === 'string' && body.name.trim()){
        img.name = body.name.trim().slice(0, 80); // Name darf Admin ODER der besitzende Mitarbeiter ändern
      }
      if(typeof body.free === 'boolean' || typeof body.price === 'number'){
        if(user.role !== 'admin') return sendJson(res, 403, { error: 'Nur Admin darf Preise ändern.' });
        if(typeof body.free === 'boolean') img.free = body.free;
        if(typeof body.price === 'number' && body.price >= 0) img.price = body.price;
      }
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
      db.purchases.push({ userId: user.id, imageId: img.id, purchasedAt: new Date().toISOString(), pricePaid: 0, source: 'code' });
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
    const language = SUPPORTED_LANGUAGES.includes(body.language) ? body.language : 'de';
    if(!isValidEmail(email)) return sendJson(res, 400, { error: 'Diese E-Mail-Adresse sieht ungültig aus. Bitte überprüfen.' });
    const already = db.raffleEntries.some(e => e.email === email);
    if(!already){
      db.raffleEntries.push({ id: genId(), email, enteredAt: new Date().toISOString(), language });
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
    const body = await readJsonBody(req);
    const img = db.images.find(i => i.id === body.imageId);
    if(!img) return sendJson(res, 400, { error: 'Bitte zuerst ein Bild für den Gewinn auswählen.' });
    if(db.raffleEntries.length === 0) return sendJson(res, 400, { error: 'Es gibt noch keine Teilnehmer.' });

    const winnerIdx = Math.floor(Math.random() * db.raffleEntries.length);
    const winner = db.raffleEntries[winnerIdx];
    const losers = db.raffleEntries.filter((_, i) => i !== winnerIdx);

    // Automatisch wie "Gesendet" klicken: aktueller Code bleibt 24h gültig, neuer Code wird erzeugt
    const wonCode = img.code;
    img.graceCodes.push({ code: wonCode, expires: Date.now() + GRACE_PERIOD_MS });
    img.code = genCode();
    db.raffleEntries = []; // Lostopf für die nächste Runde zurücksetzen
    saveDB(db);

    const proto = req.headers['x-forwarded-proto'] || 'http';
    const siteUrl = `${proto}://${req.headers.host}/`;
    const emailSent = await sendRaffleWinnerEmail(winner.email, wonCode, siteUrl, winner.language);

    let loserEmailsSent = 0;
    for(const loser of losers){
      const rejoinUrl = `${siteUrl}api/raffle/rejoin?email=${encodeURIComponent(loser.email)}&lang=${loser.language || 'de'}`;
      const ok = await sendRaffleLoserEmail(loser.email, rejoinUrl, loser.language);
      if(ok) loserEmailsSent++;
    }

    return sendJson(res, 200, { winner: winner.email, code: wonCode, emailSent, loserCount: losers.length, loserEmailsSent });
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

  // ---- Newsletter ----
  if(pathname === '/api/newsletter/subscribe' && method === 'POST'){
    const body = await readJsonBody(req);
    const email = (body.email || '').trim().toLowerCase();
    const language = SUPPORTED_LANGUAGES.includes(body.language) ? body.language : 'de';
    if(!isValidEmail(email)) return sendJson(res, 400, { error: 'Diese E-Mail-Adresse sieht ungültig aus.' });
    const already = db.newsletterSubscribers.some(s => s.email === email);
    if(!already){
      db.newsletterSubscribers.push({ id: genId(), email, subscribedAt: new Date().toISOString(), language });
      saveDB(db);
    }
    return sendJson(res, 200, { ok: true, alreadySubscribed: already });
  }
  if(pathname === '/api/newsletter/subscribers' && method === 'GET'){
    if(!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    return sendJson(res, 200, { subscribers: db.newsletterSubscribers });
  }
  const nlMatch = pathname.match(/^\/api\/newsletter\/subscribers\/([a-f0-9]+)$/);
  if(nlMatch && method === 'DELETE'){
    if(!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    db.newsletterSubscribers = db.newsletterSubscribers.filter(s => s.id !== nlMatch[1]);
    saveDB(db);
    return sendJson(res, 200, { ok: true });
  }
  if(pathname === '/api/newsletter/send' && method === 'POST'){
    if(!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    const body = await readJsonBody(req);
    const subject = (body.subject || '').trim();
    const message = (body.message || '').trim();
    if(!subject || !message) return sendJson(res, 400, { error: 'Bitte Betreff und Nachricht ausfüllen.' });
    if(db.newsletterSubscribers.length === 0) return sendJson(res, 400, { error: 'Es gibt noch keine Abonnenten.' });
    let sentCount = 0;
    for(const sub of db.newsletterSubscribers){
      const ok = await sendNewsletterEmail(sub.email, subject, message, sub.language);
      if(ok) sentCount++;
    }
    return sendJson(res, 200, { ok: true, sentCount, total: db.newsletterSubscribers.length });
  }

  if(pathname === '/api/newsletter/daily-status' && method === 'GET'){
    if(!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    return sendJson(res, 200, { lastSentAt: db.dailyEmail.lastSentAt, pendingNote: db.dailyEmail.pendingNote, intervalHours: db.dailyEmail.intervalHours });
  }
  if(pathname === '/api/newsletter/daily-interval' && method === 'POST'){
    if(!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    const body = await readJsonBody(req);
    const hours = Number(body.hours);
    if(!hours || hours <= 0) return sendJson(res, 400, { error: 'Ungültiger Zeitabstand.' });
    db.dailyEmail.intervalHours = hours;
    saveDB(db);
    return sendJson(res, 200, { ok: true, intervalHours: hours });
  }
  if(pathname === '/api/newsletter/daily-note' && method === 'POST'){
    if(!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    const body = await readJsonBody(req);
    db.dailyEmail.pendingNote = (body.note || '').trim();
    saveDB(db);
    return sendJson(res, 200, { ok: true });
  }
  if(pathname === '/api/newsletter/send-daily-now' && method === 'POST'){
    if(!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const siteUrl = process.env.SITE_URL || `${proto}://${req.headers.host}/`;
    const result = await runDailySend(siteUrl, true);
    return sendJson(res, 200, result);
  }

  if(pathname === '/api/raffle/promo-status' && method === 'GET'){
    if(!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    return sendJson(res, 200, { lastPromoSentAt: db.raffleEmail.lastPromoSentAt, intervalHours: db.raffleEmail.intervalHours });
  }
  if(pathname === '/api/raffle/promo-interval' && method === 'POST'){
    if(!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    const body = await readJsonBody(req);
    const hours = Number(body.hours);
    if(!hours || hours <= 0) return sendJson(res, 400, { error: 'Ungültiger Zeitabstand.' });
    db.raffleEmail.intervalHours = hours;
    saveDB(db);
    return sendJson(res, 200, { ok: true, intervalHours: hours });
  }
  if(pathname === '/api/raffle/send-promo-now' && method === 'POST'){
    if(!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const siteUrl = process.env.SITE_URL || `${proto}://${req.headers.host}/`;
    const result = await runRafflePromoSend(siteUrl, true);
    return sendJson(res, 200, result);
  }

  // ---- Konten sperren/entsperren ----
  if(pathname === '/api/admin/ban-user' && method === 'POST'){
    if(!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    const body = await readJsonBody(req);
    const identifier = (body.identifier || '').trim().toLowerCase();
    if(!identifier) return sendJson(res, 400, { error: 'Bitte Name oder E-Mail eingeben.' });
    const target = db.users.find(u => u.name.toLowerCase() === identifier || (u.email && u.email.toLowerCase() === identifier));
    if(!target) return sendJson(res, 404, { error: 'Kein Konto mit diesem Namen oder dieser E-Mail gefunden.' });
    if(target.role === 'admin') return sendJson(res, 400, { error: 'Der Admin-Account kann nicht gesperrt werden.' });
    target.banned = true;
    saveDB(db);
    for(const [token, uid] of sessions){ if(uid === target.id) sessions.delete(token); } // sofort abmelden
    return sendJson(res, 200, { ok: true, user: publicUser(target) });
  }
  if(pathname === '/api/admin/unban-user' && method === 'POST'){
    if(!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    const body = await readJsonBody(req);
    const identifier = (body.identifier || '').trim().toLowerCase();
    const target = db.users.find(u => u.name.toLowerCase() === identifier || (u.email && u.email.toLowerCase() === identifier));
    if(!target) return sendJson(res, 404, { error: 'Kein Konto mit diesem Namen oder dieser E-Mail gefunden.' });
    target.banned = false;
    saveDB(db);
    return sendJson(res, 200, { ok: true, user: publicUser(target) });
  }
  if(pathname === '/api/admin/banned-users' && method === 'GET'){
    if(!user || user.role !== 'admin') return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    return sendJson(res, 200, { users: db.users.filter(u => u.banned).map(publicUser) });
  }

  // ---- Verkaufsstatistik (Admin: alles, Mitarbeiter: nur eigene hochgeladene Bilder) ----
  if(pathname === '/api/sales' && method === 'GET'){
    if(!user || (user.role !== 'admin' && user.role !== 'employee')) return sendJson(res, 403, { error: 'Keine Berechtigung.' });
    let relevant = db.purchases.filter(p => (p.pricePaid || 0) > 0);
    if(user.role === 'employee'){
      const myImageIds = db.images.filter(img => img.uploadedBy === user.id).map(img => img.id);
      relevant = relevant.filter(p => myImageIds.includes(p.imageId));
    }
    const rows = relevant.map(p => {
      const img = db.images.find(i => i.id === p.imageId);
      const buyer = db.users.find(u => u.id === p.userId);
      return {
        buyerName: buyer ? buyer.name : 'Unbekannt',
        buyerEmail: buyer ? buyer.email : '',
        imageName: img ? img.name : 'Gelöschtes Bild',
        imageId: p.imageId,
        uploadedByName: img ? img.uploadedByName : '',
        pricePaid: p.pricePaid || 0,
        purchasedAt: p.purchasedAt
      };
    }).sort((a, b) => new Date(b.purchasedAt) - new Date(a.purchasedAt));
    const totalRevenue = Math.round(rows.reduce((s, r) => s + r.pricePaid, 0) * 100) / 100;
    return sendJson(res, 200, { rows, totalRevenue, count: rows.length });
  }

  // ---- Sprache ändern ----
  if(pathname === '/api/change-language' && method === 'POST'){
    if(!user) return sendJson(res, 401, { error: 'Bitte anmelden.' });
    const body = await readJsonBody(req);
    const lang = (body.language || '').trim();
    if(!SUPPORTED_LANGUAGES.includes(lang)) return sendJson(res, 400, { error: 'Sprache nicht unterstützt.' });
    user.language = lang;
    saveDB(db);
    return sendJson(res, 200, { ok: true, language: lang });
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
  if(pathname === '/api/checkout/create-session' && method === 'POST'){
    if(!user) return sendJson(res, 401, { error: 'Bitte anmelden.' });
    const body = await readJsonBody(req);
    const totals = computeTotals(body.itemIds || [], user);
    if(totals.itemIds.length === 0) return sendJson(res, 400, { error: 'Warenkorb ist leer oder alle Bilder sind bereits gekauft.' });
    if(totals.total <= 0){
      // Gesamtbetrag ist 0 (z.B. komplett durch Aktionen abgedeckt) — direkt ohne Stripe abschließen
      if(!db.purchases) db.purchases = [];
      totals.itemIds.forEach(id => {
        if(!db.purchases.some(p => p.userId === user.id && p.imageId === id)) db.purchases.push({ userId: user.id, imageId: id, purchasedAt: new Date().toISOString(), pricePaid: 0, source: 'checkout-free' });
      });
      if(totals.usesFirstFree) db.firstFreeUsed[user.id] = true;
      saveDB(db);
      return sendJson(res, 200, { freeCheckout: true });
    }
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const siteUrl = process.env.SITE_URL || `${proto}://${req.headers.host}`;
    try {
      const session = await stripeRequest('/v1/checkout/sessions', {
        mode: 'payment',
        success_url: `${siteUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${siteUrl}/?checkout=cancel`,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: 'eur',
            unit_amount: Math.round(totals.total * 100),
            product_data: { name: `Lumora — ${totals.itemIds.length} Bild${totals.itemIds.length === 1 ? '' : 'er'}` }
          }
        }]
      });
      db.pendingCheckouts[session.id] = {
        userId: user.id, itemIds: totals.itemIds, usesFirstFree: totals.usesFirstFree,
        itemPrices: totals.itemIds.map(id => { const im = db.images.find(x => x.id === id); return { id, price: im ? im.price : 0 }; }),
        rawSubtotal: totals.rawSubtotal, actualTotal: totals.total,
        createdAt: new Date().toISOString()
      };
      saveDB(db);
      return sendJson(res, 200, { url: session.url });
    } catch(e){
      return sendJson(res, 500, { error: e.message });
    }
  }

  if(pathname === '/api/checkout/confirm' && method === 'POST'){
    if(!user) return sendJson(res, 401, { error: 'Bitte anmelden.' });
    const body = await readJsonBody(req);
    const sessionId = body.sessionId;
    const pending = db.pendingCheckouts[sessionId];
    if(!pending || pending.userId !== user.id) return sendJson(res, 400, { error: 'Unbekannte oder bereits verarbeitete Bestellung.' });
    try {
      const session = await stripeGet(`/v1/checkout/sessions/${sessionId}`);
      if(session.payment_status !== 'paid') return sendJson(res, 400, { error: 'Die Zahlung ist noch nicht abgeschlossen.' });
      if(!db.purchases) db.purchases = [];
      const ratio = (pending.rawSubtotal && pending.rawSubtotal > 0) ? (pending.actualTotal / pending.rawSubtotal) : 1;
      pending.itemIds.forEach(id => {
        if(!db.purchases.some(p => p.userId === user.id && p.imageId === id)){
          const entry = pending.itemPrices && pending.itemPrices.find(x => x.id === id);
          const pricePaid = entry ? Math.round(entry.price * ratio * 100) / 100 : 0;
          db.purchases.push({ userId: user.id, imageId: id, purchasedAt: new Date().toISOString(), pricePaid, source: 'stripe' });
        }
      });
      if(pending.usesFirstFree) db.firstFreeUsed[user.id] = true;
      delete db.pendingCheckouts[sessionId];
      saveDB(db);
      return sendJson(res, 200, { ok: true, itemCount: pending.itemIds.length });
    } catch(e){
      return sendJson(res, 500, { error: e.message });
    }
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

// ---------- Tägliche automatische E-Mail ----------
// Prüft stündlich, ob heute schon eine automatische Mail verschickt wurde.
// Funktioniert nur zuverlässig, solange der Server durchgehend läuft
// (z.B. dank eines Wach-halte-Dienstes wie UptimeRobot).
function scheduledDailyCheck(){
  const siteUrl = process.env.SITE_URL || 'https://lumora-ddo1.onrender.com';
  runDailySend(siteUrl, false).catch(e => console.error('Fehler bei automatischer Tages-Mail:', e.message));
}
setTimeout(scheduledDailyCheck, 60 * 1000); // kurz nach dem Start einmal prüfen
setInterval(scheduledDailyCheck, 60 * 60 * 1000); // danach stündlich prüfen

function scheduledRafflePromoCheck(){
  const siteUrl = process.env.SITE_URL || 'https://lumora-ddo1.onrender.com';
  runRafflePromoSend(siteUrl, false).catch(e => console.error('Fehler bei Gewinnspiel-Werbung:', e.message));
}
setTimeout(scheduledRafflePromoCheck, 90 * 1000); // kurz nach dem Start einmal prüfen
setInterval(scheduledRafflePromoCheck, 60 * 60 * 1000); // stündlich prüfen, sendet aber wirklich nur alle 3h
