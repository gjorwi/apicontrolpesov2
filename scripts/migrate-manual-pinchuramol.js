// Migración one-time: extrae los pacientes de la cuenta pinchuramol@gmail.com
// desde la base vieja `test` y crea un RESPALDO MANUAL en `controlpeso_copia`,
// más la cuenta (contraseña) para poder restaurarlo desde la app.
//
// Uso:  node scripts/migrate-manual-pinchuramol.js
// Idempotente: reejecutarlo reemplaza el respaldo manual y re-fija la contraseña.
require('dotenv').config();
const crypto = require('crypto');
const mongoose = require('mongoose');

const BACKUP_ID = 'pinchuramol@gmail.com';
const PASSWORD = '12345678';
// Josefina (no es un paciente real): se excluye por id.
const EXCLUDE_IDS = new Set(['e66a0984-d685-42cf-95a9-ec34c5f95fcf']);

const TARGET_URI = process.env.MONGODB_URI || process.env.DATABASE_URL || '';
if (!TARGET_URI) {
  console.error('Falta MONGODB_URI en server/.env');
  process.exit(1);
}
const SOURCE_URI = TARGET_URI.replace('/controlpeso_copia?', '/test?');
if (SOURCE_URI === TARGET_URI) {
  console.warn('Aviso: no se pudo derivar la URI de `test` desde MONGODB_URI; se usará la misma.');
}

async function main() {
  const now = new Date().toISOString();

  // 1) Leer snapshots de la cuenta en la base vieja.
  const src = await mongoose.createConnection(SOURCE_URI, { serverSelectionTimeoutMS: 15000 }).asPromise();
  const snaps = await src.collection('sync_snapshots').find({ backupId: BACKUP_ID }).toArray();
  await src.close();

  const map = new Map();
  for (const d of snaps) {
    const ps = (d.data && d.data.patients) || [];
    for (const p of ps) {
      if (!p || !p.id || p.deletedAt) continue;
      if (EXCLUDE_IDS.has(p.id)) continue;
      const prev = map.get(p.id);
      if (!prev || String(p.updatedAt || '') >= String(prev.updatedAt || '')) map.set(p.id, p);
    }
  }
  const patients = [...map.values()];
  console.log(`[migrate] snapshots=${snaps.length} pacientes=${patients.length}`);

  // 2) Escribir respaldo manual + cuenta en controlpeso_copia.
  const dst = await mongoose.createConnection(TARGET_URI, { serverSelectionTimeoutMS: 15000 }).asPromise();

  const data = { version: 2, ts: now, patients, survey: null };
  await dst.collection('manual_backups').updateOne(
    { backupId: BACKUP_ID },
    { $set: { backupId: BACKUP_ID, data, ts: now, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = crypto.scryptSync(PASSWORD, salt, 64).toString('hex');
  await dst.collection('backup_accounts').updateOne(
    { backupId: BACKUP_ID },
    {
      $set: { backupId: BACKUP_ID, passwordHash, passwordSalt: salt, updatedAt: now },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );

  // 3) Verificación.
  const saved = await dst.collection('manual_backups').findOne({ backupId: BACKUP_ID });
  const account = await dst.collection('backup_accounts').findOne({ backupId: BACKUP_ID });
  const names = (saved?.data?.patients || []).map((p) => p.name).filter(Boolean);
  console.log(`[migrate] manual_backups.backupId=${BACKUP_ID} patients=${names.length}`);
  console.log(`[migrate] account=${account ? account.backupId : '(falta)'} password=${PASSWORD}`);
  console.log(`[migrate] primeros: ${names.slice(0, 5).join(' | ')}`);
  await dst.close();
}

main().catch((e) => {
  console.error('[migrate] FAIL:', e.message);
  process.exit(1);
});
