import { config } from './config.js';
import { availableSlots, buildQuote, findItem, itemById, scheduleLabel } from './catalog.js';
import {
  INFO_INTENTS, digitCount, intents, isGibberish, isQuestion, isUsefulDetail, matchSlot, norm,
  parsePhone, parseQuantity, withoutPhone,
} from './nlu.js';
import { businessFor, chargeJob, firstChargeKind, jobTotals, money, notifyJob, say } from './payments.js';
import { getJob, updateJob } from './store.js';

// El agente sigue los pasos que configuró cada negocio (producto, cantidad, detalles, horario, celular),
// valida cada respuesta y, si no entiende, explica por qué y pide un dato concreto.
// Los precios y los cobros los decide el servidor. Con LLM_API_KEY, un LLM ayuda a entender texto libre.

const MAX_QTY = 99;
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const QTY_OPTIONS = [1, 2, 3, 6, 12];

const itemButtons = b => b.items.map(it => ({ label: `${it.name} · ${money(it.price)}`, action: `item:${it.id}` }));
const humanButton = b => ({ label: `Hablar con ${b.owner}`, action: 'human' });
const quote = s => `«${s.length > 40 ? s.slice(0, 40) + '…' : s}»`;

export function greet(job) {
  const b = businessFor(job);
  say(job.id, 'agente', `Hola, soy ${b.agentName}, el asistente de ${b.name}. ${b.greeting}`,
    { buttons: itemButtons(b) });
}

/** Paso en el que va la conversación. */
export function currentStep(job, b) {
  if (!job.itemId) return 'item';
  if (b.steps.quantity && !job.quantity) return 'quantity';
  if (b.steps.details && !job.description) return 'details';
  if (b.steps.schedule && !job.slot) return 'slot';
  if (!job.phone && !job.phoneSkipped) return 'phone';
  if (!job.quote) return 'quote';
  return job.status === 'cotizando' ? 'pay' : 'done';
}

/** Datos que se pueden sacar del mensaje con reglas, según el paso. */
export function extractByRules(job, b, text, step) {
  const t = text.trim();
  const out = { intents: intents(t), question: isQuestion(t), gibberish: isGibberish(t) };
  const phone = parsePhone(t);
  if (phone) out.phone = phone;
  const rest = withoutPhone(t);

  const item = !job.itemId ? findItem(b, rest) : null;
  if (item) out.itemId = item.id;

  const qtyNow = b.steps.quantity && !job.quantity && (step === 'quantity' || item);
  if (qtyNow) {
    const q = parseQuantity(rest);
    if (q != null) out.quantity = q;
  }

  if (b.steps.details && !job.description && !out.question) {
    if (step === 'details' && !phone && isUsefulDetail(t)) out.description = t;
    // Si el primer mensaje ya describe el problema ("se tapó el baño desde ayer"), lo usamos.
    if (step === 'item' && item && norm(t).split(' ').length >= 7 && isUsefulDetail(t)) out.description = t;
  }

  if (step === 'slot') {
    const i = matchSlot(t, job.slots);
    if (i != null) out.slotIndex = i;
  }
  if (step === 'phone' && /\bqr\b/i.test(t)) out.phoneSkipped = true;
  out.affirm = out.intents.includes('affirm') && !out.intents.includes('deny');
  out.deny = out.intents.includes('deny') && !out.affirm;
  return out;
}

async function extractByLlm(job, b, text, step) {
  const system = [
    `Eres ${b.agentName}, el asistente por chat de "${b.name}" (${b.giro}, ${b.zone}).`,
    'Analiza el mensaje del cliente. NUNCA inventes precios, descuentos ni horarios.',
    `Productos o servicios (id: nombre): ${b.items.map(it => `${it.id}: ${it.name}`).join('; ')}.`,
    `Paso actual de la conversación: ${step}. Datos ya conocidos: ${JSON.stringify({ itemId: job.itemId, quantity: job.quantity, description: job.description, slot: job.slot })}.`,
    'Devuelve SOLO JSON: {"itemId": string|null, "quantity": number|null, "description": string|null,',
    '"intent": "dato"|"pregunta"|"saludo"|"fuera_de_tema"|"incoherente", "reply": string|null}.',
    '"description" solo si el mensaje describe el trabajo con detalle útil. "incoherente" si no tiene sentido.',
    '"reply": respuesta breve (máx. 2 oraciones) solo si es una pregunta que no trata de precios, horario, zona ni pagos.',
  ].join('\n');
  const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.llmApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.llmModel,
      response_format: { type: 'json_object' },
      temperature: 0.2,
      messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || '{}';
  const p = JSON.parse(raw.replace(/^```json|```$/g, '').trim());
  if (p.itemId && !itemById(b, p.itemId)) delete p.itemId;
  if (p.quantity != null && !(Number(p.quantity) > 0)) delete p.quantity;
  return p;
}

async function extract(job, b, text, step) {
  const rules = extractByRules(job, b, text, step);
  if (!config.llmApiKey || rules.gibberish) return rules;
  try {
    const llm = await extractByLlm(job, b, text, step);
    const merged = { ...rules };
    if (!merged.itemId && llm.itemId && !job.itemId) merged.itemId = llm.itemId;
    if (merged.quantity == null && llm.quantity && b.steps.quantity && !job.quantity && step === 'quantity') merged.quantity = Number(llm.quantity);
    if (!merged.description && llm.description && step === 'details' && isUsefulDetail(llm.description)) merged.description = llm.description;
    if (llm.intent === 'incoherente') merged.gibberish = true;
    if (llm.intent === 'pregunta' && llm.reply) merged.llmReply = llm.reply;
    return merged;
  } catch (err) {
    console.warn('[agent] LLM falló, uso reglas:', err.message);
    return rules;
  }
}

function infoAnswer(b, intent) {
  if (intent === 'prices') {
    const list = b.items.map(it => `• ${it.name}: ${money(it.price)}`).join('\n');
    const pay = b.depositPercent < 100
      ? `Para apartar se paga un anticipo del ${b.depositPercent}% y el resto al terminar.`
      : 'Se paga al confirmar.';
    return `Estos son nuestros precios:\n${list}\n\n${pay}`;
  }
  if (intent === 'hours') return `Nuestro horario: ${b.hours || 'escríbenos y te confirmamos'}.`;
  if (intent === 'location') return `Atendemos en: ${b.zone}.`;
  if (intent === 'payment') {
    return 'Pagas con CoDi desde la app de tu banco: te llega una notificación para aprobar el cobro o escaneas un QR. ' +
      'No tiene comisión, el dinero llega directo al negocio y no necesitas tarjeta.';
  }
  return '';
}

export async function handleClientMessage(jobId, { text, action }) {
  let job = getJob(jobId);
  if (!job) throw new Error('Conversación no encontrada');
  const b = businessFor(job);
  if (text) say(job.id, 'cliente', text);

  if (action) return handleAction(job, b, action);

  const step = currentStep(job, b);
  const data = await extract(job, b, text || '', step);

  // Comandos que aplican en cualquier momento.
  if (data.intents.includes('cancel') && step !== 'done') return restart(job, b, 'Listo, lo dejamos aquí. Si cambias de opinión, dime qué necesitas.');
  if (data.intents.includes('human')) return handoff(job, b);

  // Datos nuevos.
  const patch = {};
  if (data.itemId && !job.quote) patch.itemId = data.itemId;
  if (data.quantity != null && b.steps.quantity && !job.quote) {
    if (data.quantity >= 1 && data.quantity <= MAX_QTY) patch.quantity = data.quantity;
    else if (step === 'quantity' || patch.itemId) {
      job = updateJob(job.id, patch);
      return say(job.id, 'agente',
        data.quantity < 1
          ? 'La cantidad tiene que ser al menos 1. ¿Cuántos quieres?'
          : `Por chat puedo tomar pedidos de hasta ${MAX_QTY}. Para una cantidad mayor, ${b.owner} te contacta para darte precio especial.`,
        { buttons: data.quantity < 1 ? qtyButtons() : [humanButton(b), ...qtyButtons().slice(-2)] });
    }
  }
  if (data.description) patch.description = data.description.slice(0, 300);
  if (data.slotIndex != null && job.slots?.[data.slotIndex]) patch.slot = job.slots[data.slotIndex];
  if (data.phone && !job.quote) patch.phone = data.phone;
  if (data.phoneSkipped && !job.quote) patch.phoneSkipped = true;

  if (Object.keys(patch).length) {
    patch.confusions = 0;
    job = updateJob(job.id, patch);
    notifyJob(job.id);
    // Si además hizo una pregunta, primero la respondemos.
    const info = data.intents.find(i => INFO_INTENTS.includes(i));
    return nextStep(job, b, info ? infoAnswer(b, info) : '');
  }

  // Sin datos nuevos: responder según la intención y el paso.
  const info = data.intents.find(i => INFO_INTENTS.includes(i));
  if (info) return nextStep(job, b, infoAnswer(b, info), { quiet: step === 'done' });
  if (data.llmReply) return nextStep(job, b, data.llmReply, { quiet: step === 'done' });

  if (step === 'pay') {
    if (data.affirm) return pay(job, job.phone ? 'push' : 'qr');
    if (data.deny) {
      return say(job.id, 'agente', 'Sin problema. ¿Quieres cambiar algo de la cotización o prefieres hablar con alguien?',
        { buttons: [{ label: 'Cambiar algo', action: 'change' }, humanButton(b)] });
    }
  }
  if (step === 'done') return statusReply(job, b, data);

  if (data.intents.includes('greeting') && !data.gibberish) return nextStep(job, b, '¡Hola! 👋');
  if (data.intents.includes('thanks')) return nextStep(job, b, '¡Con gusto!');

  // Un detalle extra a media conversación ("es el baño de arriba"): se anota para el negocio.
  if (['slot', 'phone', 'pay'].includes(step) && !data.question && norm(text).split(' ').length >= 5 && isUsefulDetail(text)) {
    const note = text.trim().slice(0, 200);
    job = updateJob(job.id, { description: job.description ? `${job.description} · ${note}` : note });
    notifyJob(job.id);
    return nextStep(job, b, `Anotado, se lo paso a ${b.owner}.`);
  }

  // Pidió un día que no está entre las opciones.
  if (step === 'slot') {
    const day = WEEKDAYS.find(d => new RegExp(`\\b${d}\\b`).test(norm(text)));
    if (day && !(job.slots || []).some(s => norm(s).startsWith(day))) {
      return say(job.id, 'agente',
        `El ${day.replace('miercoles', 'miércoles').replace('sabado', 'sábado')} no tengo espacio. Estos son los horarios disponibles más próximos:`,
        { buttons: [...job.slots.map((s, i) => ({ label: s, action: `slot:${i}` })), humanButton(b)] });
    }
  }
  return misunderstood(job, b, step, data, text || '');
}

function qtyButtons() {
  return QTY_OPTIONS.map(n => ({ label: String(n), action: `qty:${n}` }));
}

function handleAction(job, b, action) {
  if (action === 'pay_push' || action === 'pay_qr') return pay(job, action === 'pay_push' ? 'push' : 'qr');
  if (action === 'change') return restart(job, b, 'Sin problema, empecemos de nuevo. ¿Qué necesitas?');
  if (action === 'human') return handoff(job, b);
  if (action === 'prices') return nextStep(job, b, infoAnswer(b, 'prices'));
  if (job.quote && job.status !== 'cotizando') return statusReply(job, b, {});
  const patch = { confusions: 0 };
  if (action.startsWith('item:') && itemById(b, action.slice(5)) && !job.quote) patch.itemId = action.slice(5);
  if (action.startsWith('qty:')) {
    const q = Number(action.slice(4));
    if (q >= 1 && q <= MAX_QTY) patch.quantity = q;
  }
  if (action.startsWith('slot:')) {
    const s = job.slots?.[Number(action.slice(5))];
    if (s) patch.slot = s;
  }
  job = updateJob(job.id, patch);
  notifyJob(job.id);
  return nextStep(job, b);
}

function restart(job, b, text) {
  job = updateJob(job.id, {
    itemId: null, quantity: null, description: null, slot: null, slots: null, quote: null,
    phoneSkipped: false, status: 'cotizando', confusions: 0,
  });
  notifyJob(job.id);
  return say(job.id, 'agente', text, { buttons: itemButtons(b) });
}

function handoff(job, b) {
  job = updateJob(job.id, { needsHuman: true, handoffAt: Date.now() });
  notifyJob(job.id);
  const step = currentStep(job, b);
  const keepGoing = step === 'done' ? '' : ' Mientras tanto, puedo seguir ayudándote con tu cotización.';
  return say(job.id, 'agente',
    `Listo, ya le avisé a ${b.owner}. Te va a escribir aquí mismo en cuanto pueda (horario: ${b.hours || 'en horario de atención'}).${keepGoing}`);
}

/** No entendió: explica qué necesita y cómo responder. Después de 2 intentos ofrece hablar con el negocio. */
function misunderstood(job, b, step, data, text) {
  const confusions = (job.confusions || 0) + 1;
  job = updateJob(job.id, { confusions });
  const extra = confusions >= 2 ? [humanButton(b)] : [];
  const sorry = data.gibberish ? 'Perdón, no logré entender tu mensaje. ' : '';

  if (step === 'item') {
    const examples = b.items.slice(0, 2).map(it => `«${it.name.toLowerCase()}»`).join(' o ');
    const msg = data.gibberish || norm(text).length < 3
      ? `${sorry}¿Me dices qué necesitas? Puedes tocar una opción o escribir algo como ${examples}.`
      : `No encontré ${quote(text)} entre lo que ofrece ${b.name}. Esto es lo que manejamos; elige una opción o descríbelo con otras palabras:`;
    return say(job.id, 'agente', msg, { buttons: [...itemButtons(b), ...extra] });
  }
  if (step === 'quantity') {
    return say(job.id, 'agente', `${sorry}¿Cuántos quieres? Escribe un número (por ejemplo, 3) o toca una opción.`,
      { buttons: [...qtyButtons(), ...extra] });
  }
  if (step === 'details') {
    const ex = b.detailsExample ? ` Por ejemplo: «${b.detailsExample}».` : '';
    const why = data.question
      ? 'Antes de responderte eso necesito un dato: '
      : `${sorry}Para darte un precio correcto necesito un poco más de detalle. `;
    return say(job.id, 'agente', `${why}${b.detailsPrompt || 'Cuéntame más, por favor.'}${ex}`, { buttons: extra });
  }
  if (step === 'slot') {
    return say(job.id, 'agente', `${sorry}No me quedó claro qué horario prefieres. Toca una opción o escribe 1, 2 o 3.`,
      { buttons: [...(job.slots || []).map((s, i) => ({ label: s, action: `slot:${i}` })), ...extra] });
  }
  if (step === 'phone') {
    const n = digitCount(text);
    const msg = n > 0
      ? `Ese número tiene ${n} dígito${n === 1 ? '' : 's'} y necesito un celular de 10, por ejemplo 55 1234 5678.`
      : `${sorry}Para mandarte el cobro necesito tu celular a 10 dígitos (el que usas con la app de tu banco). Si prefieres no darlo, escribe «QR» y te doy un código para escanear.`;
    return say(job.id, 'agente', msg, { buttons: extra });
  }
  if (step === 'pay') {
    return say(job.id, 'agente', `${sorry}¿Cómo prefieres pagar?`, { buttons: payButtons(job, b) });
  }
  return statusReply(job, b, data);
}

function statusReply(job, b, data) {
  const label = scheduleLabel(b) === 'Cita' ? 'cita' : 'pedido';
  const { pending } = jobTotals(job);
  if (data.intents?.includes('thanks')) return say(job.id, 'agente', `¡A ti! Cualquier cosa, aquí estamos. — ${b.name}`);
  if (job.status === 'esperando_anticipo' || job.status === 'esperando_pago' || job.status === 'esperando_restante') {
    return say(job.id, 'agente',
      `Estoy esperando la confirmación de tu pago de ${money(pending > 0 && job.status === 'esperando_restante' ? pending : job.quote.deposit)}. ` +
      'Si ya lo aprobaste en tu banco, aquí te confirmo en unos segundos. ¿Quieres que te lo mande de nuevo?',
      { buttons: payButtons(job, b, false) });
  }
  if (job.status === 'confirmada') {
    return say(job.id, 'agente',
      `Tu ${label} está confirmad${label === 'cita' ? 'a' : 'o'}${job.slot ? ` para el ${job.slot}` : ''}.` +
      (pending > 0 ? ` Quedan ${money(pending)} por pagar al terminar.` : '') +
      ` Si necesitas algo más, ${b.owner} te puede escribir.`, { buttons: [humanButton(b)] });
  }
  return say(job.id, 'agente', `Todo quedó pagado. ¡Gracias por tu confianza! Si necesitas algo más, ${b.owner} te puede escribir.`,
    { buttons: [humanButton(b), { label: 'Hacer otro pedido', action: 'change' }] });
}

function payButtons(job, b, withChange = true) {
  const out = [];
  if (job.phone) out.push({ label: 'Mándame el cobro a mi app del banco', action: 'pay_push' });
  out.push({ label: job.phone ? 'Prefiero pagar con QR' : 'Pagar con QR', action: 'pay_qr' });
  if (withChange) out.push({ label: 'Cambiar algo', action: 'change' });
  return out;
}

/** Pregunta lo que falta o arma la cotización. prefix: respuesta previa (por ejemplo, precios). */
function nextStep(job, b, prefix = '', { quiet = false } = {}) {
  const step = currentStep(job, b);
  const lead = prefix ? `${prefix}\n\n` : '';
  if (quiet || step === 'done') return say(job.id, 'agente', prefix || '¿En qué más te ayudo?');
  if (step === 'pay') {
    return say(job.id, 'agente', `${lead}¿Cómo prefieres pagar${firstChargeKind(job) === 'anticipo' ? ' el anticipo' : ''}?`,
      { buttons: payButtons(job, b) });
  }
  if (step === 'item') {
    return say(job.id, 'agente', `${lead}¿Qué necesitas? Elige una opción o escríbelo con tus palabras.`, { buttons: itemButtons(b) });
  }
  const item = itemById(b, job.itemId);
  if (step === 'quantity') {
    return say(job.id, 'agente', `${lead}${item.name} (${money(item.price)} c/u). ¿Cuántos quieres?`, { buttons: qtyButtons() });
  }
  if (step === 'details') {
    return say(job.id, 'agente', `${lead}${item.name}, entendido. ${b.detailsPrompt || 'Cuéntame un poco más, por favor.'}`);
  }
  if (step === 'slot') {
    const first = !job.slots;
    const slots = job.slots || availableSlots(b);
    updateJob(job.id, { slots });
    const question = b.scheduleQuestion ||
      (b.steps.schedule === 'entrega' ? '¿Cuándo te lo entregamos?' : '¿Qué horario te acomoda?');
    const intro = first
      ? `Perfecto: ${item.name}${job.quantity > 1 ? ` × ${job.quantity}` : ''}. ${question}`
      : 'Elige uno de estos horarios:';
    return say(job.id, 'agente', `${lead}${intro}`, { buttons: slots.map((s, i) => ({ label: s, action: `slot:${i}` })) });
  }
  if (step === 'phone') {
    return say(job.id, 'agente',
      `${lead}¿A qué celular te mandamos el cobro? Escribe los 10 dígitos del número que usas con tu banco, o «QR» si prefieres escanear un código.`);
  }

  // Cotización.
  const q = buildQuote(b, item, job.quantity || 1);
  job = updateJob(job.id, { quote: q });
  notifyJob(job.id);
  const line = q.items[0];
  const label = scheduleLabel(b);
  const demo = config.demoChargeAmount != null ? ` (prueba: se cobrará ${money(config.demoChargeAmount)})` : '';
  const pago = firstChargeKind(job) === 'anticipo'
    ? `Para apartar ${label === 'Cita' ? 'la cita' : 'tu pedido'} pagas hoy un anticipo del ${b.depositPercent}%: ` +
      `${money(q.deposit)}${demo}. El resto, al terminar.`
    : `Total a pagar: ${money(q.total)}${demo}.`;
  return say(job.id, 'agente',
    `${lead}Tu cotización:\n• ${line.quantity > 1 ? `${line.quantity} × ` : ''}${line.concept}: ${money(line.amount)}` +
    (label ? `\n• ${label}: ${job.slot}` : '') +
    `\n\n${pago} Se paga con CoDi, sin comisión.`,
    {
      buttons: payButtons(job, b),
      kind: 'quote',
      quote: {
        lines: q.items, total: q.total, deposit: q.deposit, chargeKind: firstChargeKind(job),
        depositPercent: b.depositPercent, slot: job.slot, slotLabel: label, demoAmount: config.demoChargeAmount,
      },
    });
}

async function pay(job, method) {
  const b = businessFor(job);
  if (!job.quote) return nextStep(job, b);
  if (method === 'push' && !job.phone) {
    updateJob(job.id, { phoneSkipped: false });
    return say(job.id, 'agente', 'Para mandarte el cobro a tu app necesito tu celular a 10 dígitos. ¿Cuál es?');
  }
  try {
    const kind = job.status === 'confirmada' || job.status === 'esperando_restante' ? 'restante' : firstChargeKind(job);
    const charge = await chargeJob(job, kind, method);
    if (method === 'push') {
      return say(job.id, 'agente',
        `Listo, te mandé un cobro CoDi por ${money(charge.quotedAmount)} al celular ${job.phone}. ` +
        'Ábrelo en la app de tu banco y apruébalo; aquí te confirmo en cuanto llegue.',
        { kind: 'charge', chargeId: charge.id, method, amount: charge.quotedAmount, simulated: charge.simulated });
    }
    return say(job.id, 'agente',
      `Escanea este QR desde la app de tu banco para pagar ${money(charge.quotedAmount)}:`,
      { kind: 'charge', chargeId: charge.id, method, amount: charge.quotedAmount, qrDataUrl: charge.qrDataUrl, simulated: charge.simulated });
  } catch (err) {
    console.error('[pay]', err.message);
    const friendly = /celular/i.test(err.message) ? err.message : 'No pude generar el cobro en este momento.';
    return say(job.id, 'agente', `${friendly} ¿Lo intentamos de nuevo o con el otro método?`,
      { buttons: payButtons(job, b) });
  }
}
