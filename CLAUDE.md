# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Projekt

Webbasierter Terminplaner / Buchungskalender für die Pickleball-Plätze des **TSV Stöckelsberg**. UI-Sprache ist Deutsch.

## Architektur

**Self-hosted Single-Service-App.** Ein Express-Server liefert das statische Frontend (`index.html` + `TSV.png`) aus und stellt eine REST-API für Buchungen bereit. Persistenz: lokale SQLite-Datei via `better-sqlite3`. Kein Build-Schritt fürs Frontend (Tailwind/Phosphor kommen per CDN).

```
┌─────────────────────────────┐
│  Browser ─ index.html       │
│   fetch('/api/bookings')    │
└──────────┬──────────────────┘
           │
┌──────────▼──────────────────┐
│  server.js (Express)        │
│  /api/bookings  CRUD        │
│  /api/bookings/:id/move     │
│  static index.html, TSV.png │
└──────────┬──────────────────┘
           │ better-sqlite3
┌──────────▼──────────────────┐
│  $DB_PATH (Default /data)   │
│  bookings.db (WAL)          │
└─────────────────────────────┘
```

### Dateien

- `server.js` — Express-Server. Liest `PORT` (Default `3000`) und `DB_PATH` (Default `./data/bookings.db`) aus ENV. Erstellt Tabelle/Index falls nötig.
- `index.html` — Frontend. Vanilla JS, alle DB-Calls über `fetch()` gegen `/api/*`. Helper `api(method, url, body)` zentralisiert Error-Handling.
- `migrate-from-supabase.js` — Einmaliger Node-Script, zieht Bestandsdaten aus dem alten Supabase-Projekt nach SQLite. Idempotent (Skip via `(date, startTime, endTime, name)`-Match). Nutzung: `node migrate-from-supabase.js [pfad/zu/bookings.db]`.
- `Dockerfile` — Node-20-Alpine; baut `better-sqlite3` aus Source (Build-Tools werden im selben Layer wieder entfernt). Volume: `/data`.
- `package.json` — `npm start` startet den Server, `npm run migrate` startet die Supabase-Migration.

### Datenmodell

Eine Tabelle `bookings`:

| Spalte         | Typ      | Hinweis                                              |
|----------------|----------|------------------------------------------------------|
| `id`           | INTEGER  | PRIMARY KEY AUTOINCREMENT                            |
| `name`         | TEXT     | Spielername                                          |
| `comment`      | TEXT     | optional                                             |
| `date`         | TEXT     | `YYYY-MM-DD`                                         |
| `startTime`    | TEXT     | `HH:MM`                                              |
| `endTime`      | TEXT     | `HH:MM`                                              |
| `is_permanent` | INTEGER  | 0/1 — wöchentliche Wiederholung                      |
| `pin`          | TEXT     | optional, nur server-seitig validiert, NIE an Client |

Index auf `date`. WAL-Modus aktiv.

### REST-API

- `GET /api/bookings` — Liste aller Buchungen (ohne `pin`-Feld; statt dessen `has_pin: bool`).
- `POST /api/bookings` — Neue Buchung. Body: `{name, comment?, date, startTime, endTime, is_permanent, pin?}`. 409 bei Konflikt.
- `PUT /api/bookings/:id` — Volle Aktualisierung. PIN-geschützte Buchungen brauchen `verify_pin` im Body. Leeres `pin`-Feld lässt vorhandenen PIN unverändert (zum Ändern: neuen Wert schicken).
- `PATCH /api/bookings/:id/move` — Nur `date`/`startTime`/`endTime` aktualisieren. Body: `{date, startTime, endTime, verify_pin?}`.
- `DELETE /api/bookings/:id` — Body `{verify_pin?}`. PIN-Check serverseitig.
- `GET /healthz` — Liveness-Check.

**Sicherheitsmodell.** PIN ist ein einfacher per-Buchung-Schutz, kein Auth-System. Der PIN wird ausschließlich serverseitig validiert und niemals an den Client gesendet (das war bei Supabase eine Schwachstelle). Es gibt keinen globalen Auth-Layer — jede:r kann Buchungen lesen und neue anlegen.

### Frontend-Konventionen

- Raster: `START_HOUR=8` bis `END_HOUR=22`, **30-Minuten-Slots** (`SLOT_H=45px`, `HOUR_H=90px`). Slot-Index `s` ↔ Zeit über `idxToTime(s)` / `timeToPos(t)`.
- Wochenansicht startet bei Montag (`getDay() || 7` — Sonntag wird zu 7).
- Datums-Strings via `getLocalDateStr()` mit `toLocaleDateString('sv-SE')` (lokales `YYYY-MM-DD`, kein UTC-Off-by-One). **Nicht** `toISOString().slice(0,10)` verwenden.
- `is_permanent`-Buchungen werden auf jedem passenden Wochentag gerendert. Bei jeder Filter-/Konflikt-Logik diesen Fall mitdenken.
- Konflikt-Erkennung verwendet String-Vergleich der Zeiten (`s < b.endTime && en > b.startTime`) — funktioniert nur, weil `HH:MM` mit führenden Nullen garantiert ist. Server hat dieselbe Logik in `hasConflict()`.
- XSS: Userstrings (`name`, `comment`) in `renderBookings` via `esc()` escapen. Bei jeder neuen `innerHTML`-Stelle dasselbe.

### Maus- & Touch-Interaktion

Drei Modi mit nicht-trivialer State-Maschine:

1. **Slot-Auswahl** (Drag über leere Slots → Buchungs-Modal). Maus: sofort. Touch: Long-Press 300ms. Während Auswahl bekommt `<body>` die Klasse `is-selecting`, was via CSS (`.booking-card { pointer-events: none !important }`) verhindert, dass Buchungskarten Mouse-Events schlucken. Nicht entfernen.
2. **Smart-Trim** (`trimSelectionToFree`): Auswahl wird auf den längsten freien zusammenhängenden Slot-Bereich getrimmt; bei voller Belegung wird die Auswahl rot („conflict") angezeigt und beim Loslassen verworfen.
3. **Drag & Drop** von Buchungen. Maus: Drag aktiviert sich erst nach `DRAG_THRESHOLD=8px` Bewegung — darunter zählt es als Klick und öffnet die Detailansicht. Touch: Long-Press 300ms aktiviert Drag, sonst Tap = Detail. Das `justDragged`-Flag verhindert, dass `mouseup` nach Drop direkt das Detail-Modal öffnet.

Globale Listener (`mouseup`, `mousemove`, `touchend`, `touchmove`) werden in `DOMContentLoaded` registriert. `touchmove` ist `passive: false`, weil während aktiver Auswahl `preventDefault()` nötig ist.

### PIN-Flow im Frontend

- Hat eine Buchung `has_pin: true`, blendet `openDetails` die PIN-Eingabe ein.
- Beim Klick auf Bearbeiten/Löschen wird der eingegebene PIN als `verify_pin` an den Server geschickt; bei `403` zeigt das Modal die Fehlermeldung. Der PIN wird in `editVerifyPin` (Edit-Flow) bzw. lokalen Variablen gehalten.
- Beim Drag einer PIN-geschützten Buchung kommt ein `prompt()` für den PIN — wie zuvor.
- Im Edit-Modal ist das `pin`-Feld leer mit Placeholder „leer = unverändert". Server lässt vorhandenen PIN stehen, wenn das Feld leer bleibt.

## Entwicklung

- **Voraussetzung**: Node ≥ 20 (lokale Builds von `better-sqlite3` brauchen Prebuilds für die jeweilige Node-Version).
- **Install**: `npm install`. Auf Windows ohne Visual Studio Build Tools nur möglich, wenn Prebuilds verfügbar sind (aktuelle better-sqlite3 v12+ haben sie für Node 20–24).
- **Run lokal**: `npm start` — startet auf Port 3000 mit DB unter `./data/bookings.db`.
- **API smoke-test**: `curl http://localhost:3000/healthz`.
- **Migration aus Supabase**: `npm run migrate` (URL/Key sind als Defaults im Script; per ENV überschreibbar).
- **Tests/Linter**: keine.

## Deployment (Coolify)

- Coolify-App-Typ: **Dockerfile**. Repo: `profex1337/TSV`, Branch `main`. Buildpath: `./Dockerfile`.
- **Persistent Storage**: Volume auf `/data` mounten. Hier liegt `bookings.db` (+ `-shm`/`-wal`).
- ENV optional: `PORT` (Default 3000, Coolify mapped üblicherweise selbst), `DB_PATH` (Default `/data/bookings.db`, im Dockerfile gesetzt).
- **Migration in Production**: einmalig auf Host oder im Container `node migrate-from-supabase.js /data/bookings.db` laufen lassen, BEVOR Traffic auf die neue Instanz geht.
- Healthcheck-URL: `/healthz`.

## Globale Konvention

Wenn neue Features, Dateien oder Architekturänderungen hinzukommen, **diese CLAUDE.md aktualisieren**.
