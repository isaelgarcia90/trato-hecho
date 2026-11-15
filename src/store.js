import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

// Almacenamiento simple en un archivo JSON. Suficiente para el hackatón;
// se cambia por una base de datos real cuando haga falta.
const file = path.resolve(config.dataFile);

function empty() {
  return { jobs: {}, charges: {}, processedEvents: {}, nextNumRef: 1000 + Math.floor(Math.random() * 8000) };
}

let db = empty();
try {
  db = { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
} catch {
  /* primer arranque */
}

function save() {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, file);
}

export const newId = () => crypto.randomUUID().slice(0, 8);

export function createJob(businessId) {
  const job = {
    id: newId(),
    businessId,
    createdAt: Date.now(),
    itemId: null,
    quantity: null,
    description: null,
    slot: null,
    slots: null,
    phone: null,
    name: null,
    quote: null,
    extras: [],
    // cotizando | esperando_anticipo | esperando_pago | confirmada | esperando_restante | pagada
    status: 'cotizando',
    messages: [],
  };
  db.jobs[job.id] = job;
  save();
  return job;
}

export const getJob = id => db.jobs[id] || null;
export const listJobs = () => Object.values(db.jobs).sort((a, b) => b.createdAt - a.createdAt);

export function updateJob(id, patch) {
  const job = db.jobs[id];
  if (!job) return null;
  Object.assign(job, patch);
  save();
  return job;
}

export function addMessage(jobId, from, text, extra = {}) {
  const job = db.jobs[jobId];
  const msg = { id: newId(), from, text, at: Date.now(), ...extra };
  job.messages.push(msg);
  save();
  return msg;
}

export function nextNumRef() {
  db.nextNumRef = (db.nextNumRef % 9999999) + 1;
  save();
  return String(db.nextNumRef);
}

export function createCharge(data) {
  const charge = { id: newId(), createdAt: Date.now(), status: 'pendiente', ...data };
  db.charges[charge.id] = charge;
  save();
  return charge;
}

export const getCharge = id => db.charges[id] || null;
export const chargesForJob = jobId => Object.values(db.charges).filter(c => c.jobId === jobId);

export function updateCharge(id, patch) {
  Object.assign(db.charges[id], patch);
  save();
  return db.charges[id];
}

export function findChargeForEvent(evt) {
  const all = Object.values(db.charges);
  // pey puede regresar la metadata plana o anidada en externalMetadata.
  const chargeId = evt.metadata?.chargeId || evt.metadata?.externalMetadata?.chargeId;
  const numRef = evt.numRef != null ? String(evt.numRef) : null;
  return (
    (evt.transactionId && all.find(c => c.peyTransactionId === evt.transactionId)) ||
    (evt.codiQrId && all.find(c => c.peyId === evt.codiQrId)) ||
    (chargeId && db.charges[chargeId]) ||
    (numRef && all.find(c => String(c.numRef) === numRef && c.status === 'pendiente')) ||
    null
  );
}

// Idempotencia: cada evento (webhook-id o transactionId) se procesa una sola vez.
export function markEventProcessed(key) {
  if (db.processedEvents[key]) return false;
  db.processedEvents[key] = Date.now();
  save();
  return true;
}
