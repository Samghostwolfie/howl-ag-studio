#!/usr/bin/env node
/**
 * One-time copy of everything in /data into your Postgres database.
 *
 *   Run once, locally, after setting DATABASE_URL. Safe to run again — it
 *   overwrites each collection with whatever is in the local file, so only run
 *   it a second time if the local files are still the version you want to keep.
 */

require('dotenv').config();
const db = require('./lib/db');

if (!process.env.DATABASE_URL) {
  console.error('\n  DATABASE_URL is not set.');
  console.error('  Put it in your .env file first, then run this again.\n');
  process.exit(1);
}

(async () => {
  try {
    console.log('\n  Connecting to the database...');
    await db.init();

    console.log('  Copying your data across...\n');
    const done = await db.importFromFiles();

    if (!done.length) {
      console.log('  Nothing found in /data to copy.\n');
    } else {
      done.forEach((d) => {
        console.log(`    ${d.name.padEnd(12)} ${d.records} record${d.records === 1 ? '' : 's'}`);
      });
      console.log('\n  Done. Your site can now run from the database.\n');
    }

    await db.close();
    process.exit(0);
  } catch (err) {
    console.error('\n  Migration failed:', err.message, '\n');
    process.exit(1);
  }
})();
