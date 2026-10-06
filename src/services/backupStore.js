const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Cuentas de respaldo (backupId + contraseña) y respaldo manual intacto.
// La "copia de seguridad" automática vive en syncStore (sync_snapshots).
// Ambas colecciones comparten la conexión de Mongoose ya abierta por syncStore.

const ACCOUNTS_FILE = path.join(__dirname, '..', '..', 'data', 'backup_accounts.json');
const MANUAL_FILE = path.join(__dirname, '..', '..', 'data', 'manual_backups.json');
const AUTO_FILE = path.join(__dirname, '..', '..', 'data', 'app_backups.json');

let AccountModel = null;
let ManualModel = null;
let AppBackupModel = null;
let mongoReady = false;

function nowISO() {
  return new Date().toISOString();
}

function cleanDoc(doc) {
  if (!doc) return null;
  const { _id, __v, ...rest } = doc;
  return rest;
}

async function initDb() {
  const uri = process.env.MONGODB_URI || process.env.DATABASE_URL || '';
  if (!uri) return false;
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    }
    const accountSchema = new mongoose.Schema(
      {
        backupId: { type: String, required: true, unique: true },
        passwordHash: { type: String, default: '' },
        passwordSalt: { type: String, default: '' },
        createdAt: { type: String, default: '' },
        updatedAt: { type: String, default: '' },
      },
      { collection: 'backup_accounts', minimize: false }
    );

    const manualSchema = new mongoose.Schema(
      {
        backupId: { type: String, required: true, unique: true },
        data: { type: mongoose.Schema.Types.Mixed, default: {} },
        ts: { type: String, default: '' },
        createdAt: { type: String, default: '' },
        updatedAt: { type: String, default: '' },
      },
      { collection: 'manual_backups', minimize: false }
    );

    AccountModel = mongoose.models.BackupAccount || mongoose.model('BackupAccount', accountSchema);
    ManualModel = mongoose.models.ManualBackup || mongoose.model('ManualBackup', manualSchema);

    // Copia de seguridad automática: UN documento por cuenta (backupId).
    const appSchema = new mongoose.Schema(
      {
        backupId: { type: String, required: true, unique: true },
        data: { type: mongoose.Schema.Types.Mixed, default: {} },
        ts: { type: String, default: '' },
        updatedAt: { type: String, default: '' },
      },
      { collection: 'app_backups', minimize: false }
    );
    AppBackupModel = mongoose.models.AppBackup || mongoose.model('AppBackup', appSchema);

    mongoReady = true;
    return true;
  } catch (e) {
    console.warn('[backupStore] Mongo init failed, fallback a archivo JSON:', e.message);
    AccountModel = null;
    ManualModel = null;
    AppBackupModel = null;
    mongoReady = false;
    return false;
  }
}

// ------------------------------------------------------------ archivo JSON

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8')) || fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, obj) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

// ------------------------------------------------------------- contraseñas

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), s, 64).toString('hex');
  return { salt: s, hash };
}

function verifyHash(password, doc) {
  if (!doc || !doc.passwordHash || !doc.passwordSalt) return false;
  const { hash } = hashPassword(password, doc.passwordSalt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(doc.passwordHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- cuentas

async function getAccount(backupId) {
  const id = String(backupId || '').trim();
  if (!id) return null;
  if (mongoReady && AccountModel) {
    const doc = await AccountModel.findOne({ backupId: id }).lean();
    return cleanDoc(doc);
  }
  const all = readJson(ACCOUNTS_FILE, {});
  return all[id] || null;
}

// Crea la cuenta si no existe; si existe, valida que la contraseña coincida.
async function registerAccount(backupId, password) {
  const id = String(backupId || '').trim();
  const pass = String(password || '');
  if (!id) return { ok: false, error: 'BACKUP_ID_REQUIRED' };
  if (!pass) return { ok: false, error: 'PASSWORD_REQUIRED' };

  const existing = await getAccount(id);
  if (existing) {
    if (verifyHash(pass, existing)) return { ok: true, created: false };
    return { ok: false, error: 'PASSWORD_MISMATCH' };
  }

  const { salt, hash } = hashPassword(pass);
  const now = nowISO();
  if (mongoReady && AccountModel) {
    try {
      await AccountModel.create({
        backupId: id,
        passwordHash: hash,
        passwordSalt: salt,
        createdAt: now,
        updatedAt: now,
      });
      return { ok: true, created: true };
    } catch (e) {
      if (e && e.code === 11000) {
        const acc = await getAccount(id);
        if (acc && verifyHash(pass, acc)) return { ok: true, created: false };
        return { ok: false, error: 'PASSWORD_MISMATCH' };
      }
      throw e;
    }
  }

  const all = readJson(ACCOUNTS_FILE, {});
  all[id] = { backupId: id, passwordHash: hash, passwordSalt: salt, createdAt: now, updatedAt: now };
  writeJson(ACCOUNTS_FILE, all);
  return { ok: true, created: true };
}

async function verifyPassword(backupId, password) {
  const acc = await getAccount(backupId);
  if (!acc) return { ok: false, error: 'NO_ACCOUNT' };
  if (!verifyHash(String(password || ''), acc)) return { ok: false, error: 'PASSWORD_MISMATCH' };
  return { ok: true };
}

// ------------------------------------------------------ respaldo manual

async function getManual(backupId) {
  const id = String(backupId || '').trim();
  if (!id) return null;
  if (mongoReady && ManualModel) {
    const doc = await ManualModel.findOne({ backupId: id }).lean();
    return cleanDoc(doc);
  }
  const all = readJson(MANUAL_FILE, {});
  return all[id] || null;
}

// Reemplazo COMPLETO del respaldo correspondiente al backupId.
async function setManual(backupId, data, ts) {
  const id = String(backupId || '').trim();
  if (!id) return null;
  const now = nowISO();
  if (mongoReady && ManualModel) {
    await ManualModel.updateOne(
      { backupId: id },
      {
        $set: { data: data || {}, ts: ts || now, updatedAt: now },
        $setOnInsert: { backupId: id, createdAt: now },
      },
      { upsert: true }
    );
    return { backupId: id, ts: ts || now, updatedAt: now };
  }
  const all = readJson(MANUAL_FILE, {});
  const prev = all[id] || {};
  all[id] = {
    backupId: id,
    data: data || {},
    ts: ts || now,
    createdAt: prev.createdAt || now,
    updatedAt: now,
  };
  writeJson(MANUAL_FILE, all);
  return all[id];
}

// ------------------------------------------------- copia de seguridad (auto)

function toTS(iso) {
  const t = new Date(iso).getTime();
  return isNaN(t) ? 0 : t;
}

function cleanId(v) {
  const id = typeof v === 'string' ? v : v && typeof v.id === 'string' ? v.id : '';
  return id.trim();
}

function stampPatient(p) {
  if (!p || typeof p !== 'object') return p;
  return { ...p, updatedAt: p.updatedAt || nowISO() };
}

// Merge de pacientes por id conservando el updatedAt más reciente (igual
// criterio que el sync). Los tombstone borran.
function mergePatientSets(existing, incoming, tombstoneIds) {
  const map = new Map();
  for (const p of Array.isArray(existing) ? existing : []) {
    const id = cleanId(p);
    if (id) map.set(id, stampPatient(p));
  }
  if (tombstoneIds && tombstoneIds.size) tombstoneIds.forEach((id) => map.delete(id));
  for (const p of Array.isArray(incoming) ? incoming : []) {
    const id = cleanId(p);
    if (!id) continue;
    if (p.deletedAt) { map.delete(id); continue; }
    const sp = stampPatient(p);
    const prev = map.get(id);
    if (!prev || toTS(sp.updatedAt) >= toTS(prev.updatedAt)) map.set(id, sp);
  }
  return [...map.values()];
}

function mapAuto(doc) {
  if (!doc) return null;
  return {
    backupId: doc.backupId,
    data: doc.data || {},
    ts: doc.ts || '',
    updatedAt: doc.updatedAt || '',
  };
}

async function getAuto(backupId) {
  const id = String(backupId || '').trim();
  if (!id) return null;
  if (mongoReady && AppBackupModel) {
    return mapAuto(await AppBackupModel.findOne({ backupId: id }).lean());
  }
  const all = readJson(AUTO_FILE, {});
  return all[id] || null;
}

async function setAuto(backupId, data, ts) {
  const id = String(backupId || '').trim();
  if (!id) return null;
  const now = nowISO();
  if (mongoReady && AppBackupModel) {
    await AppBackupModel.updateOne(
      { backupId: id },
      { $set: { data: data || {}, ts: ts || now, updatedAt: now } },
      { upsert: true }
    );
    return { backupId: id, data: data || {}, ts: ts || now, updatedAt: now };
  }
  const all = readJson(AUTO_FILE, {});
  all[id] = { backupId: id, data: data || {}, ts: ts || now, updatedAt: now };
  writeJson(AUTO_FILE, all);
  return all[id];
}

// Push+merge de la copia de seguridad de una cuenta. `replace:true` sustituye.
async function mergeAuto(backupId, { patients, deletedPatients, survey, ts, replace } = {}) {
  const id = String(backupId || '').trim();
  if (!id) return null;
  const prev = await getAuto(id);
  const prevData = (prev && prev.data) || {};
  const tomb = new Set((Array.isArray(deletedPatients) ? deletedPatients : []).map(cleanId).filter(Boolean));

  let merged;
  if (replace === true) {
    merged = (Array.isArray(patients) ? patients : []).filter((p) => p && p.id && !p.deletedAt);
  } else {
    merged = mergePatientSets(prevData.patients || [], patients || [], tomb);
  }

  const nextData = { patients: merged };
  if (survey !== undefined) nextData.survey = survey;
  else if (prevData.survey !== undefined) nextData.survey = prevData.survey;

  await setAuto(id, nextData, ts);
  return nextData;
}

// Todas las cuentas activas (excluye copias preservadas *_respaldo).
async function listAuto({ includeRespaldo = false } = {}) {
  if (mongoReady && AppBackupModel) {
    const docs = await AppBackupModel.find({}).lean();
    return docs
      .map(mapAuto)
      .filter((d) => d && (includeRespaldo || !String(d.backupId || '').endsWith('_respaldo')));
  }
  const all = readJson(AUTO_FILE, {});
  return Object.values(all).filter(
    (d) => d && (includeRespaldo || !String(d.backupId || '').endsWith('_respaldo'))
  );
}

async function renameAuto(from, to) {
  const a = String(from || '').trim();
  const b = String(to || '').trim();
  if (!a || !b) return { updated: 0 };
  if (mongoReady && AppBackupModel) {
    const r = await AppBackupModel.updateOne({ backupId: a }, { $set: { backupId: b, updatedAt: nowISO() } });
    return { updated: r.modifiedCount || 0 };
  }
  const all = readJson(AUTO_FILE, {});
  if (!all[a]) return { updated: 0 };
  all[b] = { ...all[a], backupId: b, updatedAt: nowISO() };
  delete all[a];
  writeJson(AUTO_FILE, all);
  return { updated: 1 };
}

async function deleteAuto(backupId) {
  const id = String(backupId || '').trim();
  if (!id) return { deleted: 0 };
  if (mongoReady && AppBackupModel) {
    const r = await AppBackupModel.deleteOne({ backupId: id });
    return { deleted: r.deletedCount || 0 };
  }
  const all = readJson(AUTO_FILE, {});
  if (!all[id]) return { deleted: 0 };
  delete all[id];
  writeJson(AUTO_FILE, all);
  return { deleted: 1 };
}

module.exports = {
  initDb,
  getAccount,
  registerAccount,
  verifyPassword,
  getManual,
  setManual,
  getAuto,
  setAuto,
  mergeAuto,
  listAuto,
  renameAuto,
  deleteAuto,
};
