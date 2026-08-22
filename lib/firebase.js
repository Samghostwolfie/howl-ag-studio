// Centralized Firebase Admin SDK initialization.
//
// Shared by db.js (Firestore), upload.js (Storage), and anything else that
// needs a Firebase connection. Only initializes once — subsequent requires
// return the same instances.
//
// Configuration comes from environment variables:
//   FIREBASE_PROJECT_ID          — your Firebase project id
//   FIREBASE_CLIENT_EMAIL        — service account email
//   FIREBASE_PRIVATE_KEY         — service account private key (PEM, with \n escapes)
//   FIREBASE_STORAGE_BUCKET      — Cloud Storage bucket (e.g. your-project.appspot.com)
//
// Alternatively, set GOOGLE_APPLICATION_CREDENTIALS to point at a service
// account JSON file — the SDK picks that up automatically.

let admin;
try {
  admin = require('firebase-admin');
} catch (err) {
  // firebase-admin not installed — that's fine, Firebase features just won't be available.
  admin = null;
}

let _app = null;
let _firestore = null;
let _storage = null;
let _bucket = null;

const USE_FIREBASE = !!(
  process.env.FIREBASE_PROJECT_ID ||
  process.env.GOOGLE_APPLICATION_CREDENTIALS
);

const USE_FIREBASE_STORAGE = !!(USE_FIREBASE && process.env.FIREBASE_STORAGE_BUCKET);

function getApp() {
  if (_app) return _app;
  if (!admin) {
    throw new Error(
      "Firebase is configured but 'firebase-admin' is not installed. Run: npm install firebase-admin"
    );
  }

  const options = {};

  if (process.env.FIREBASE_STORAGE_BUCKET) {
    options.storageBucket = process.env.FIREBASE_STORAGE_BUCKET;
  }

  // Prefer explicit credentials from env vars; fall back to
  // GOOGLE_APPLICATION_CREDENTIALS (a file path the SDK reads automatically).
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
    _app = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey,
      }),
      ...options,
    });
  } else {
    // GOOGLE_APPLICATION_CREDENTIALS or default credentials (e.g. on GCP)
    _app = admin.initializeApp(options);
  }

  return _app;
}

function getFirestore() {
  if (_firestore) return _firestore;
  getApp();
  _firestore = admin.firestore();
  return _firestore;
}

function getStorage() {
  if (_storage) return _storage;
  getApp();
  _storage = admin.storage();
  return _storage;
}

function getBucket() {
  if (_bucket) return _bucket;
  _bucket = getStorage().bucket();
  return _bucket;
}

module.exports = {
  USE_FIREBASE,
  USE_FIREBASE_STORAGE,
  getApp,
  getFirestore,
  getStorage,
  getBucket,
  get admin() { return admin; },
};
