const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'devices.json');

let DeviceModel = null;
let mongoReady = false;

async function initDb() {
  const uri = process.env.MONGODB_URI || process.env.DATABASE_URL || '';
  if (!uri) return false;
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    }
    const schema = new mongoose.Schema(
      {
        // Identidad por token de push (una instalación). El deviceId de la app
        // cambia en cada reinstalación, por eso NO es clave.
        pushToken: { type: String, required: true, unique: true },
        deviceId: { type: String, default: '', index: true },
        backupId: { type: String, default: '', index: true },
        platform: { type: String, default: 'unknown' },
        updatedAt: { type: String, default: '' },
      },
      { collection: 'devices', minimize: false }
    );
    DeviceModel = mongoose.models.Device || mongoose.model('Device', schema);
    mongoReady = true;
    return true;
  } catch (e) {
    console.warn('[deviceStore] Mongo init failed, fallback a archivo JSON:', e.message);
    DeviceModel = null;
    mongoReady = false;
    return false;
  }
}

function fileRead() {
  try {
    if (!fs.existsSync(DATA_FILE)) return {};
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {};
  } catch (e) {
    return {};
  }
}

function fileWrite(obj) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

async function saveDeviceToken({ deviceId, pushToken, platform, backupId }) {
  if (!pushToken) throw new Error('pushToken es requerido');
  const now = new Date().toISOString();
  const rec = {
    pushToken,
    deviceId: deviceId || '',
    backupId: backupId || '',
    platform: platform || 'unknown',
    updatedAt: now,
  };
  if (mongoReady && DeviceModel) {
    await DeviceModel.updateOne({ pushToken }, { $set: rec }, { upsert: true });
    return;
  }
  const all = fileRead();
  all[pushToken] = rec;
  fileWrite(all);
}

async function getDeviceToken(deviceId) {
  if (!deviceId) return null;
  if (mongoReady && DeviceModel) {
    const doc = await DeviceModel.findOne({ deviceId }).sort({ updatedAt: -1 }).lean();
    if (!doc) return null;
    return { pushToken: doc.pushToken, platform: doc.platform, updatedAt: doc.updatedAt, backupId: doc.backupId };
  }
  const all = fileRead();
  const found = Object.values(all).filter((d) => d.deviceId === deviceId);
  return found[found.length - 1] || null;
}

async function removeDeviceToken(deviceId) {
  if (!deviceId) return;
  if (mongoReady && DeviceModel) {
    await DeviceModel.deleteMany({ deviceId });
    return;
  }
  const all = fileRead();
  for (const k of Object.keys(all)) {
    if (all[k].deviceId === deviceId) delete all[k];
  }
  fileWrite(all);
}

async function removeByPushToken(pushToken) {
  if (!pushToken) return;
  if (mongoReady && DeviceModel) {
    await DeviceModel.deleteOne({ pushToken });
    return;
  }
  const all = fileRead();
  delete all[pushToken];
  fileWrite(all);
}

// Tokens de push de todas las instalaciones asociadas a una cuenta.
async function listTokensByBackup(backupId) {
  const id = String(backupId || '').trim();
  if (!id) return [];
  if (mongoReady && DeviceModel) {
    const docs = await DeviceModel.find({ backupId: id }).lean();
    return docs.map((d) => ({ pushToken: d.pushToken, platform: d.platform }));
  }
  const all = fileRead();
  return Object.values(all)
    .filter((d) => d.backupId === id)
    .map((d) => ({ pushToken: d.pushToken, platform: d.platform }));
}

async function listAllDevices() {
  if (mongoReady && DeviceModel) {
    const docs = await DeviceModel.find({}).lean();
    return docs.map((d) => ({ deviceId: d.deviceId, pushToken: d.pushToken, platform: d.platform, backupId: d.backupId }));
  }
  const all = fileRead();
  return Object.values(all).map((v) => ({
    deviceId: v.deviceId,
    pushToken: v.pushToken,
    platform: v.platform,
    backupId: v.backupId,
  }));
}

module.exports = {
  initDb,
  saveDeviceToken,
  getDeviceToken,
  removeDeviceToken,
  removeByPushToken,
  listTokensByBackup,
  listAllDevices,
};
