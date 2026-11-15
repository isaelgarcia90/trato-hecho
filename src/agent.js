import { config } from './config.js';
import { availableSlots, buildQuote, findItem, itemById, scheduleLabel } from './catalog.js';
import {
  INFO_INTENTS, formatAddress, intents, isCorrection, isGibberish, isQuestion, isUsefulDetail, looksLikeAddress,
  looksLikePhone, matchSlot, norm, parseAddress, parseName, parseQuantity, validatePhone, withoutPhone,
} from './nlu.js';
import { businessFor, chargeJob, firstChargeKind, jobTotals, money, notifyJob, say } from './payments.js';
import { addRating, getJob, updateJob } from './store.js';

// El agente sigue los pasos de cada negocio (producto, cantidad, detalles, horario, dirección, celular),
// recuerda lo que el cliente ya dijo, acepta correcciones y valida cada dato antes de cotizar.
// Los precios y los cobros los decide el servidor. Con LLM_API_KEY, un LLM ayuda a entender texto libre.

const MAX_QTY = 99;
const QTY_OPTIONS = [1, 2, 3, 6, 12];
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const STARS = [5, 4, 3, 2, 1];
const STAR_LABEL = { 5: 'Excelente', 4: 'Muy bien', 3: 'Regular', 2: 'Mal', 1: 'Muy mal' };

const itemButtons = b => b.items.map(it => ({ label: `${it.name} · ${money(it.price)}`, action: `item:${it.id}` }));
const humanButton = b => ({ label: `Hablar con ${b.owner}`, action: 'human' });
const qtyButtons = () => QTY_OPTIONS.map(n => ({ label: String(n), action: `qty:${n}` }));
const slotButtons = job => (job.slots || []).map((s, i) => ({ label: s, action: `slot:${i}` }));
const short = s => `«${s.length > 40 ? s.slice(0, 40) + '…' : s}»`;
const fmtPhone = p => `${p.slice(0, 2)} ${p.slice(2, 6)} ${p.slice(6)}`;
const hi = job => (job.name ? `, ${job.name}` : '');

export function greet(job) {
  const b = businessFor(job);
  say(job.id, 'agente', `¡Hola! Soy ${b.agentName}, de ${b.name}. ${b.greeting}`, { buttons: itemButtons(b) });
}

/** Paso en el que va la conversación. */
export function currentStep(job, b) {
  if (job.awaitingComment) return 'comment';
  if (!job.itemId) return 'item';
  if (b.steps.quantity && !job.quantity) return 'quantity';
  if (b.steps.details && !job.description) return 'details';
  if (b.steps.schedule && !job.slot) return 'slot';
  if (b.steps.address && !job.address) return 'address';
  if (!job.phone && !job.phoneSkipped) return 'phone';
  if (!job.quote) return 'quote';
  return job.status === 'cotizando' ? 'pay' : 'done';
}

/** De un mensaje largo, solo el pedazo que es dirección ("… vivo en Morelos 45 col. Centro, mi cel …"). */
function addressSegment(text) {
  const t = norm(text);
  const start = t.search(/\b(vivo en|mi direccion es|direccion:?|calle|av\.?|avenida|calzada|cerrada|privada)\b/);
  let seg = start >= 0 ? t.slice(start) : t;
  const end = seg.search(/[,.;]?\s*\b(mi cel|celular|telefono|tel\.?|whats|mi numero|y mi)\b/);
  if (end > 0) seg = seg.slice(0, end);
  return seg.replace(/[,.;\s]+$/, '');
}

/** Saca del mensaje todo lo que sirva, aunque no sea del paso actual (el cliente puede adelantarse). */
export function extractByRules(job, b, text, step) {
  const t = text.trim();
  const out = {
    intents: intents(t), question: isQuestion(t), gibberish: isGibberish(t), correction: isCorrection(t),
  };
  const editable = !job.quote || job.status === 'cotizando';

  // Celular: se valida en cualquier momento.
  if (looksLikePhone(t) || step === 'phone') {
    const v = validatePhone(t);
    if (v.ok) out.phone = v.phone;
    else if (step === 'phone' || looksLikePhone(t)) out.phoneError = v;
  }
  const rest = withoutPhone(t);

  const name = parseName(t);
  if (name && !job.name) out.name = name;

  if (editable) {
    const item = (!job.itemId || out.correction) ? findItem(b, rest) : null;
    if (item && item.id !== job.itemId) out.itemId = item.id;

    if (b.steps.quantity && (step === 'quantity' || out.itemId || (job.quantity && out.correction))) {
      const q = parseQuantity(rest);
      if (q != null) out.quantity = q;
    }

    if (b.steps.details && !job.description && !out.question) {
      if (step === 'details' && !out.phone && isUsefulDetail(t)) out.description = t;
      if (step === 'item' && item && norm(t).split(' ').length >= 7 && isUsefulDetail(t)) out.description = t;
    }

    if (job.slots && (step === 'slot' || out.correction)) {
      const i = matchSlot(t, job.slots);
      if (i != null && job.slots[i] !== job.slot) out.slotIndex = i;
    }

    if (b.steps.address && !out.gibberish) {
      const inline = looksLikeAddress(rest);
      const addressing = (step === 'address' && !out.phone) || inline;
      const chatty = out.intents.some(i => ['greeting', 'thanks', 'affirm', 'deny', 'human', 'bot', ...INFO_INTENTS].includes(i)) && !inline;
      if (addressing && !chatty && (!job.address || out.correction)) {
        const piece = inline && step !== 'address' ? addressSegment(rest) : rest;
        out.address = parseAddress(piece, step === 'address' && !out.correction ? (job.addressDraft || {}) : {});
      }
    }
    if (step === 'phone' && /\bqr\b/i.test(t)) out.phoneSkipped = true;
  }
  out.affirm = out.intents.includes('affirm') && !out.intents.includes('deny');
  out.deny = out.intents.includes('deny') && !out.affirm;
  return out;
}

async function extractByLlm(job, b, text, step) {
  const system = [
    `Eres ${b.agentName}, el asistente por chat de "${b.name}" (${b.giro}, ${b.zone}).`,
    'Analiza el mensaje del cliente. NUNCA inventes precios, descuentos ni horarios.',
    `Productos o servicios (id: nombre): ${b.items.map(it => `${it.id}: ${it.name}`).join('; ')}.`,
    `Paso actual: ${step}. Datos conocidos: ${JSON.stringify({ itemId: job.itemId, quantity: job.quantity, description: job.description, slot: job.slot, address: job.address })}.`,
    'Devuelve SOLO JSON: {"itemId": string|null, "quantity": number|null, "description": string|null,',
    '"intent": "dato"|"pregunta"|"saludo"|"fuera_de_tema"|"incoherente", "reply": string|null}.',
    '"reply": respuesta breve (máx. 2 oraciones) solo para preguntas que no sean de precios, horario, zona ni pagos.',
  ].join('\n');
  const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.llmApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.llmModel, response_format: { type: 'json_object' }, temperature: 0.2,
      messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const data = await res.json();
  const p = JSON.parse((data.choices?.[0]?.message?.content || '{}').replace(/^```json|```$/g, '').trim());
  if (p.itemId && !itemById(b, p.itemId)) delete p.itemId;
  return p;
}

async function extract(job, b, text, step) {
  const rules = extractByRules(job, b, text, step);
  if (!config.llmApiKey || rules.gibberish) return rules;
  try {
    const llm = await extractByLlm(job, b, text, step);
    if (!rules.itemId && llm.itemId && !job.itemId) rules.itemId = llm.itemId;
    if (rules.quantity == null && Number(llm.quantity) > 0 && b.steps.quantity && step === 'quantity') rules.quantity = Number(llm.quantity);
    if (!rules.description && llm.description && step === 'details' && isUsefulDetail(llm.description)) rules.description = llm.description;
    if (llm.intent === 'incoherente') rules.gibberish = true;
    if (llm.intent === 'pregunta' && llm.reply) rules.llmReply = llm.reply;
  } catch (err) {
    console.warn('[agent] LLM falló, uso reglas:', err.message);
  }
  return rules;
}

function infoAnswer(b, intent) {
  if (intent === 'prices') {
    const list = b.items.map(it => `• ${it.name}: ${money(it.price)}`).join('\n');
    return `Precios:\n${list}` + (b.depositPercent < 100 ? `\n\nApartas con ${b.depositPercent}% y el resto al terminar.` : '');
  }
  if (intent === 'hours') return `Horario: ${b.hours}.`;
  if (intent === 'location') return b.mode === 'domicilio' ? `Vamos a domicilio en ${b.zone}.` : `Estamos en ${b.zone}.`;
  if (intent === 'payment') return 'Pagas con CoDi desde la app de tu banco: apruebas una notificación o escaneas un QR. Sin tarjeta y sin comisión.';
  return '';
}

export async function handleClientMessage(jobId, { text, action }) {
  let job = getJob(jobId);
  if (!job) throw new Error('Conversación no encontrada');
  const b = businessFor(job);
  if (text) say(job.id, 'cliente', text);
  if (action) return handleAction(job, b, action);

  const step = currentStep(job, b);
  if (step === 'comment') {
    updateJob(job.id, { awaitingComment: false });
    if (!isGibberish(text) && norm(text).length > 2 && !intents(text).includes('deny')) addRating({ ...(job.lastRating || {}), comment: text.slice(0, 300) });
    return say(job.id, 'agente', `¡Gracias! Se lo hago llegar a ${b.owner}. 🙌`);
  }

  const data = await extract(job, b, text || '', step);

  if (data.intents.includes('bot')) {
    return nextStep(job, b, `Soy ${b.agentName}, el asistente virtual de ${b.name}. Si prefieres, te comunico con ${b.owner}.`,
      { extraButtons: [humanButton(b)] });
  }
  if (data.intents.includes('cancel') && step !== 'done') return restart(job, b, 'Listo, lo dejamos aquí. Si cambias de opinión, dime qué necesitas.');
  if (data.intents.includes('human')) return handoff(job, b);

  // Guardar lo nuevo y lo corregido.
  const patch = {};
  const acks = [];
  if (data.name) { patch.name = data.name; }
  if (data.itemId) { patch.itemId = data.itemId; if (job.itemId) acks.push('Cambié el servicio.'); }
  if (data.quantity != null && b.steps.quantity) {
    if (data.quantity >= 1 && data.quantity <= MAX_QTY) {
      if (job.quantity && job.quantity !== data.quantity) acks.push(`Cambié la cantidad a ${data.quantity}.`);
      patch.quantity = data.quantity;
    } else if (step === 'quantity' || data.itemId) {
      if (Object.keys(patch).length) job = updateJob(job.id, patch);
      return say(job.id, 'agente',
        data.quantity < 1 ? 'Tiene que ser al menos 1. ¿Cuántos quieres?' : `Por chat tomo hasta ${MAX_QTY}. Para más, ${b.owner} te da precio especial.`,
        { buttons: data.quantity < 1 ? qtyButtons() : [humanButton(b)] });
    }
  }
  if (data.description) patch.description = data.description.slice(0, 300);
  if (data.slotIndex != null) {
    if (job.slot) acks.push(`Cambié el horario a ${job.slots[data.slotIndex]}.`);
    patch.slot = job.slots[data.slotIndex];
  }
  if (data.address) {
    if (data.address.missing.length === 0) {
      const formatted = formatAddress(data.address);
      if (job.address) acks.push('Cambié la dirección.');
      else if (step !== 'address') acks.push('Anoté tu dirección.');
      patch.address = formatted;
      patch.addressDraft = null;
    } else if (step === 'address' || Object.keys(data.address).length > 1) {
      patch.addressDraft = data.address;
    }
  }
  if (data.phone) {
    if (job.phone && job.phone !== data.phone) acks.push(`Cambié tu celular a ${fmtPhone(data.phone)}.`);
    else if (!job.phone && step !== 'phone') acks.push('Anoté tu celular.');
    patch.phone = data.phone;
    patch.phoneSkipped = false;
  }
  if (data.phoneSkipped) patch.phoneSkipped = true;

  const progressed = ['itemId', 'quantity', 'description', 'slot', 'address', 'phone', 'phoneSkipped'].some(k => k in patch);
  if (progressed) {
    // Si ya había cotización y cambió algo, se vuelve a cotizar.
    if (job.quote && job.status === 'cotizando') patch.quote = null;
    patch.confusions = 0;
    job = updateJob(job.id, patch);
    notifyJob(job.id);
    const info = data.intents.find(i => INFO_INTENTS.includes(i));
    return nextStep(job, b, [...acks, info ? infoAnswer(b, info) : ''].filter(Boolean).join(' '));
  }
  if (patch.name) job = updateJob(job.id, patch);
  if (patch.addressDraft) {
    job = updateJob(job.id, { addressDraft: patch.addressDraft });
    return askAddress(job, b, patch.addressDraft);
  }

  // Sin datos nuevos: responder según la intención y el paso.
  const info = data.intents.find(i => INFO_INTENTS.includes(i));
  if (info) return nextStep(job, b, infoAnswer(b, info));
  if (data.llmReply) return nextStep(job, b, data.llmReply);
  if (data.phoneError && (step === 'phone' || looksLikePhone(text))) return phoneProblem(job, b, data.phoneError);

  if (step === 'pay') {
    if (data.affirm) return pay(job, job.phone ? 'push' : 'qr');
    if (data.deny) {
      return say(job.id, 'agente', 'Sin problema. ¿Cambiamos algo o prefieres hablar con alguien?',
        { buttons: [{ label: 'Cambiar algo', action: 'change' }, humanButton(b)] });
    }
  }
  if (step === 'done') return statusReply(job, b, data);
  if (data.name && !data.gibberish) return nextStep(job, b, `Mucho gusto, ${data.name}.`);
  if (data.intents.includes('greeting') && !data.gibberish) return nextStep(job, b, `¡Hola${hi(job)}! 👋`);
  if (data.intents.includes('thanks')) return nextStep(job, b, '¡Con gusto!');

  // Un detalle extra a media conversación ("el edificio no tiene elevador") se anota para el negocio.
  if (['slot', 'phone', 'pay'].includes(step) && !data.question && !data.correction &&
      norm(text).split(' ').length >= 5 && isUsefulDetail(text)) {
    const note = text.trim().slice(0, 200);
    job = updateJob(job.id, { description: job.description ? `${job.description} · ${note}` : note });
    notifyJob(job.id);
    return nextStep(job, b, `Anotado, se lo paso a ${b.owner}.`);
  }

  if (step === 'slot') {
    const day = WEEKDAYS.find(d => new RegExp(`\\b${d}\\b`).test(norm(text)));
    if (day && !(job.slots || []).some(s => norm(s).startsWith(day))) {
      const nice = day.replace('miercoles', 'miércoles').replace('sabado', 'sábado');
      return say(job.id, 'agente', `El ${nice} ya no hay espacio. Te puedo ofrecer:`, { buttons: [...slotButtons(job), humanButton(b)] });
    }
  }
  if (data.correction && ['pay', 'phone', 'address'].includes(step)) {
    return say(job.id, 'agente', '¿Qué quieres cambiar? Escríbelo así: «mejor el martes», «cambia mi número a…» o «la dirección es…».',
      { buttons: [{ label: 'Empezar de nuevo', action: 'change' }] });
  }
  return misunderstood(job, b, step, data, text || '');
}

function handleAction(job, b, action) {
  if (action.startsWith('rate:')) return rate(job, b, Number(action.slice(5)));
  if (action === 'no_comment') {
    updateJob(job.id, { awaitingComment: false });
    return say(job.id, 'agente', `¡Gracias por calificar a ${b.owner}! 🙌`);
  }
  if (action === 'pay_push' || action === 'pay_qr') return pay(job, action === 'pay_push' ? 'push' : 'qr');
  if (action === 'change') return restart(job, b, 'Va, empecemos de nuevo. ¿Qué necesitas?');
  if (action === 'human') return handoff(job, b);
  if (action === 'prices') return nextStep(job, b, infoAnswer(b, 'prices'));
  if (job.quote && job.status !== 'cotizando') return statusReply(job, b, {});
  const patch = { confusions: 0 };
  if (action.startsWith('item:') && itemById(b, action.slice(5))) patch.itemId = action.slice(5);
  if (action.startsWith('qty:')) {
    const q = Number(action.slice(4));
    if (q >= 1 && q <= MAX_QTY) patch.quantity = q;
  }
  if (action.startsWith('slot:')) {
    const s = job.slots?.[Number(action.slice(5))];
    if (s) patch.slot = s;
  }
  if (job.quote && Object.keys(patch).length > 1) patch.quote = null;
  job = updateJob(job.id, patch);
  notifyJob(job.id);
  return nextStep(job, b);
}

function rate(job, b, stars) {
  if (!(stars >= 1 && stars <= 5)) return say(job.id, 'agente', 'Elige de 1 a 5 estrellas.', { buttons: rateButtons() });
  const r = addRating({ businessId: b.id, jobId: job.id, itemId: job.itemId, stars });
  updateJob(job.id, { awaitingComment: true, lastRating: r });
  notifyJob(job.id);
  return say(job.id, 'agente', `${'⭐'.repeat(stars)} ¡Gracias! ¿Quieres dejarle un comentario a ${b.owner}? Escríbelo aquí.`,
    { buttons: [{ label: 'No, gracias', action: 'no_comment' }] });
}

export function rateButtons() {
  return STARS.map(n => ({ label: `${'⭐'.repeat(n)}  ${STAR_LABEL[n]}`, action: `rate:${n}` }));
}

function restart(job, b, text) {
  job = updateJob(job.id, {
    itemId: null, quantity: null, description: null, slot: null, slots: null, quote: null, address: null,
    addressDraft: null, phoneSkipped: false, status: 'cotizando', confusions: 0,
  });
  notifyJob(job.id);
  return say(job.id, 'agente', text, { buttons: itemButtons(b) });
}

function handoff(job, b) {
  job = updateJob(job.id, { needsHuman: true, handoffAt: Date.now() });
  notifyJob(job.id);
  const keepGoing = currentStep(job, b) === 'done' ? '' : ' Mientras, sigo ayudándote aquí.';
  return say(job.id, 'agente', `Listo, ya le avisé a ${b.owner}. Te escribe aquí mismo (${b.hours}).${keepGoing}`);
}

function phoneProblem(job, b, err) {
  const msg = {
    none: 'Necesito tu celular de 10 dígitos (el de la app de tu banco). Si prefieres, escribe «QR».',
    length: `Ese número tiene ${err.digits} dígito${err.digits === 1 ? '' : 's'}. Un celular tiene 10, por ejemplo 55 1234 5678.`,
    prefix: 'Los celulares en México no empiezan con 0 ni con 1. ¿Me lo revisas?',
    repeated: 'Ese número no parece real. ¿Me pasas tu celular de 10 dígitos?',
    sequence: 'Ese número no parece real. ¿Me pasas tu celular de 10 dígitos?',
  }[err.reason];
  return say(job.id, 'agente', msg, { buttons: (job.confusions || 0) >= 1 ? [humanButton(b)] : [] });
}

function askAddress(job, b, draft) {
  const need = draft?.missing || ['street', 'number', 'colonia'];
  const got = draft?.street ? `Tengo «${formatAddress({ ...draft, number: draft.number || '' }).replace(/ S\/N$/, '')}». ` : '';
  let ask;
  if (need.includes('street')) ask = '¿En qué calle?';
  else if (need.includes('number')) ask = '¿Qué número es? Si no tiene, escribe «sin número».';
  else ask = '¿En qué colonia? (o código postal)';
  return say(job.id, 'agente', got + ask);
}

/** No entendió: explica qué necesita y cómo responder. Después de 2 intentos ofrece hablar con el negocio. */
function misunderstood(job, b, step, data, text) {
  const confusions = (job.confusions || 0) + 1;
  job = updateJob(job.id, { confusions });
  const extra = confusions >= 2 ? [humanButton(b)] : [];
  const sorry = data.gibberish ? 'No te entendí. ' : '';

  if (step === 'item') {
    const msg = data.gibberish || norm(text).length < 3
      ? `${sorry}¿Qué necesitas? Toca una opción o escríbelo con tus palabras.`
      : `No encontré ${short(text)} en ${b.name}. Esto es lo que hay:`;
    return say(job.id, 'agente', msg, { buttons: [...itemButtons(b), ...extra] });
  }
  if (step === 'quantity') return say(job.id, 'agente', `${sorry}¿Cuántos quieres? Escribe un número o toca una opción.`, { buttons: [...qtyButtons(), ...extra] });
  if (step === 'details') {
    const ex = b.detailsExample ? ` Por ejemplo: «${b.detailsExample}».` : '';
    const why = data.question ? 'Primero necesito un dato: ' : `${sorry}Necesito un poco más de detalle para darte el precio correcto. `;
    return say(job.id, 'agente', `${why}${b.detailsPrompt || 'Cuéntame más.'}${ex}`, { buttons: extra });
  }
  if (step === 'slot') return say(job.id, 'agente', `${sorry}¿Qué horario prefieres? Toca una opción.`, { buttons: [...slotButtons(job), ...extra] });
  if (step === 'address') {
    if (data.gibberish) return say(job.id, 'agente', 'No te entendí. Escribe calle, número y colonia, por ejemplo: «Morelos 45, col. Centro».', { buttons: extra });
    return askAddress(job, b, job.addressDraft);
  }
  if (step === 'phone') return phoneProblem(job, b, data.phoneError || { reason: 'none' });
  if (step === 'pay') return say(job.id, 'agente', `${sorry}¿Cómo prefieres pagar?`, { buttons: payButtons(job) });
  return statusReply(job, b, data);
}

function statusReply(job, b, data) {
  const label = scheduleLabel(b) === 'Cita' ? 'cita' : 'pedido';
  const { pending } = jobTotals(job);
  if (data.intents?.includes('thanks')) return say(job.id, 'agente', `¡A ti${hi(job)}! Aquí estamos.`);
  if (job.status.startsWith('esperando')) {
    const amount = job.status === 'esperando_restante' ? pending : job.quote.deposit;
    return say(job.id, 'agente', `Espero tu pago de ${money(amount)}. Si ya lo aprobaste, te confirmo en segundos. ¿Te lo mando otra vez?`,
      { buttons: payButtons(job, false) });
  }
  if (job.status === 'confirmada') {
    return say(job.id, 'agente',
      `Tu ${label} está confirmad${label === 'cita' ? 'a' : 'o'}${job.slot ? ` para el ${job.slot}` : ''}.` +
      (pending > 0 ? ` Quedan ${money(pending)} al terminar.` : ''), { buttons: [humanButton(b)] });
  }
  return say(job.id, 'agente', '¡Todo pagado! Gracias por tu confianza.',
    { buttons: [humanButton(b), { label: 'Pedir otra vez', action: 'change' }] });
}

function payButtons(job, withChange = true) {
  const out = [];
  if (job.phone) out.push({ label: 'Mándame el cobro a mi banco', action: 'pay_push' });
  out.push({ label: job.phone ? 'Mejor con QR' : 'Pagar con QR', action: 'pay_qr' });
  if (withChange) out.push({ label: 'Cambiar algo', action: 'change' });
  return out;
}

/** Pregunta lo que falta o arma la cotización. prefix: respuesta previa (precios, acuses, etc.). */
function nextStep(job, b, prefix = '', { extraButtons = [] } = {}) {
  const step = currentStep(job, b);
  const lead = prefix ? `${prefix}\n\n` : '';
  if (step === 'done' || step === 'comment') return say(job.id, 'agente', prefix || '¿Te ayudo con algo más?', { buttons: extraButtons });
  if (step === 'pay') {
    return say(job.id, 'agente', `${lead}¿Cómo prefieres pagar${firstChargeKind(job) === 'anticipo' ? ' el anticipo' : ''}?`,
      { buttons: [...payButtons(job), ...extraButtons] });
  }
  if (step === 'item') return say(job.id, 'agente', `${lead}¿Qué necesitas?`, { buttons: [...itemButtons(b), ...extraButtons] });
  const item = itemById(b, job.itemId);
  if (step === 'quantity') return say(job.id, 'agente', `${lead}${item.name}, ${money(item.price)} c/u. ¿Cuántos?`, { buttons: [...qtyButtons(), ...extraButtons] });
  if (step === 'details') return say(job.id, 'agente', `${lead}${item.name}, entendido. ${b.detailsPrompt || 'Cuéntame un poco más.'}`, { buttons: extraButtons });
  if (step === 'slot') {
    const first = !job.slots;
    const slots = job.slots || availableSlots(b);
    job = updateJob(job.id, { slots });
    const question = b.scheduleQuestion || (b.steps.schedule === 'entrega' ? '¿Cuándo te lo entregamos?' : '¿Qué horario te queda?');
    const intro = first ? `Perfecto${hi(job)}. ${question}` : 'Elige un horario:';
    return say(job.id, 'agente', `${lead}${intro}`, { buttons: [...slotButtons(job), ...extraButtons] });
  }
  if (step === 'address') {
    if (job.addressDraft?.street) return askAddress(job, b, job.addressDraft);
    const q = b.steps.schedule === 'entrega' ? '¿A dónde lo llevamos?' : '¿A qué dirección vamos?';
    return say(job.id, 'agente', `${lead}${q} Calle, número y colonia.`, { buttons: extraButtons });
  }
  if (step === 'phone') {
    return say(job.id, 'agente', `${lead}¿A qué celular te mando el cobro? Son 10 dígitos. O escribe «QR».`, { buttons: extraButtons });
  }

  // Cotización.
  const q = buildQuote(b, item, job.quantity || 1);
  job = updateJob(job.id, { quote: q });
  notifyJob(job.id);
  const line = q.items[0];
  const label = scheduleLabel(b);
  const demo = config.demoChargeAmount != null ? ` (prueba: ${money(config.demoChargeAmount)})` : '';
  const pago = firstChargeKind(job) === 'anticipo'
    ? `Para apartar: ${money(q.deposit)}${demo}. El resto al terminar.`
    : `A pagar: ${money(q.total)}${demo}.`;
  return say(job.id, 'agente',
    `${lead}Tu cotización${hi(job)}:\n• ${line.quantity > 1 ? `${line.quantity} × ` : ''}${line.concept}: ${money(line.amount)}` +
    (label ? `\n• ${label}: ${job.slot}` : '') + (job.address ? `\n• 📍 ${job.address}` : '') + `\n\n${pago}`,
    {
      buttons: payButtons(job),
      kind: 'quote',
      quote: {
        lines: q.items, total: q.total, deposit: q.deposit, chargeKind: firstChargeKind(job), depositPercent: b.depositPercent,
        slot: job.slot, slotLabel: label, address: job.address, phone: job.phone ? fmtPhone(job.phone) : null,
        demoAmount: config.demoChargeAmount,
      },
    });
}

async function pay(job, method) {
  const b = businessFor(job);
  if (!job.quote) return nextStep(job, b);
  if (method === 'push' && !job.phone) {
    updateJob(job.id, { phoneSkipped: false });
    return say(job.id, 'agente', 'Para mandarte el cobro necesito tu celular de 10 dígitos. ¿Cuál es?');
  }
  try {
    const kind = job.status === 'confirmada' || job.status === 'esperando_restante' ? 'restante' : firstChargeKind(job);
    const charge = await chargeJob(job, kind, method);
    if (method === 'push') {
      return say(job.id, 'agente', `Te mandé el cobro al ${fmtPhone(job.phone)}. Ábrelo en la app de tu banco y apruébalo.`,
        { kind: 'charge', chargeId: charge.id, method, amount: charge.quotedAmount, simulated: charge.simulated });
    }
    return say(job.id, 'agente', 'Escanea este QR desde la app de tu banco:',
      { kind: 'charge', chargeId: charge.id, method, amount: charge.quotedAmount, qrDataUrl: charge.qrDataUrl, simulated: charge.simulated });
  } catch (err) {
    console.error('[pay]', err.message);
    const friendly = /celular/i.test(err.message) ? err.message : 'No pude generar el cobro en este momento.';
    return say(job.id, 'agente', `${friendly} ¿Lo intentamos otra vez?`, { buttons: payButtons(job) });
  }
}
