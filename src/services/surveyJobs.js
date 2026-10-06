// Trabajos del reporte/encuesta: envío automático (L/M/V), digest de
// pendientes con push al médico, envío manual y cálculo de estados.
const crypto = require('crypto');
const backupStore = require('./backupStore');
const deviceStore = require('./deviceStore');
const surveyStore = require('./surveyStore');
const { sendMail, getEffectiveSender } = require('./mailer');
const { sendPushBatch } = require('./pushService');
const { buildSurveyEmail, EMAIL_RE } = require('./surveyEmail');
const { wallDateStr, wallTimeOfDay, wallWeekday, minutesOf } = require('./wallTime');

const MAX_PUSH_BODY = 300;

// Normaliza el "scope" con el que se busca data de un médico: acepta un
// deviceId (string, retrocompatible) o un objeto { deviceId, backupId }.
function resolveScope(scope) {
  if (typeof scope === 'string') return { deviceId: scope || '', backupId: '' };
  if (scope && typeof scope === 'object') {
    return { deviceId: scope.deviceId || '', backupId: scope.backupId || '' };
  }
  return { deviceId: '', backupId: '' };
}

function snapMatches(snap, { deviceId, backupId }) {
  if (backupId) return snap.backupId === backupId;
  if (deviceId) return snap.deviceId === deviceId;
  return true;
}

function surveyBaseUrl() {
  return String(process.env.SURVEY_BASE_URL || '').trim().replace(/\/+$/, '');
}

function buildLink(token) {
  const base = surveyBaseUrl();
  return base ? `${base}/responder?t=${token}` : '';
}

function firstNameOf(name) {
  const n = String(name || '').trim();
  return n ? n.split(/\s+/)[0] : '';
}

// Pacientes vivos de todos los snapshots (o de un deviceId), deduplicados por
// id conservando la versión más reciente (updatedAt mayor).
async function listAllPatients(scope) {
  const query = resolveScope(scope);
  const docs = await backupStore.listAuto();
  const byId = new Map();
  for (const doc of docs) {
    if (!doc || !doc.data) continue;
    const backupId = doc.backupId || '';
    if (query.backupId && backupId !== query.backupId) continue;
    const patients = Array.isArray(doc.data.patients) ? doc.data.patients : [];
    for (const p of patients) {
      if (!p || !p.id || p.deletedAt) continue;
      const prev = byId.get(p.id);
      if (!prev || String(p.updatedAt || '') >= String(prev.patient.updatedAt || '')) {
        byId.set(p.id, { patient: p, deviceId: '', backupId });
      }
    }
  }
  return Array.from(byId.values());
}

// Igual que listAllPatients pero además agrega pacientes conocidos únicamente
// por sus invites/responses (sin snapshot sincronizado). Esto permite que el
// médico vea el estado de sus encuestas incluso si nunca presionó
// "Sincronizar" o si el paciente fue creado en otro dispositivo.
async function listKnownPatients(scope) {
  const query = resolveScope(scope);
  const known = await listAllPatients(query);
  const byId = new Map(known.map((x) => [x.patient.id, x]));
  const [invites, responses] = await Promise.all([
    surveyStore.listInvites({ backupId: query.backupId || undefined, limit: 1000 }),
    surveyStore.listResponses({ backupId: query.backupId || undefined, limit: 1000 }),
  ]);
  const stamp = new Date().toISOString();
  for (const i of invites) {
    if (!i.patientId || byId.has(i.patientId)) continue;
    byId.set(i.patientId, {
      patient: {
        id: i.patientId,
        name: i.patientName || '(sin nombre)',
        email: i.email || '',
        updatedAt: i.createdAt || stamp,
      },
      deviceId: i.deviceId || query.deviceId || '',
      backupId: i.backupId || query.backupId || '',
      orphaned: true,
    });
  }
  for (const r of responses) {
    if (!r.patientId || byId.has(r.patientId)) continue;
    byId.set(r.patientId, {
      patient: {
        id: r.patientId,
        name: r.patientName || '(sin nombre)',
        email: '',
        updatedAt: r.createdAt || stamp,
      },
      deviceId: r.deviceId || query.deviceId || '',
      backupId: r.backupId || query.backupId || '',
      orphaned: true,
    });
  }
  return Array.from(byId.values());
}

async function findPatient(patientId, scope) {
  const query = resolveScope(scope);
  const all = await listAllPatients(query);
  const found = all.find((x) => x.patient.id === patientId);
  if (found) return found;
  // Si la copia del dispositivo no lo tiene, se busca en las demás.
  if (query.deviceId || query.backupId) {
    return listAllPatients().then((xs) => xs.find((x) => x.patient.id === patientId) || null);
  }
  return null;
}

// --------------------------------------------------------------- envíos

// Crea (o reutiliza) el invite del paciente para `date` y envía el correo.
// Devuelve { ok, reason?, messageId?, mock? }.
async function sendSurveyToPatient({ patient, deviceId, backupId, date, source = 'manual', cfg }) {
  const config = cfg || (await surveyStore.getConfig());
  const email = String(patient?.email || '').trim();
  if (!EMAIL_RE.test(email)) return { ok: false, reason: 'no_email' };
  if (!surveyBaseUrl()) {
    console.warn('[survey] SURVEY_BASE_URL no configurada; no se puede armar el link.');
    return { ok: false, reason: 'no_url' };
  }

  const nowIso = new Date().toISOString();
  const ttlHours = Number(config.ttlHours) || 72;
  const expiresAt = new Date(Date.now() + ttlHours * 3600000).toISOString();

  let invite = await surveyStore.getInvite(patient.id, date);
  if (!invite) {
    invite = await surveyStore.createInvite({
      token: crypto.randomBytes(24).toString('hex'),
      patientId: patient.id,
      patientName: String(patient.name || ''),
      deviceId: deviceId || '',
      backupId: backupId || '',
      date,
      email,
      status: 'pending',
      source,
      questionVersion: Number(config.version) || 1,
      expiresAt,
      messageId: '',
      error: '',
      sentAt: '',
      resentAt: '',
      openedAt: '',
      completedAt: '',
      responseId: '',
    });
  } else if (backupId && !invite.backupId) {
    // Reetiquetamos un invite viejo con el backupId del médico.
    await surveyStore.markInvite(invite.token, { backupId });
  }

  if (invite.status === 'completed') return { ok: false, reason: 'already_completed', invite };
  if ((invite.status === 'sent' || invite.status === 'opened') && source === 'auto') {
    return { ok: false, reason: 'already_sent', invite };
  }

  const resend = invite.status === 'sent' || invite.status === 'opened' || !!invite.sentAt;
  const patchBase = { expiresAt, email };

  // Mock local: se registra como enviado para poder probar el flujo completo.
  if (process.env.MOCK_MAIL === 'true') {
    const messageId = 'mock-' + Date.now();
    await surveyStore.markInvite(invite.token, {
      ...patchBase,
      status: 'sent',
      messageId,
      error: '',
      sentAt: invite.sentAt || nowIso,
      resentAt: resend ? nowIso : (invite.resentAt || ''),
    });
    console.log(`[mock-mail][survey] to=${email} date=${date} token=${invite.token.slice(0, 8)}…`);
    return { ok: true, mock: true, messageId, invite };
  }

  if (!getEffectiveSender()) {
    await surveyStore.markInvite(invite.token, { ...patchBase, status: 'skipped', error: 'smtp_not_configured' });
    return { ok: false, reason: 'smtp_not_configured', invite };
  }

  try {
    const { subject, body, html } = buildSurveyEmail({
      patient,
      url: buildLink(invite.token),
      date,
      signature: config.signature || 'Doctora Flor',
      expiresAt,
    });
    // Por defecto texto plano: el HTML con botón cae en spam en Gmail.
    // Poner SURVEY_EMAIL_MODE=rich para volver al diseño HTML.
    const rich = String(process.env.SURVEY_EMAIL_MODE || 'plain').toLowerCase() === 'rich';
    const info = await sendMail({
      to: email,
      subject,
      body,
      html: rich ? html : undefined,
      headers: { 'X-Entity-Ref-ID': crypto.randomBytes(8).toString('hex') },
    });
    await surveyStore.markInvite(invite.token, {
      ...patchBase,
      status: 'sent',
      messageId: info.messageId || '',
      error: '',
      sentAt: invite.sentAt || nowIso,
      resentAt: resend ? nowIso : (invite.resentAt || ''),
      source: invite.source === 'manual' || source === 'manual' ? 'manual' : invite.source,
    });
    console.log(`[survey] email sent to=${email} date=${date} source=${source} id=${info.messageId}`);
    return { ok: true, messageId: info.messageId, invite };
  } catch (e) {
    await surveyStore.markInvite(invite.token, { ...patchBase, status: 'failed', error: String(e.message || e).slice(0, 200) });
    console.error(`[survey] email FAIL to=${email} date=${date} code=${e.code} msg=${e.message}`);
    return { ok: false, reason: 'send_failed', error: e.message, invite };
  }
}

// ------------------------------------------------- envío automático del día

async function dispatchDay(date, cfg) {
  const patients = await listAllPatients();
  const result = { total: patients.length, sent: 0, skipped: 0, failed: 0, noEmail: 0, already: 0 };
  for (const { patient, deviceId, backupId } of patients) {
    try {
      const r = await sendSurveyToPatient({ patient, deviceId, backupId, date, source: 'auto', cfg });
      if (r.ok) result.sent++;
      else if (r.reason === 'no_email') result.noEmail++;
      else if (r.reason === 'already_sent' || r.reason === 'already_completed') result.already++;
      else if (r.reason === 'send_failed') result.failed++;
      else result.skipped++;
    } catch (e) {
      result.failed++;
      console.error(`[survey] dispatch error patient=${patient.id}:`, e.message);
    }
  }
  console.log(`[survey] dispatch ${date} sent=${result.sent} already=${result.already} noEmail=${result.noEmail} failed=${result.failed} skipped=${result.skipped}`);
  return result;
}

// ------------------------------------------------------ digest de pendientes

function statusFor(patient, date, invite, responseToday, lastResponse) {
  if (responseToday) return 'completed';
  const email = String(patient.email || '').trim();
  if (!invite) {
    // Si la invite de hoy no existe pero el paciente ya respondió
    // recientemente, lo marcamos como "completed" para que el médico lo vea
    // (caso de respuesta con fecha distinta por zona horaria o TTL amplio).
    if (lastResponse) return 'completed';
    return EMAIL_RE.test(email) ? 'not_sent' : 'no_email';
  }
  if (invite.status === 'completed') return 'completed';
  if (invite.status === 'failed') return 'failed';
  if (invite.status === 'skipped') return 'smtp_not_configured';
  if (!EMAIL_RE.test(email)) return 'no_email';
  return 'sent'; // sent | opened | pending
}

// Estado de todos los pacientes para una fecha (+ último reporte conocido).
async function getOverview({ date, deviceId, backupId } = {}) {
  const finalDate = date || wallDateStr(new Date());
  const bId = backupId || undefined;
  const [patients, invites, responsesToday, responsesRecent] = await Promise.all([
    listKnownPatients({ deviceId, backupId }),
    surveyStore.listInvites({ date: finalDate, backupId: bId, limit: 2000 }),
    surveyStore.listResponses({ date: finalDate, backupId: bId, limit: 2000 }),
    surveyStore.listResponses({ backupId: bId, limit: 500 }),
  ]);

  const inviteByPatient = new Map(invites.map((i) => [i.patientId, i]));
  const responseByPatientToday = new Map(responsesToday.map((r) => [r.patientId, r]));

  // Respuesta más reciente por paciente (de cualquier fecha, para detectar
  // respuestas que caen en otro día por zona horaria o por encuestas con TTL
  // amplio respondidas más tarde).
  const latestByPatient = new Map();
  for (const r of responsesRecent) {
    const prev = latestByPatient.get(r.patientId);
    if (!prev || String(r.createdAt || '') > String(prev.createdAt || '')) {
      latestByPatient.set(r.patientId, r);
    }
  }

  const items = patients.map(({ patient, deviceId: dev }) => {
    const invite = inviteByPatient.get(patient.id) || null;
    const responseToday = responseByPatientToday.get(patient.id) || null;
    const last = latestByPatient.get(patient.id) || null;
    return {
      patientId: patient.id,
      name: patient.name || '(sin nombre)',
      email: String(patient.email || '').trim(),
      deviceId: dev,
      status: statusFor(patient, finalDate, invite, responseToday, last),
      sentAt: invite?.sentAt || null,
      resentAt: invite?.resentAt || null,
      source: invite?.source || null,
      completedAt: responseToday?.createdAt || invite?.completedAt || null,
      lastResponse: last
        ? {
            id: last.responseId,
            date: last.date,
            createdAt: last.createdAt,
            aiStatus: last.aiStatus,
            nivel: last.ai?.nivel || null,
            alerta: !!last.ai?.alerta,
            motivo: last.ai?.motivo || null,
            accion: last.ai?.accion || null,
          }
        : null,
    };
  });

  items.sort((a, b) => a.name.localeCompare(b.name, 'es'));

  const counts = { completed: 0, sent: 0, not_sent: 0, no_email: 0, failed: 0, smtp_not_configured: 0, alerts: 0 };
  for (const it of items) {
    counts[it.status] = (counts[it.status] || 0) + 1;
    if (it.lastResponse?.alerta) counts.alerts++;
  }

  return { date: finalDate, items, counts };
}

async function computePending(date, deviceId, backupId) {
  const overview = await getOverview({ date, deviceId, backupId });
  const items = overview.items.filter((i) => i.status !== 'completed');
  return { date: overview.date, items, counts: overview.counts, total: overview.items.length };
}

async function runDigest(date) {
  const claimed = await surveyStore.claimDispatch(date, 'digest');
  if (!claimed) return { skipped: 'claimed' };

  const pending = await computePending(date);
  let pushed = 0;
  if (pending.items.length) {
    const devices = (await deviceStore.listAllDevices()).filter((d) => d.pushToken);
    if (devices.length) {
      const names = pending.items.slice(0, 8).map((i) => i.name);
      let body = `${pending.items.length} de ${pending.total || pending.items.length} paciente(s) sin reporte hoy: ${names.join(', ')}`;
      if (pending.items.length > 8) body += ` y ${pending.items.length - 8} más`;
      const res = await sendPushBatch(
        devices.map((d) => ({
          token: d.pushToken,
          title: 'Reportes de seguimiento pendientes',
          body: body.slice(0, MAX_PUSH_BODY),
          data: { type: 'survey_pending', date, count: pending.items.length },
        }))
      );
      pushed = res?.sent || 0;
    }
  }

  await surveyStore.setDispatchSummary(date, 'digest', {
    pending: pending.items.length,
    total: pending.total,
    pushed,
    at: new Date().toISOString(),
  });
  console.log(`[survey] digest ${date} pending=${pending.items.length} pushed=${pushed}`);
  return { pending: pending.items.length, pushed };
}

// ------------------------------------------------------------ job del tick

async function run(now = new Date()) {
  const cfg = await surveyStore.getConfig();
  if (cfg.enabled === false) return { skipped: 'disabled' };

  const date = wallDateStr(now);
  const dow = wallWeekday(now);
  const out = { date };
  if (!Array.isArray(cfg.days) || !cfg.days.includes(dow)) {
    out.skipped = 'not_scheduled_day';
    return out;
  }

  const mins = minutesOf(wallTimeOfDay(now));
  const sendFrom = minutesOf(cfg.time || '09:00');
  const sendUntil = minutesOf(cfg.lateUntil || '21:00');
  if (mins >= sendFrom && mins < sendUntil) {
    out.send = await dispatchDay(date, cfg);
  }

  const digestAt = minutesOf(cfg.digestTime || '18:00');
  if (mins >= digestAt) {
    out.digest = await runDigest(date);
  }
  return out;
}

// ------------------------------------------------------------- reportes

async function getPatientReport(patientId, scope, date) {
  const query = resolveScope(scope);
  const found = await findPatient(patientId, query);
  const inviteFilter = { patientId, limit: 200 };
  if (query.backupId) inviteFilter.backupId = query.backupId;
  const [allInvites, allResponses] = await Promise.all([
    surveyStore.listInvites(inviteFilter),
    surveyStore.listResponses(inviteFilter),
  ]);
  // date opcional: si llega, filtra invites/responses por ese día y, además,
  // expone `availableDates` con todas las fechas que tienen algo (para que la
  // app pueda construir un selector de historial).
  const invites = date ? allInvites.filter((i) => i.date === date) : allInvites;
  const responses = date ? allResponses.filter((r) => r.date === date) : allResponses;
  invites.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  responses.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const availableDates = Array.from(
    new Set([...allInvites.map((i) => i.date), ...allResponses.map((r) => r.date)].filter(Boolean))
  ).sort((a, b) => b.localeCompare(a));
  return {
    patient: found
      ? { id: found.patient.id, name: found.patient.name || '', email: found.patient.email || '', deviceId: found.deviceId }
      : { id: patientId, name: '', email: '', deviceId: query.deviceId || '' },
    invites,
    responses,
    availableDates,
    date: date || null,
  };
}

// Envío manual desde la app del médico (hoy por defecto).
async function manualSend({ patientId, deviceId, backupId, date }) {
  const finalDate = date || wallDateStr(new Date());
  const found = await findPatient(patientId, { deviceId, backupId });
  if (!found) return { ok: false, reason: 'no_patient' };
  const result = await sendSurveyToPatient({
    patient: found.patient,
    deviceId: found.deviceId,
    backupId: backupId || found.backupId || '',
    date: finalDate,
    source: 'manual',
  });
  return { ...result, date: finalDate, patientId };
}

module.exports = {
  run,
  listAllPatients,
  listKnownPatients,
  findPatient,
  sendSurveyToPatient,
  getOverview,
  computePending,
  getPatientReport,
  manualSend,
  buildLink,
  statusFor,
};
