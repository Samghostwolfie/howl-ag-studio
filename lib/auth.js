const bcrypt = require('bcryptjs');
const db = require('./db');

// Make sure an admin account exists. Runs once at boot.
function ensureAdmin() {
  const admins = db.read('admin', []);
  if (admins.length > 0) return;

  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  const passwordHash = bcrypt.hashSync(password, 10);

  db.write('admin', [
    { id: 'a1', username, passwordHash, role: 'admin', createdAt: new Date().toISOString() },
  ]);

  console.log('\n[auth] Created default admin account:');
  console.log(`        username: ${username}`);
  console.log(`        password: ${password}`);
  console.log('        Change this from the admin dashboard after logging in!\n');
}

function verifyLogin(username, password) {
  const admins = db.read('admin', []);
  const account = admins.find((a) => a.username.toLowerCase() === String(username).toLowerCase());
  if (!account) return null;
  const ok = bcrypt.compareSync(password, account.passwordHash);
  return ok ? account : null;
}

function updatePassword(userId, newPassword) {
  const admins = db.read('admin', []);
  const account = admins.find((a) => a.id === userId);
  if (!account) return false;
  account.passwordHash = bcrypt.hashSync(newPassword, 10);
  db.write('admin', admins);
  return true;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  req.session.returnTo = req.originalUrl;
  const adminPath = '/' + ((process.env.ADMIN_PATH || 'admin').replace(/^\/+|\/+$/g, '') || 'admin');
  return res.redirect(`${adminPath}/login`);
}

module.exports = { ensureAdmin, verifyLogin, updatePassword, requireAuth };
