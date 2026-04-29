// Einmaliger Migrations-Script: zieht alle bookings aus Supabase und schreibt sie
// entweder in eine lokale SQLite-Datei ODER per HTTP-POST an einen laufenden Server.
//
// Modus 1 (SQLite, default):  node migrate-from-supabase.js [pfad/zu/bookings.db]
// Modus 2 (HTTP):              TARGET_URL=https://app.example.com node migrate-from-supabase.js
//
// Idempotent (SQLite-Modus): legt Tabelle an falls noetig, ueberspringt Datensaetze,
// deren (date, startTime, endTime, name) bereits existieren.
// Im HTTP-Modus uebernimmt der Server die Konflikt-Erkennung (HTTP 409 wird ignoriert).

const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://sawdwcfaiffvhtvfuotz.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_nr2pQCbLb07RkrgJl1Xlag_nf-F_d_U';
const TARGET_URL = process.env.TARGET_URL;
const DB_PATH = process.argv[2] || process.env.DB_PATH || path.join(__dirname, 'data', 'bookings.db');

(async () => {
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

  console.log(`Lade Buchungen aus Supabase ...`);
  const { data, error } = await sb
    .from('bookings')
    .select('id,name,comment,date,startTime,endTime,is_permanent,pin');

  if (error) {
    console.error('Fehler beim Laden:', error.message);
    process.exit(1);
  }
  console.log(`${data.length} Datensaetze erhalten.`);

  if (TARGET_URL) {
    let inserted = 0, conflicts = 0, errs = 0;
    for (const r of data) {
      const body = {
        name: r.name,
        comment: r.comment || '',
        date: r.date,
        startTime: r.startTime,
        endTime: r.endTime,
        is_permanent: !!r.is_permanent,
        pin: r.pin || ''
      };
      const res = await fetch(`${TARGET_URL.replace(/\/$/, '')}/api/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.status === 201) inserted++;
      else if (res.status === 409) conflicts++;
      else { errs++; console.warn(`  ${res.status} fuer ${r.name} ${r.date} ${r.startTime}-${r.endTime}: ${await res.text()}`); }
    }
    console.log(`HTTP-Migration fertig: ${inserted} eingefuegt, ${conflicts} Konflikte, ${errs} Fehler.`);
    return;
  }

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const Database = require('better-sqlite3');
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

  const exists = db.prepare(`
    SELECT 1 FROM bookings WHERE date = ? AND startTime = ? AND endTime = ? AND name = ?
  `);
  const insert = db.prepare(`
    INSERT INTO bookings (name, comment, date, startTime, endTime, is_permanent, pin)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction((rows) => {
    let inserted = 0, skipped = 0;
    for (const r of rows) {
      if (exists.get(r.date, r.startTime, r.endTime, r.name)) { skipped++; continue; }
      insert.run(
        r.name,
        r.comment || null,
        r.date,
        r.startTime,
        r.endTime,
        r.is_permanent ? 1 : 0,
        r.pin || null
      );
      inserted++;
    }
    return { inserted, skipped };
  });

  const result = tx(data);
  console.log(`Fertig: ${result.inserted} neu eingefuegt, ${result.skipped} uebersprungen.`);
  console.log(`DB: ${DB_PATH}`);
  db.close();
})().catch(e => { console.error(e); process.exit(1); });
