#!/usr/bin/env node
// migrate-to-firebase.js
//
// One-time migration: reads every JSON file from data/ and uploads it to
// Firebase Firestore. Optionally uploads all files from public/uploads/ to
// Firebase Storage.
//
// Usage:
//   node migrate-to-firebase.js              # data only
//   node migrate-to-firebase.js --files      # data + uploaded files
//
// Requires FIREBASE_PROJECT_ID (and credentials) in .env.

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

async function migrateData() {
  const { USE_FIREBASE, getFirestore } = require('./lib/firebase');

  if (!USE_FIREBASE) {
    console.error('\n  Set FIREBASE_PROJECT_ID (and credentials) in .env first.\n');
    process.exit(1);
  }

  const db = getFirestore();
  const COLLECTION = 'store';

  if (!fs.existsSync(DATA_DIR)) {
    console.log('  No data/ directory found — nothing to migrate.');
    return;
  }

  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
  if (!files.length) {
    console.log('  No JSON files found in data/.');
    return;
  }

  console.log(`\n  Migrating ${files.length} collection(s) to Firestore...\n`);

  for (const file of files) {
    const name = file.replace(/\.json$/, '');
    const raw = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
    if (!raw.trim()) {
      console.log(`    ⏭ ${name} — empty, skipped`);
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.log(`    ✗ ${name} — invalid JSON, skipped`);
      continue;
    }

    const count = Array.isArray(parsed) ? parsed.length : 1;
    await db.collection(COLLECTION).doc(name).set({
      data: parsed,
      updatedAt: new Date(),
    });
    console.log(`    ✓ ${name} — ${count} record(s)`);
  }

  console.log('\n  Data migration complete.\n');
}

async function migrateFiles() {
  const { USE_FIREBASE_STORAGE, getBucket } = require('./lib/firebase');

  if (!USE_FIREBASE_STORAGE) {
    console.log('  FIREBASE_STORAGE_BUCKET is not set — skipping file upload.\n');
    return;
  }

  if (!fs.existsSync(UPLOADS_DIR)) {
    console.log('  No public/uploads/ directory found — nothing to upload.');
    return;
  }

  const bucket = getBucket();
  const subdirs = ['covers', 'screenshots', 'team', 'builds'];
  let totalUploaded = 0;

  console.log('  Uploading files to Firebase Storage...\n');

  for (const subdir of subdirs) {
    const dir = path.join(UPLOADS_DIR, subdir);
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
    if (!files.length) continue;

    console.log(`    ${subdir}/`);
    for (const file of files) {
      const localPath = path.join(dir, file);
      const cloudPath = `uploads/${subdir}/${file}`;

      try {
        await bucket.upload(localPath, {
          destination: cloudPath,
          metadata: { cacheControl: 'public, max-age=31536000' },
        });
        await bucket.file(cloudPath).makePublic();
        console.log(`      ✓ ${file}`);
        totalUploaded++;
      } catch (err) {
        console.log(`      ✗ ${file} — ${err.message}`);
      }
    }
  }

  console.log(`\n  ${totalUploaded} file(s) uploaded to Firebase Storage.\n`);
}

async function main() {
  const uploadFiles = process.argv.includes('--files');

  console.log('\n  ══════════════════════════════════════════');
  console.log('  Howl A/G Studio → Firebase Migration');
  console.log('  ══════════════════════════════════════════');

  await migrateData();

  if (uploadFiles) {
    await migrateFiles();
  } else {
    console.log('  Tip: run with --files to also upload images/builds to Firebase Storage.\n');
  }

  console.log('  Done. You can now start the server with Firebase.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n  Migration failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
