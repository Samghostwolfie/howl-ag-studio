let multer;
try {
  multer = require('multer');
} catch (e) {
  multer = null;
}
const path = require('path');
const fs = require('fs');
const { USE_FIREBASE_STORAGE, getBucket } = require('./firebase');

// Generous limits — modern screenshots and key art are easily 10-20 MB.
const IMAGE_LIMIT_MB = 25;
const BUILD_LIMIT_MB = 2048; // 2 GB

// ---------- local disk storage (default, same as before) ----------
function makeStorage(subdir) {
  if (!multer) return null;
  const dest = path.join(__dirname, '..', 'public', 'uploads', subdir);
  fs.mkdirSync(dest, { recursive: true });
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, dest),
    filename: (req, file, cb) => {
      const safeBase = path
        .basename(file.originalname, path.extname(file.originalname))
        .replace(/[^a-z0-9\-_]/gi, '-')
        .toLowerCase()
        .slice(0, 40);
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${safeBase || 'file'}-${unique}${path.extname(file.originalname) || '.bin'}`);
    },
  });
}

// ---------- firebase storage (memory buffer → upload to cloud) ----------
function makeFirebaseStorage() {
  if (!multer) return null;
  return multer.memoryStorage();
}

/**
 * After multer processes the file into memory, upload it to Firebase Storage.
 * This middleware runs AFTER multer and BEFORE the route handler.
 * It replaces the in-memory buffer with the cloud filename so the rest of the
 * app works identically to local disk mode.
 */
function firebaseUploadMiddleware(subdir) {
  return async (req, res, next) => {
    if (!USE_FIREBASE_STORAGE) return next();

    try {
      const bucket = getBucket();
      const filesToUpload = [];

      // Handle req.file (single upload)
      if (req.file) {
        filesToUpload.push({ fileObj: req.file, subdir });
      }

      // Handle req.files (multi-upload — can be an array or an object of arrays)
      if (req.files) {
        if (Array.isArray(req.files)) {
          req.files.forEach((f) => filesToUpload.push({ fileObj: f, subdir }));
        } else {
          // fields() mode: { cover: [file], screenshots: [file, file] }
          Object.values(req.files).forEach((arr) => {
            arr.forEach((f) => filesToUpload.push({ fileObj: f, subdir }));
          });
        }
      }

      for (const { fileObj } of filesToUpload) {
        const safeBase = path
          .basename(fileObj.originalname, path.extname(fileObj.originalname))
          .replace(/[^a-z0-9\-_]/gi, '-')
          .toLowerCase()
          .slice(0, 40);
        const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        const filename = `${safeBase || 'file'}-${unique}${path.extname(fileObj.originalname) || '.bin'}`;
        const cloudPath = `uploads/${subdir}/${filename}`;

        const file = bucket.file(cloudPath);
        await file.save(fileObj.buffer, {
          metadata: {
            contentType: fileObj.mimetype,
          },
        });

        // Make the file publicly readable
        await file.makePublic();

        // Replace the multer file object's filename so the rest of the app
        // stores the same string it would with local disk storage.
        fileObj.filename = filename;
        fileObj.firebasePath = cloudPath;
        fileObj.firebaseUrl = `https://storage.googleapis.com/${bucket.name}/${cloudPath}`;

        // Remove the buffer to free memory
        delete fileObj.buffer;
      }

      next();
    } catch (err) {
      console.error('[upload] Firebase Storage upload failed:', err.message);
      next(err);
    }
  };
}

const IMAGE_TYPES = /^image\/(png|jpe?g|webp|gif|avif|bmp|tiff?|svg\+xml)$/i;

const imageFilter = (req, file, cb) => {
  // An empty file input still arrives as a part with no filename — just ignore it.
  if (!file.originalname) return cb(null, false);
  if (IMAGE_TYPES.test(file.mimetype)) return cb(null, true);
  const err = new Error(
    `"${file.originalname}" isn't an image file. Please choose a PNG, JPG, WEBP, GIF or AVIF.`
  );
  err.code = 'NOT_AN_IMAGE';
  cb(err);
};

const imageLimits = { fileSize: IMAGE_LIMIT_MB * 1024 * 1024 };

// Choose storage engine based on whether Firebase Storage is configured.
const coverStorage = USE_FIREBASE_STORAGE ? makeFirebaseStorage() : makeStorage('covers');
const screenshotStorage = USE_FIREBASE_STORAGE ? makeFirebaseStorage() : makeStorage('screenshots');
const teamStorage = USE_FIREBASE_STORAGE ? makeFirebaseStorage() : makeStorage('team');
const buildStorage = USE_FIREBASE_STORAGE ? makeFirebaseStorage() : makeStorage('builds');

const dummyMulter = {
  single: () => (req, res, next) => next(),
  array: () => (req, res, next) => next(),
  fields: () => (req, res, next) => next(),
};

const uploadCover = multer ? multer({ storage: coverStorage, fileFilter: imageFilter, limits: imageLimits }) : dummyMulter;
const uploadScreenshots = multer ? multer({ storage: screenshotStorage, fileFilter: imageFilter, limits: imageLimits }) : dummyMulter;
const uploadTeamPhoto = multer ? multer({ storage: teamStorage, fileFilter: imageFilter, limits: imageLimits }) : dummyMulter;
const uploadBuild = multer ? multer({ storage: buildStorage, limits: { fileSize: BUILD_LIMIT_MB * 1024 * 1024 } }) : dummyMulter;

/**
 * Wraps an upload middleware so a bad file never blows up the request.
 * Instead the admin gets a readable message and lands back on the page they came from.
 *
 * When Firebase Storage is active, this also chains the cloud upload middleware.
 *
 * @param {Function} middleware  a configured multer middleware
 * @param {Function|string} backTo  where to send the user on failure
 * @param {string} [subdir]  the uploads subdirectory (covers, screenshots, team, builds)
 */
function handleUploadErrors(middleware, backTo, subdir) {
  return (req, res, next) => {
    if (!middleware) return next();
    middleware(req, res, (err) => {
      if (!err) {
        // If Firebase Storage is active, chain the cloud upload
        if (USE_FIREBASE_STORAGE && subdir) {
          return firebaseUploadMiddleware(subdir)(req, res, (uploadErr) => {
            if (!uploadErr) return next();
            console.error('[upload] Firebase error:', uploadErr.message);
            if (req.flash) req.flash('error', 'File upload to cloud storage failed. Please try again.');
            const dest = typeof backTo === 'function' ? backTo(req) : backTo;
            return res.redirect(dest);
          });
        }
        return next();
      }

      let message;
      if (err.code === 'LIMIT_FILE_SIZE') {
        message = `That file is too large. Images must be under ${IMAGE_LIMIT_MB} MB (builds under ${BUILD_LIMIT_MB / 1024} GB).`;
      } else if (err.code === 'NOT_AN_IMAGE') {
        message = err.message;
      } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        message = 'Unexpected file field — try reloading the page and saving again.';
      } else {
        message = `Upload failed: ${err.message}`;
      }

      console.error('[upload]', err.code || '', err.message);
      if (req.flash) req.flash('error', message + ' Your other changes were not saved — please try again.');

      const dest = typeof backTo === 'function' ? backTo(req) : backTo;
      return res.redirect(dest);
    });
  };
}

const { normalizeImageUrl } = require('./media');

/**
 * Resolves an uploaded file's URL, handling full URLs, local paths, and Firebase Storage paths.
 * @param {string} subdir  the uploads subdirectory (covers, screenshots, team, builds)
 * @param {string} filename  the filename or full URL
 * @returns {string}  the URL path
 */
function resolveUploadUrl(subdir, filename) {
  if (!filename) return '';
  let clean = String(filename).trim().replace(/^[`"']+|[`"']+$/g, '');
  if (!clean) return '';

  // If it's already a full URL or data URI, normalize and return it directly
  if (/^https?:\/\//i.test(clean) || /^data:/i.test(clean) || /^\/\//.test(clean)) {
    return normalizeImageUrl(clean);
  }

  // If it starts with / (like /uploads/... or /img/...), return as-is
  if (clean.startsWith('/')) {
    return clean;
  }

  if (USE_FIREBASE_STORAGE) {
    try {
      const bucket = getBucket();
      return `https://storage.googleapis.com/${bucket.name}/uploads/${subdir}/${clean}`;
    } catch (e) {
      return `/uploads/${subdir}/${clean}`;
    }
  }
  return `/uploads/${subdir}/${clean}`;
}

module.exports = {
  uploadCover,
  uploadScreenshots,
  uploadTeamPhoto,
  uploadBuild,
  handleUploadErrors,
  firebaseUploadMiddleware,
  resolveUploadUrl,
  IMAGE_LIMIT_MB,
  USE_FIREBASE_STORAGE,
};
