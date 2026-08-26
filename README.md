# Lumora — Server-Version

Das ist die volle Version deiner Seite mit **echtem Server und Datenbank**. Anders als vorher speichert jetzt der Server alle Daten (Bilder, Konten, Käufe) — nicht mehr der Browser jedes einzelnen Besuchers. Das heißt: alle Besucher sehen dieselben Bilder, und Käufe bleiben serverseitig gespeichert.

**Keine Installation von Zusatzpaketen nötig** — der Server nutzt ausschließlich eingebaute Node.js-Funktionen.

---

## Lokal testen (auf deinem eigenen Computer)

1. [Node.js](https://nodejs.org) installieren (falls noch nicht vorhanden) — einfach die Website öffnen und die empfohlene Version herunterladen
2. Diesen Ordner entpacken
3. Terminal öffnen, in den Ordner wechseln:
   ```
   cd lumora-server
   ```
4. Server starten:
   ```
   node server.js
   ```
5. Im Browser öffnen: **http://localhost:3000**

Admin-Zugang: Name `Matic`, Passwort `VIP` (kann unter "Mein Konto" → "Passwort ändern" geändert werden).

---

## Online veröffentlichen (kostenlos)

Damit auch andere Leute über eine echte Internetadresse zugreifen können, brauchst du einen Hosting-Anbieter, der Node.js-Server laufen lässt. Empfehlung: **Render.com** (hat eine kostenlose Stufe).

### Schritt für Schritt mit Render

1. Kostenloses Konto auf [render.com](https://render.com) erstellen
2. Diesen Ordner in ein GitHub-Repository hochladen (auf [github.com](https://github.com) ein neues, leeres Repository erstellen und die Dateien hochladen — entweder per Web-Oberfläche "Upload files" oder mit `git`)
3. Bei Render: **New** → **Web Service** → dein GitHub-Repository auswählen
4. Einstellungen:
   - **Build Command:** (leer lassen, nicht nötig)
   - **Start Command:** `node server.js`
5. **Create Web Service** klicken — nach ein paar Minuten bekommst du eine echte URL wie `https://deine-seite.onrender.com`

### Wichtiger Hinweis zu kostenlosem Hosting

Bei den meisten kostenlosen Hosting-Stufen (auch bei Render) werden Dateien, die der Server zur Laufzeit erstellt — also genau die hochgeladenen Bilder/Videos und die Datenbank-Datei — **bei einem Neustart des Servers gelöscht**, weil der Speicherplatz nicht dauerhaft ist. Für ernsthaften Dauerbetrieb brauchst du entweder:
- einen **bezahlten Plan mit "Persistent Disk"** (bei Render z. B. ab wenigen Euro im Monat), oder
- eine externe Speicherlösung für Bilder (z. B. Cloudflare R2, AWS S3) statt lokaler Dateien

Für erste Tests und zum Zeigen reicht die kostenlose Stufe aber völlig aus.

---

## Was sich technisch geändert hat

- Passwörter werden jetzt **sicher verschlüsselt** gespeichert (nicht mehr im Klartext)
- Bilder/Videos liegen im Ordner `uploads/` auf dem Server
- Alle Daten (Konten, Bilder, Käufe, Aktionen) liegen in `data/db.json` — eine einfache, aber echte serverseitige Datenbank-Datei
- Der Warenkorb-Rabatt wird **auf dem Server berechnet**, nicht mehr im Browser — das verhindert, dass jemand die Preise über die Browser-Konsole manipuliert
