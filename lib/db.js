// Storage layer. Three modes, chosen automatically:
//
//   • No DATABASE_URL, no FIREBASE_PROJECT_ID  → JSON files in /data.
//     What runs on your own machine with zero setup.
//
//   • FIREBASE_PROJECT_ID set  → Firestore (Google Cloud).
//     Persistent, real-time cloud database — recommended for production.
//
//   • DATABASE_URL set (and no Firebase)  → Postgres.
//     Legacy mode for hosts like Render with Neon, still fully supported.
//
// The rest of the app never knows the difference: read()/write() stay synchronous
// in all three modes. In Firestore and Postgres modes the whole dataset is loaded
// into memory once at boot (it's a few hundred KB) and writes are flushed back a
// moment later, so no route code had to change and no call site had to become async.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// --- mode detection (Firebase takes priority over Postgres) ---
const { USE_FIREBASE } = require('./firebase');
const USE_PG = !USE_FIREBASE && !!process.env.DATABASE_URL;
const MODE = USE_FIREBASE ? 'firebase' : USE_PG ? 'postgres' : 'files';

// ---------- shared in-memory cache ----------
const cache = Object.create(null);
const dirty = new Set();
let flushTimer = null;
let flushing = false;

// ---------- file helpers ----------
function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

// ---------- init ----------
let pool = null; // Postgres only
let firestoreDb = null; // Firestore only

// The Firestore collection that stores all collections as documents.
// Each document's ID is the collection name (e.g. "games", "team") and its
// data field holds the full JSON array or object.
const FIRESTORE_COLLECTION = 'store';

async function init() {
  // ---------- files mode ----------
  if (MODE === 'files') {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    return { mode: 'files' };
  }

  // ---------- firebase mode ----------
  if (MODE === 'firebase') {
    const { getFirestore } = require('./firebase');
    firestoreDb = getFirestore();

    // Load all existing documents into the cache.
    const snapshot = await firestoreDb.collection(FIRESTORE_COLLECTION).get();
    snapshot.forEach((doc) => {
      cache[doc.id] = doc.data().data;
    });

    console.log(`[db] Firestore connected — ${snapshot.size} collection(s) loaded.`);
    return { mode: 'firebase', collections: snapshot.size };
  }

  // ---------- postgres mode ----------
  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch (err) {
    throw new Error(
      "DATABASE_URL is set but the 'pg' package isn't installed. Run: npm install pg"
    );
  }

  const url = process.env.DATABASE_URL;
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url) || /sslmode=disable/.test(url);

  pool = new Pool({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 4,
    idleTimeoutMillis: 30000,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS store (
      name       text PRIMARY KEY,
      data       jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query('SELECT name, data FROM store');
  rows.forEach((r) => { cache[r.name] = r.data; });

  console.log(`[db] Postgres connected — ${rows.length} collection(s) loaded.`);
  return { mode: 'postgres', collections: rows.length };
}

// ---------- flush (write dirty data to the remote store) ----------
function scheduleFlush(name) {
  dirty.add(name);
  if (flushTimer) return;
  // Coalesce the burst of writes a single request can make into one round trip.
  flushTimer = setTimeout(() => { flushTimer = null; flush().catch(() => {}); }, 200);
}

async function flush() {
  if (MODE === 'files' || flushing || dirty.size === 0) return;
  flushing = true;

  const names = Array.from(dirty);
  dirty.clear();

  try {
    if (MODE === 'firebase') {
      // Firestore batch write — up to 500 operations per batch, more than enough.
      const batch = firestoreDb.batch();
      for (const name of names) {
        const ref = firestoreDb.collection(FIRESTORE_COLLECTION).doc(name);
        const value = cache[name] === undefined ? null : cache[name];
        batch.set(ref, { data: value, updatedAt: new Date() });
      }
      await batch.commit();
    } else {
      // Postgres
      for (const name of names) {
        await pool.query(
          `INSERT INTO store (name, data, updated_at) VALUES ($1, $2::jsonb, now())
           ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [name, JSON.stringify(cache[name] === undefined ? null : cache[name])]
        );
      }
    }
  } catch (err) {
    // Put them back so the next flush retries rather than silently losing a write.
    names.forEach((n) => dirty.add(n));
    console.error(`[db] Could not save to ${MODE} —`, err.message);
  } finally {
    flushing = false;
    if (dirty.size) scheduleFlush(Array.from(dirty)[0]);
  }
}

/** Called on shutdown so a pending write isn't lost when the host stops the process. */
async function close() {
  if (MODE === 'files') return;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  await flush();
  if (pool) await pool.end().catch(() => {});
}

// ---------- public interface (unchanged) ----------
function read(name, fallback) {
  if (MODE !== 'files') {
    if (!(name in cache)) {
      cache[name] = fallback;
      scheduleFlush(name);
    }
    return cache[name];
  }

  const fp = filePath(name);
  if (!fs.existsSync(fp)) {
    write(name, fallback);
    return fallback;
  }
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.error(`[db] Failed to read ${name}.json, using fallback.`, err);
    return fallback;
  }
}

function write(name, data) {
  if (MODE !== 'files') {
    cache[name] = data;
    scheduleFlush(name);
    return;
  }

  const fp = filePath(name);
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    // Write to a temp file first, then swap it in — a crash mid-write can never
    // leave a half-written file that wipes your games list.
    const tmp = `${fp}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, fp);
  } catch (err) {
    console.error(`\n[db] COULD NOT SAVE ${name}.json — ${err.code || ''} ${err.message}`);
    console.error('[db] Check the folder is writable and not being synced/locked by OneDrive or antivirus.\n');
    throw err;
  }
}

/** One-time copy of every local JSON file into Postgres. Used by `npm run migrate`. */
async function importFromFiles() {
  if (MODE === 'files') throw new Error('Set DATABASE_URL or FIREBASE_PROJECT_ID first — nothing to import into.');
  if (!fs.existsSync(DATA_DIR)) return [];

  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
  const done = [];

  for (const file of files) {
    const name = file.replace(/\.json$/, '');
    const raw = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
    if (!raw.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { console.error(`[db] Skipping ${file} — not valid JSON.`); continue; }

    if (MODE === 'firebase') {
      const ref = firestoreDb.collection(FIRESTORE_COLLECTION).doc(name);
      await ref.set({ data: parsed, updatedAt: new Date() });
      cache[name] = parsed;
    } else {
      await pool.query(
        `INSERT INTO store (name, data, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [name, JSON.stringify(parsed)]
      );
      cache[name] = parsed;
    }
    done.push({ name, records: Array.isArray(parsed) ? parsed.length : 1 });
  }
  return done;
}

module.exports = { read, write, init, flush, close, importFromFiles, USE_PG, USE_FIREBASE, MODE };
