// Einmaliger Migrations-Script: zieht alle bookings aus Supabase nach SQLite.
// Nutzung:  node migrate-from-supabase.js [pfad/zu/bookings.db]
// Default-Pfad: ./data/bookings.db (gleicher wie server.js).
//
// Idempotent: legt Tabelle an falls noetig, ueberspringt Datensaetze, deren
// (date, startTime, endTime, name) bereits existieren.

const { createClient } = require('@supabase/supabase-js');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://sawdwcfaiffvhtvfuotz.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_nr2pQCbLb07RkrgJl1Xlag_nf-F_d_U';
const DB_PATH = process.argv[2] || process.env.DB_PATH || path.join(__dirname, 'data', 'bookings.db');

(async () => {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
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
