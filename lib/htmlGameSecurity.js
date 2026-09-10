const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let AdmZip = null;
try {
  AdmZip = require('adm-zip');
} catch (e) {
  // Optional fallback
}

const VAULT_DIR = path.join(__dirname, '..', 'data', 'vault', 'html-games');
const KEY_FILE = path.join(__dirname, '..', 'data', 'vault', '.vault_key');

// Ensure vault directory exists
if (!fs.existsSync(VAULT_DIR)) {
  try { fs.mkdirSync(VAULT_DIR, { recursive: true }); } catch (e) {}
}

// Master encryption key for data at rest
function getMasterKey() {
  if (process.env.HTML_GAME_VAULT_KEY && process.env.HTML_GAME_VAULT_KEY.length >= 32) {
    return Buffer.from(process.env.HTML_GAME_VAULT_KEY.slice(0, 32), 'utf8');
  }
  if (fs.existsSync(KEY_FILE)) {
    return fs.readFileSync(KEY_FILE);
  }
  const newKey = crypto.randomBytes(32);
  try { fs.writeFileSync(KEY_FILE, newKey); } catch (e) {}
  return newKey;
}

// AES-256-GCM for storage at rest
function encryptAtRest(text) {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('base64'),
  });
}

function decryptAtRest(vaultContent) {
  const parsed = JSON.parse(vaultContent);
  const key = getMasterKey();
  const iv = Buffer.from(parsed.iv, 'hex');
  const tag = Buffer.from(parsed.tag, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(parsed.data, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

// Streaming cipher for in-memory client delivery
function encryptForSession(text, sessionKey) {
  const textBuffer = Buffer.from(text, 'utf8');
  const keyBuffer = Buffer.from(sessionKey, 'utf8');
  const out = Buffer.alloc(textBuffer.length);

  let s = Array.from({ length: 256 }, (_, idx) => idx);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + keyBuffer[i % keyBuffer.length]) % 256;
    [s[i], s[j]] = [s[j], s[i]];
  }

  let i = 0;
  j = 0;
  for (let k = 0; k < textBuffer.length; k++) {
    i = (i + 1) % 256;
    j = (j + s[i]) % 256;
    [s[i], s[j]] = [s[j], s[i]];
    const t = (s[i] + s[j]) % 256;
    out[k] = textBuffer[k] ^ s[t];
  }

  return out.toString('base64');
}

// Anti-inspection & anti-tamper shield injection
const SHIELD_SCRIPT = `
<script id="__howl_shield__">
(function() {
  'use strict';
  // Block right-click inspect
  window.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    e.stopPropagation();
    return false;
  }, true);

  // Block DevTools shortcuts (F12, Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C, Ctrl+U, Ctrl+S)
  window.addEventListener('keydown', function(e) {
    var k = e.key ? e.key.toLowerCase() : '';
    if (
      e.key === 'F12' ||
      (e.ctrlKey && e.shiftKey && (k === 'i' || k === 'j' || k === 'c')) ||
      (e.ctrlKey && (k === 'u' || k === 's')) ||
      (e.metaKey && e.altKey && (k === 'i' || k === 'j' || k === 'u'))
    ) {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
  }, true);

  // Disable text select and dragging inside game area
  document.addEventListener('selectstart', function(e) { e.preventDefault(); }, false);
  document.addEventListener('dragstart', function(e) { e.preventDefault(); }, false);

  // Prevent breaking out of sandbox iframe
  try {
    window.open = function() {
      console.warn('Popups are disabled in game emulator.');
      return null;
    };
  } catch(err) {}
})();
</script>
`;

function injectShield(html) {
  let content = html || '';
  if (!content.includes('<html') && !content.includes('<body') && !content.includes('<!DOCTYPE')) {
    content = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000;display:flex;align-items:center;justify-content:center;}</style></head><body>${content}</body></html>`;
  }

  if (content.includes('</head>')) {
    return content.replace('</head>', `${SHIELD_SCRIPT}\n</head>`);
  } else if (content.includes('<body')) {
    return content.replace(/<body([^>]*)>/i, `<body$1>\n${SHIELD_SCRIPT}`);
  }
  return SHIELD_SCRIPT + '\n' + content;
}

/**
 * Save an HTML game into the secure vault
 */
function saveHtmlGameToVault(gameId, options) {
  const gameVaultDir = path.join(VAULT_DIR, gameId);
  if (!fs.existsSync(gameVaultDir)) {
    fs.mkdirSync(gameVaultDir, { recursive: true });
  }

  let finalHtml = '';
  let fileType = 'code';
  let displayName = 'game.html';

  if (options.rawCode && typeof options.rawCode === 'string' && options.rawCode.trim()) {
    finalHtml = options.rawCode.trim();
    fileType = 'code';
    displayName = 'pasted-code.html';
  } else if (options.fileBuffer) {
    const ext = path.extname(options.fileName || '').toLowerCase();
    displayName = options.fileName || 'game.html';

    if (ext === '.zip') {
      fileType = 'zip';
      if (!AdmZip) {
        throw new Error('ZIP processing is currently unavailable on server.');
      }
      const zip = new AdmZip(options.fileBuffer);
      const zipEntries = zip.getEntries();
      
      let htmlEntry = zipEntries.find(e => e.entryName.toLowerCase() === 'index.html' || e.entryName.toLowerCase().endsWith('/index.html'));
      if (!htmlEntry) {
        htmlEntry = zipEntries.find(e => e.entryName.toLowerCase().endsWith('.html'));
      }
      if (!htmlEntry) {
        throw new Error('The uploaded zip archive does not contain an index.html or .html entry point.');
      }

      const bundleDir = path.join(gameVaultDir, 'bundle');
      if (fs.existsSync(bundleDir)) {
        fs.rmSync(bundleDir, { recursive: true, force: true });
      }
      fs.mkdirSync(bundleDir, { recursive: true });
      zip.extractAllTo(bundleDir, true);

      const entryPath = path.join(bundleDir, htmlEntry.entryName);
      finalHtml = fs.readFileSync(entryPath, 'utf8');
      fs.writeFileSync(path.join(gameVaultDir, 'entry_rel.txt'), htmlEntry.entryName, 'utf8');
    } else {
      fileType = 'html';
      finalHtml = options.fileBuffer.toString('utf8');
    }
  } else {
    throw new Error('No game code or file was provided.');
  }

  const protectedHtml = injectShield(finalHtml);
  const encryptedPayload = encryptAtRest(protectedHtml);
  fs.writeFileSync(path.join(gameVaultDir, 'game.vault'), encryptedPayload, 'utf8');

  const meta = {
    gameId,
    displayName,
    fileType,
    size: Buffer.byteLength(protectedHtml, 'utf8'),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(gameVaultDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  return meta;
}

function hasHtmlGameInVault(gameId) {
  const vaultFile = path.join(VAULT_DIR, gameId, 'game.vault');
  return fs.existsSync(vaultFile);
}

function getSessionPayload(gameId) {
  const gameVaultDir = path.join(VAULT_DIR, gameId);
  const vaultFile = path.join(gameVaultDir, 'game.vault');
  if (!fs.existsSync(vaultFile)) {
    return null;
  }

  const vaultRaw = fs.readFileSync(vaultFile, 'utf8');
  const decryptedHtml = decryptAtRest(vaultRaw);

  const sessionKey = crypto.randomBytes(32).toString('hex');
  const sessionPayload = encryptForSession(decryptedHtml, sessionKey);

  return {
    sessionKey,
    payload: sessionPayload,
  };
}

function deleteHtmlGameFromVault(gameId) {
  const gameVaultDir = path.join(VAULT_DIR, gameId);
  if (fs.existsSync(gameVaultDir)) {
    fs.rmSync(gameVaultDir, { recursive: true, force: true });
    return true;
  }
  return false;
}

module.exports = {
  saveHtmlGameToVault,
  hasHtmlGameInVault,
  getSessionPayload,
  deleteHtmlGameFromVault,
};
