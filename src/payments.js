import QRCode from 'qrcode';
import { config } from './config.js';
import { defaultBusiness, getBusiness, scheduleLabel } from './catalog.js';
import * as pey from './pey.js';
import {
  addMessage, chargesForJob, createCharge, findChargeForEvent, getJob,
  markEventProcessed, nextNumRef, ratingForJob, updateCharge, updateJob,
} from './store.js';
import { publish } from './events.js';

const money = n => `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export { money };

/** Estado del cobro real: 'unknown' hasta el primer intento, luego 'ok' o 'unavailable'. */
export const peyStatus = { real: 'unknown', lastError: null };

/** Modo que se muestra en la UI: 'simulado' (PEY_MOCK), 'auto-prueba' (pey rechazó) o 'produccion'. */
export function payMode() {
  if (config.peyMock) return 'simulado';
  return peyStatus.real === 'unavailable' ? 'auto-prueba' : 'produccion';
}

export const businessFor = job => getBusiness(job?.businessId) || defaultBusiness;

export function jobTotals(job) {
  const extras = (job.extras || []).reduce((s, e) => s + e.amount, 0);
  const total = (job.quote?.total || 0) + extras;
  const paid = chargesForJob(job.id)
    .filter(c => c.status === 'pagado')
    .reduce((s, c) => s + c.quotedAmount, 0);
  return { total, paid, pending: Math.max(0, Math.round((total - paid) * 100) / 100) };
}

export function say(jobId, from, text, extra) {
  const msg = addMessage(jobId, from, text, extra);
  publish({ type: 'message', jobId, message: msg });
  return msg;
}

export function notifyJob(jobId) {
  const job = getJob(jobId);
  publish({ type: 'job', jobId, job: publicJob(job) });
}

export function publicJob(job) {
  if (!job) return null;
  const b = businessFor(job);
  return {
    ...job,
    business: { id: b.id, name: b.name, emoji: b.emoji, color: b.color, scheduleLabel: scheduleLabel(b) },
    charges: chargesForJob(job.id),
    totals: jobTotals(job),
    rating: ratingForJob(job.id),
  };
}

/** Primer cobro: anticipo si el negocio pide un porcentaje, o el pago completo. */
export const firstChargeKind = job => (job.quote.deposit < job.quote.total ? 'anticipo' : 'pago');

/**
 * Crea un cobro CoDi para un trabajo.
 * kind: 'anticipo' | 'pago' | 'restante'; method: 'push' (notificación al celular) | 'qr'
 */
export async function chargeJob(job, kind, method) {
  const business = businessFor(job);
  const totals = jobTotals(job);
  const quotedAmount = kind === 'restante' ? totals.pending : job.quote.deposit;
  if (!(quotedAmount > 0)) throw new Error('No hay monto pendiente por cobrar.');

  if (method === 'push' && !/^\d{10}$/.test(job.phone || '')) {
    throw new Error('Falta un celular de 10 dígitos para mandar el cobro.');
  }

  // No mandar un segundo cobro del mismo tipo mientras haya uno pendiente reciente.
  const open = chargesForJob(job.id).find(
    c => c.kind === kind && c.status === 'pendiente' && Date.now() - c.createdAt < 15 * 60e3 && c.method === method,
  );
  if (open) return open;

  const chargedAmount = config.demoChargeAmount ?? quotedAmount;
  const numRef = nextNumRef();
  const concept = `${business.name} ${kind}`;
  // Modo automático: se intenta el cobro real; si no se puede, ese cobro queda de prueba.
  let testReason = config.peyMock ? 'mock' : null;
  if (!testReason && method === 'push' && config.allowedPhones.length && !config.allowedPhones.includes(job.phone)) {
    testReason = 'phone';
  }
  const charge = createCharge({
    jobId: job.id, kind, method, quotedAmount, chargedAmount, numRef, concept,
    simulated: Boolean(testReason), testReason,
  });
  const metadata = { chargeId: charge.id, jobId: job.id, businessId: business.id, kind };
  const args = { amount: chargedAmount, concept, numRef, metadata, phoneNumber: job.phone };

  const create = async simulated => {
    if (method === 'push') {
      const r = await pey.createPush(args, { simulated });
      updateCharge(charge.id, { peyTransactionId: r.transactionId, peyCodiId: r.codiId });
    } else {
      const r = await pey.createQr(args, { simulated });
      const qrDataUrl = r.qrImage
        ? `data:image/png;base64,${r.qrImage}`
        : await QRCode.toDataURL(r.qrString, { margin: 1, width: 280 });
      updateCharge(charge.id, { peyId: r.id, qrString: r.qrString, qrDataUrl });
    }
  };

  try {
    try {
      await create(Boolean(testReason));
      if (!testReason) Object.assign(peyStatus, { real: 'ok', lastError: null });
    } catch (err) {
      // Solo un rechazo de pey (4xx, p. ej. "CoDi not enabled") pasa a prueba.
      // Un 5xx o un error de red se reporta como error: pey pudo haber creado el cobro.
      if (testReason || !(err.status >= 400 && err.status < 500)) throw err;
      console.warn('[pay] pey rechazó el cobro real; queda de prueba:', err.message);
      Object.assign(peyStatus, { real: 'unavailable', lastError: err.message });
      updateCharge(charge.id, { simulated: true, testReason: 'pey', peyError: err.message });
      await create(true);
    }
  } catch (err) {
    updateCharge(charge.id, { status: 'error', error: err.message });
    notifyJob(job.id);
    throw err;
  }

  if (kind === 'restante') updateJob(job.id, { status: 'esperando_restante' });
  else if (job.status === 'cotizando') {
    updateJob(job.id, { status: kind === 'anticipo' ? 'esperando_anticipo' : 'esperando_pago' });
  }
  notifyJob(job.id);
  return chargesForJob(job.id).find(c => c.id === charge.id);
}

function paidMessage(job, charge, pending) {
  const b = businessFor(job);
  const label = scheduleLabel(b);
  const amount = money(charge.quotedAmount);
  if (charge.kind === 'restante') return `Recibimos ${amount}. ¡Gracias por tu preferencia!`;
  if (charge.kind === 'anticipo') {
    return `Recibimos tu anticipo de ${amount}. ` +
      (label === 'Cita' ? `Cita confirmada: ${job.slot}. ` : label ? `Pedido confirmado: ${job.slot}. ` : '') +
      `Restan ${money(pending)} al terminar.`;
  }
  if (label === 'Cita') return `Recibimos ${amount}. Cita confirmada: ${job.slot}. ¡Trato hecho!`;
  if (label) return `Recibimos ${amount}. Entrega confirmada: ${job.slot}. ¡Trato hecho!`;
  return `Recibimos ${amount}. ${b.owner} ya prepara tu pedido. ¡Trato hecho!`;
}

/** Procesa un evento de pago de pey (ya verificado). Idempotente. */
export function handlePaymentEvent(evt, eventKey) {
  const key = eventKey || evt.transactionId;
  // Solo se marca como procesado si encontramos el cobro; así un reintento de pey
  // todavía puede aplicarse si el evento llegó antes de guardar los IDs del cobro.
  const charge = findChargeForEvent(evt);
  if (!charge) return { unmatched: true };
  if (key && !markEventProcessed(key)) return { duplicate: true };
  if (charge.status === 'pagado') return { alreadyPaid: true, chargeId: charge.id };

  updateCharge(charge.id, {
    status: 'pagado',
    paidAt: evt.datePaid ? evt.datePaid * 1000 : Date.now(),
    paidAmount: evt.amount,
    peyTransactionId: charge.peyTransactionId || evt.transactionId,
  });

  const job = getJob(charge.jobId);
  const { pending } = jobTotals(job);
  updateJob(job.id, { status: pending > 0 ? 'confirmada' : 'pagada' });
  say(job.id, 'agente', paidMessage(job, charge, pending), { kind: 'paid', chargeId: charge.id, amount: charge.quotedAmount });
  if (pending <= 0 && !ratingForJob(job.id)) {
    const owner = businessFor(job).owner;
    const label = { 5: 'Excelente', 4: 'Muy bien', 3: 'Regular', 2: 'Mal', 1: 'Muy mal' };
    say(job.id, 'agente', `¿Cómo calificarías a ${owner}? Tu opinión ayuda a otros clientes.`, {
      kind: 'rate',
      buttons: [5, 4, 3, 2, 1].map(n => ({ label: `${'⭐'.repeat(n)}  ${label[n]}`, action: `rate:${n}` })),
    });
  }
  notifyJob(job.id);
  return { ok: true, chargeId: charge.id };
}
