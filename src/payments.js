import QRCode from 'qrcode';
import { config } from './config.js';
import { defaultBusiness, getBusiness, scheduleLabel } from './catalog.js';
import * as pey from './pey.js';
import {
  addMessage, chargesForJob, createCharge, findChargeForEvent, getJob,
  markEventProcessed, nextNumRef, updateCharge, updateJob,
} from './store.js';
import { publish } from './events.js';

const money = n => `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export { money };

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

  if (method === 'push') {
    if (!/^\d{10}$/.test(job.phone || '')) throw new Error('Falta un celular de 10 dígitos para mandar el cobro.');
    if (config.allowedPhones.length && !config.allowedPhones.includes(job.phone)) {
      throw new Error('Este celular no está habilitado para cobros en la demo.');
    }
  }

  // No mandar un segundo cobro del mismo tipo mientras haya uno pendiente reciente.
  const open = chargesForJob(job.id).find(
    c => c.kind === kind && c.status === 'pendiente' && Date.now() - c.createdAt < 15 * 60e3 && c.method === method,
  );
  if (open) return open;

  const chargedAmount = config.demoChargeAmount ?? quotedAmount;
  const numRef = nextNumRef();
  const concept = `${business.name} ${kind}`;
  const charge = createCharge({
    jobId: job.id, kind, method, quotedAmount, chargedAmount, numRef, concept,
    simulated: config.peyMock,
  });
  const metadata = { chargeId: charge.id, jobId: job.id, businessId: business.id, kind };

  try {
    if (method === 'push') {
      const r = await pey.createPush({ amount: chargedAmount, concept, numRef, metadata, phoneNumber: job.phone });
      updateCharge(charge.id, { peyTransactionId: r.transactionId, peyCodiId: r.codiId });
    } else {
      const r = await pey.createQr({ amount: chargedAmount, concept, numRef, metadata });
      const qrDataUrl = r.qrImage
        ? `data:image/png;base64,${r.qrImage}`
        : await QRCode.toDataURL(r.qrString, { margin: 1, width: 280 });
      updateCharge(charge.id, { peyId: r.id, qrString: r.qrString, qrDataUrl });
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
  if (charge.kind === 'restante') return `Recibimos tu pago de ${amount}. ¡Gracias por tu preferencia!`;
  if (charge.kind === 'anticipo') {
    return `Recibimos tu anticipo de ${amount}. ` +
      (label === 'Cita' ? `Tu cita quedó confirmada para el ${job.slot}. ` : label ? `Tu pedido quedó confirmado para el ${job.slot}. ` : '') +
      `Restan ${money(pending)}, que se pagan al terminar.`;
  }
  if (label === 'Cita') return `Recibimos tu pago de ${amount}. Tu cita quedó confirmada para el ${job.slot}. ¡Trato hecho!`;
  if (label) return `Recibimos tu pago de ${amount}. Tu pedido quedó confirmado para entrega el ${job.slot}. ¡Trato hecho!`;
  return `Recibimos tu pago de ${amount}. ${b.owner} ya está preparando tu pedido. ¡Trato hecho!`;
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
  notifyJob(job.id);
  return { ok: true, chargeId: charge.id };
}
