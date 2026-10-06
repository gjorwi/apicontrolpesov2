const express = require('express');
const requireAuth = require('../middleware/auth');
const backupStore = require('../services/backupStore');

const router = express.Router();
router.use(requireAuth);

function cleanId(v) {
  return String(v || '').trim();
}

function patientCount(doc) {
  return Array.isArray(doc?.data?.patients) ? doc.data.patients.length : 0;
}

// POST /api/backup/check { backupId }
// Indica si existe cuenta y qué versiones de copia de seguridad/respaldo hay.
router.post('/check', async (req, res, next) => {
  try {
    const backupId = cleanId(req.body?.backupId);
    if (!backupId) return res.status(400).json({ error: 'BACKUP_ID_REQUIRED', message: 'Falta el identificador.' });

    const [account, auto, preserved, manual] = await Promise.all([
      backupStore.getAccount(backupId),
      backupStore.getAuto(backupId),
      backupStore.getAuto(`${backupId}_respaldo`),
      backupStore.getManual(backupId),
    ]);

    const versions = [];
    if (auto) versions.push({ backupId, ts: auto.ts || '', patients: patientCount(auto) });
    if (preserved) versions.push({ backupId: `${backupId}_respaldo`, ts: preserved.ts || '', patients: patientCount(preserved) });

    return res.json({
      ok: true,
      backupId,
      accountExists: !!account,
      versions,
      hasManual: !!manual,
      manualTs: manual?.ts || null,
    });
  } catch (e) {
    console.error('[backup] check FAIL:', e?.message);
    next(e);
  }
});

// POST /api/backup/register { backupId, password }
router.post('/register', async (req, res, next) => {
  try {
    const backupId = cleanId(req.body?.backupId);
    const password = String(req.body?.password || '');
    if (!backupId) return res.status(400).json({ error: 'BACKUP_ID_REQUIRED', message: 'Falta el identificador.' });
    if (!password) return res.status(400).json({ error: 'PASSWORD_REQUIRED', message: 'Falta la contraseña.' });

    const r = await backupStore.registerAccount(backupId, password);
    if (!r.ok) {
      const status = r.error === 'PASSWORD_MISMATCH' ? 401 : 400;
      const message = r.error === 'PASSWORD_MISMATCH'
        ? 'La contraseña no coincide con la de esta cuenta.'
        : 'No se pudo registrar la cuenta.';
      return res.status(status).json({ error: r.error, message });
    }
    return res.json({ ok: true, created: !!r.created });
  } catch (e) {
    console.error('[backup] register FAIL:', e?.message);
    next(e);
  }
});

// POST /api/backup/auto { backupId, patients, deletedPatients, survey, ts, replace }
// Push+merge de la copia de seguridad (documento único por cuenta).
router.post('/auto', async (req, res, next) => {
  try {
    const backupId = cleanId(req.body?.backupId);
    if (!backupId) return res.status(400).json({ error: 'BACKUP_ID_REQUIRED', message: 'Falta el identificador.' });
    const { patients, deletedPatients, survey, ts, replace } = req.body || {};
    const data = await backupStore.mergeAuto(backupId, { patients, deletedPatients, survey, ts, replace });
    return res.json({
      ok: true,
      accepted: true,
      ts: ts || new Date().toISOString(),
      data: { patients: data?.patients || [] },
    });
  } catch (e) {
    console.error('[backup] auto FAIL:', e?.message);
    next(e);
  }
});

// POST /api/backup/auto/pull { backupId }
router.post('/auto/pull', async (req, res, next) => {
  try {
    const backupId = cleanId(req.body?.backupId);
    if (!backupId) return res.status(400).json({ error: 'BACKUP_ID_REQUIRED', message: 'Falta el identificador.' });
    const auto = await backupStore.getAuto(backupId);
    return res.json({
      ok: true,
      backupId,
      found: !!auto,
      ts: auto?.ts || null,
      data: auto?.data || { patients: [], survey: null },
    });
  } catch (e) {
    console.error('[backup] auto/pull FAIL:', e?.message);
    next(e);
  }
});

// POST /api/backup/manual/push { backupId, password, data, ts }
router.post('/manual/push', async (req, res, next) => {
  try {
    const backupId = cleanId(req.body?.backupId);
    const password = String(req.body?.password || '');
    const data = req.body?.data;
    if (!backupId) return res.status(400).json({ error: 'BACKUP_ID_REQUIRED', message: 'Falta el identificador.' });

    const v = await backupStore.verifyPassword(backupId, password);
    if (!v.ok) {
      const status = v.error === 'NO_ACCOUNT' ? 404 : 401;
      const message = v.error === 'NO_ACCOUNT'
        ? 'No existe una cuenta de respaldo con ese identificador.'
        : 'Contraseña incorrecta.';
      return res.status(status).json({ error: v.error, message });
    }
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'INVALID_DATA', message: 'Datos de respaldo inválidos.' });
    }

    await backupStore.setManual(backupId, data, req.body?.ts);
    console.log(`[backup] manual push backupId=${backupId} patients=${Array.isArray(data?.patients) ? data.patients.length : 0}`);
    return res.json({ ok: true, ts: req.body?.ts || new Date().toISOString() });
  } catch (e) {
    console.error('[backup] manual/push FAIL:', e?.message);
    next(e);
  }
});

// POST /api/backup/manual/pull { backupId, password }
router.post('/manual/pull', async (req, res, next) => {
  try {
    const backupId = cleanId(req.body?.backupId);
    const password = String(req.body?.password || '');
    if (!backupId) return res.status(400).json({ error: 'BACKUP_ID_REQUIRED', message: 'Falta el identificador.' });

    const v = await backupStore.verifyPassword(backupId, password);
    if (!v.ok) {
      const status = v.error === 'NO_ACCOUNT' ? 404 : 401;
      const message = v.error === 'NO_ACCOUNT'
        ? 'No existe una cuenta de respaldo con ese identificador.'
        : 'Contraseña incorrecta.';
      return res.status(status).json({ error: v.error, message });
    }

    const manual = await backupStore.getManual(backupId);
    if (!manual) {
      return res.status(404).json({ error: 'NO_BACKUP', message: 'No hay un respaldo guardado para esta cuenta.' });
    }
    return res.json({ ok: true, backupId, ts: manual.ts || null, data: manual.data || {} });
  } catch (e) {
    console.error('[backup] manual/pull FAIL:', e?.message);
    next(e);
  }
});

// POST /api/backup/rotate { backupId }
// Rotación tipo WhatsApp: descarta el E_respaldo previo y mueve la copia
// actual (E) a E_respaldo, dejando libre para empezar de cero en E.
router.post('/rotate', async (req, res, next) => {
  try {
    const backupId = cleanId(req.body?.backupId);
    if (!backupId) return res.status(400).json({ error: 'BACKUP_ID_REQUIRED', message: 'Falta el identificador.' });

    const preservedId = `${backupId}_respaldo`;
    const current = await backupStore.getAuto(backupId);
    let removedPrev = 0;
    let renamed = 0;
    if (current) {
      const del = await backupStore.deleteAuto(preservedId);
      const ren = await backupStore.renameAuto(backupId, preservedId);
      removedPrev = del.deleted;
      renamed = ren.updated;
    }
    console.log(`[backup] rotate backupId=${backupId} removedPrev=${removedPrev} renamed=${renamed}`);
    return res.json({ ok: true, preservedId, removedPrev, renamed });
  } catch (e) {
    console.error('[backup] rotate FAIL:', e?.message);
    next(e);
  }
});

module.exports = router;
