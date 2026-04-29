const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'bookings.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.prepare(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    comment TEXT,
    date TEXT NOT NULL,
    startTime TEXT NOT NULL,
    endTime TEXT NOT NULL,
    is_permanent INTEGER NOT NULL DEFAULT 0,
    pin TEXT
  )
`).run();
db.prepare('CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date)').run();

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(__dirname, { index: 'index.html' }));

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateBookingInput(b) {
  if (!b || typeof b !== 'object') return 'Ungültige Daten';
  if (typeof b.name !== 'string' || b.name.trim().length === 0 || b.name.length > 80) return 'Name fehlt oder zu lang';
  if (b.comment != null && (typeof b.comment !== 'string' || b.comment.length > 200)) return 'Kommentar zu lang';
  if (b.pin != null && b.pin !== '' && !/^\d{1,8}$/.test(String(b.pin))) return 'PIN muss numerisch sein';
  if (!DATE_RE.test(b.date)) return 'Datum ungültig';
  if (!TIME_RE.test(b.startTime) || !TIME_RE.test(b.endTime)) return 'Zeit ungültig';
  if (b.startTime >= b.endTime) return 'Endzeit muss nach Startzeit liegen';
  return null;
}

function dayOfWeek(dateStr) {
  return new Date(dateStr + 'T00:00:00').getDay();
}

function publicFields(row) {
  return {
    id: row.id,
    name: row.name,
    comment: row.comment,
    date: row.date,
    startTime: row.startTime,
    endTime: row.endTime,
    is_permanent: !!row.is_permanent,
    has_pin: !!row.pin
  };
}

function hasConflict(date, startTime, endTime, excludeId) {
  const dow = dayOfWeek(date);
  const rows = db.prepare(`
    SELECT id, date, startTime, endTime, is_permanent FROM bookings
    WHERE id IS NOT ?
  `).all(excludeId ?? -1);
  return rows.some(r => {
    const sameSlot = r.date === date || (r.is_permanent && dayOfWeek(r.date) === dow);
    return sameSlot && startTime < r.endTime && endTime > r.startTime;
  });
}

app.get('/api/bookings', (_req, res) => {
  const rows = db.prepare('SELECT * FROM bookings').all();
  res.json(rows.map(publicFields));
});

app.post('/api/bookings', (req, res) => {
  const err = validateBookingInput(req.body);
  if (err) return res.status(400).json({ error: err });
  const { name, comment, date, startTime, endTime, is_permanent, pin } = req.body;
  if (hasConflict(date, startTime, endTime, null)) {
    return res.status(409).json({ error: 'Belegt' });
  }
  const info = db.prepare(`
    INSERT INTO bookings (name, comment, date, startTime, endTime, is_permanent, pin)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    name.trim(),
    comment || null,
    date,
    startTime,
    endTime,
    is_permanent ? 1 : 0,
    pin ? String(pin) : null
  );
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(publicFields(row));
});

function checkPinOrFail(row, providedPin, res) {
  if (!row.pin) return true;
  if (providedPin && String(providedPin) === row.pin) return true;
  res.status(403).json({ error: 'PIN falsch' });
  return false;
}

app.put('/api/bookings/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Nicht gefunden' });

  const providedPin = req.body && req.body.verify_pin;
  if (!checkPinOrFail(row, providedPin, res)) return;

  const err = validateBookingInput(req.body);
  if (err) return res.status(400).json({ error: err });
  const { name, comment, date, startTime, endTime, is_permanent, pin } = req.body;
  if (hasConflict(date, startTime, endTime, id)) {
    return res.status(409).json({ error: 'Belegt' });
  }
  // Leeres pin-Feld bei Edit = unveraendert lassen (UX: PIN-Eingabe nicht erzwingen).
  // Neuer Wert ueberschreibt; explizites Entfernen wird nicht angeboten.
  const newPin = (pin == null || pin === '') ? row.pin : String(pin);
  db.prepare(`
    UPDATE bookings
    SET name = ?, comment = ?, date = ?, startTime = ?, endTime = ?, is_permanent = ?, pin = ?
    WHERE id = ?
  `).run(
    name.trim(),
    comment || null,
    date,
    startTime,
    endTime,
    is_permanent ? 1 : 0,
    newPin,
    id
  );
  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  res.json(publicFields(updated));
});

app.patch('/api/bookings/:id/move', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Nicht gefunden' });

  const providedPin = req.body && req.body.verify_pin;
  if (!checkPinOrFail(row, providedPin, res)) return;

  const { date, startTime, endTime } = req.body || {};
  if (!DATE_RE.test(date) || !TIME_RE.test(startTime) || !TIME_RE.test(endTime) || startTime >= endTime) {
    return res.status(400).json({ error: 'Ungültige Zielzeit' });
  }
  if (hasConflict(date, startTime, endTime, id)) {
    return res.status(409).json({ error: 'Belegt' });
  }
  db.prepare('UPDATE bookings SET date = ?, startTime = ?, endTime = ? WHERE id = ?')
    .run(date, startTime, endTime, id);
  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  res.json(publicFields(updated));
});

app.delete('/api/bookings/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Nicht gefunden' });

  const providedPin = req.body && req.body.verify_pin;
  if (!checkPinOrFail(row, providedPin, res)) return;

  db.prepare('DELETE FROM bookings WHERE id = ?').run(id);
  res.status(204).end();
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Terminplaner laeuft auf Port ${PORT} (DB: ${DB_PATH})`);
});
