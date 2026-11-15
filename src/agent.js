import { config } from './config.js';
import { availableSlots, buildQuote, findItem, itemById, scheduleLabel } from './catalog.js';
import { businessFor, chargeJob, firstChargeKind, money, notifyJob, say } from './payments.js';
import { getJob, updateJob } from './store.js';

// El agente decide QUÉ preguntar según los pasos que configuró el negocio
// (detalles, cantidad, cita o entrega). Los precios y los cobros los decide el servidor.
// Con LLM_API_KEY usa un LLM para entender texto libre; sin ella, usa reglas simples.

const itemButtons = b => b.items.map(it => ({ label: `${it.name} · ${money(it.price)}`, action: `item:${it.id}` }));
const QTY_OPTIONS = [1, 2, 3, 6, 12];

export function greet(job) {
  const b = businessFor(job);
  say(job.id, 'agente', `Hola, soy ${b.agentName}, el asistente de ${b.name}. ${b.greeting}`,
    { buttons: itemButtons(b) });
}

function extractByRules(job, b, text) {
  const out = {};
  const t = text.trim();
  const phone = t.replace(/[\s\-().+]/g, '').match(/(?:52)?(\d{10})$/);
  if (phone) out.phone = phone[1];
  if (!job.itemId) {
    const it = findItem(b, t);
    if (it) out.itemId = it.id;
  }
  if (b.steps.quantity && !job.quantity && !phone) {
    const q = t.match(/\b(\d{1,3})\b/);
    if (q && Number(q[1]) > 0) out.quantity = Number(q[1]);
  }
  const itemKnown = job.itemId || out.itemId;
  const qtyDone = !b.steps.quantity || job.quantity || out.quantity;
  if (b.steps.details && job.itemId && !job.description && t.length > 3 && !phone) out.description = t;
  if (job.slots && !job.slot && itemKnown && qtyDone) {
    const n = t.match(/^\s*([123])\b/);
    if (n) out.slotIndex = Number(n[1]) - 1;
  }
  if (/^(s[ií]|va|ok|dale|confirmo|de acuerdo|claro|trato hecho)\b/i.test(t)) out.confirm = true;
  return out;
}

async function extractByLlm(job, b, text) {
  const system = [
    `Eres ${b.agentName}, el asistente por chat de "${b.name}" (${b.giro}, ${b.zone}).`,
    'Extrae datos del mensaje del cliente y responde en español de México, breve y amable.',
    'NUNCA inventes precios, descuentos ni horarios; el sistema los da.',
    `Productos o servicios válidos (id: nombre): ${b.items.map(it => `${it.id}: ${it.name}`).join('; ')}.`,
    `Horarios ofrecidos: ${(job.slots || []).map((s, i) => `${i + 1}) ${s}`).join(' ') || 'aún no ofrecidos'}.`,
    `Datos ya conocidos: ${JSON.stringify({ itemId: job.itemId, quantity: job.quantity, description: job.description, slot: job.slot, phone: job.phone })}.`,
    'Devuelve SOLO JSON: {"itemId": string|null, "quantity": number|null, "description": string|null,',
    '"slotIndex": 0|1|2|null, "phone": "10 dígitos"|null, "name": string|null, "confirm": true|null, "reply": string}.',
    '"reply" solo se usa si el cliente pregunta algo que no es un dato (máx. 2 oraciones).',
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
  const parsed = JSON.parse(raw.replace(/^```json|```$/g, '').trim());
  if (parsed.itemId && !itemById(b, parsed.itemId)) delete parsed.itemId;
  if (parsed.phone) parsed.phone = String(parsed.phone).replace(/\D/g, '').slice(-10);
  if (parsed.quantity != null && !(Number(parsed.quantity) > 0 && Number(parsed.quantity) < 1000)) delete parsed.quantity;
  return parsed;
}

async function extract(job, b, text) {
  const rules = extractByRules(job, b, text);
  if (!config.llmApiKey) return rules;
  try {
    const llm = await extractByLlm(job, b, text);
    // Las reglas ganan en datos exactos (celular, cantidad, número de horario).
    return { ...llm, ...Object.fromEntries(Object.entries(rules).filter(([, v]) => v != null)) };
  } catch (err) {
    console.warn('[agent] LLM falló, uso reglas:', err.message);
    return rules;
  }
}

function applyAction(action) {
  if (action.startsWith('item:')) return { itemId: action.slice(5) };
  if (action.startsWith('qty:')) return { quantity: Number(action.slice(4)) };
  if (action.startsWith('slot:')) return { slotIndex: Number(action.slice(5)) };
  return {};
}

export async function handleClientMessage(jobId, { text, action }) {
  let job = getJob(jobId);
  if (!job) throw new Error('Conversación no encontrada');
  const b = businessFor(job);
  if (text) say(job.id, 'cliente', text);

  // Pagos y cambios explícitos (botones).
  if (action === 'pay_push' || action === 'pay_qr') return pay(job, action === 'pay_push' ? 'push' : 'qr');
  if (action === 'change') {
    updateJob(job.id, { itemId: null, quantity: null, description: null, slot: null, quote: null, status: 'cotizando' });
    notifyJob(job.id);
    return say(job.id, 'agente', 'Sin problema, empecemos de nuevo. ¿Qué necesitas?', { buttons: itemButtons(b) });
  }

  const data = action ? applyAction(action) : await extract(job, b, text || '');
  const patch = {};
  if (data.itemId && !job.quote && itemById(b, data.itemId)) {
    patch.itemId = data.itemId;
    // Si el primer mensaje ya describe el problema, lo usamos como descripción.
    // (Solo con texto libre: con un botón, el texto es la etiqueta del botón.)
    if (b.steps.details && !action && !job.description && text && text.length > 12) patch.description = text;
  }
  if (b.steps.quantity && !job.quote && data.quantity > 0 && data.quantity < 1000) patch.quantity = Math.floor(data.quantity);
  if (b.steps.details && data.description && !job.description && (job.itemId || patch.itemId)) patch.description = data.description;
  if (data.slotIndex != null && job.slots?.[data.slotIndex]) patch.slot = job.slots[data.slotIndex];
  if (data.phone && /^\d{10}$/.test(data.phone)) patch.phone = data.phone;
  if (data.name) patch.name = data.name;
  job = updateJob(job.id, patch);
  notifyJob(job.id);

  // Ya cotizado: confirmar = mandar cobro al celular.
  if (job.quote && job.status === 'cotizando') {
    if (data.confirm) return pay(job, 'push');
    if (data.reply) return say(job.id, 'agente', data.reply, { buttons: payButtons() });
    return say(job.id, 'agente', `¿Cómo prefieres pagar${firstChargeKind(job) === 'anticipo' ? ' el anticipo' : ''}?`,
      { buttons: payButtons() });
  }
  if (job.status !== 'cotizando') {
    return say(job.id, 'agente', data.reply ||
      `Tu ${scheduleLabel(b) === 'Cita' ? 'cita' : 'pedido'} ya está en proceso. Si necesitas algo más, escríbenos y ${b.owner} te contacta.`);
  }

  return nextStep(job, b, data.reply);
}

function payButtons() {
  return [
    { label: 'Mándame el cobro a mi app del banco', action: 'pay_push' },
    { label: 'Prefiero pagar con QR', action: 'pay_qr' },
    { label: 'Cambiar algo', action: 'change' },
  ];
}

function nextStep(job, b, llmReply) {
  if (!job.itemId) {
    return say(job.id, 'agente', llmReply || 'Elige lo que más se parece a lo que necesitas:', { buttons: itemButtons(b) });
  }
  const item = itemById(b, job.itemId);
  if (b.steps.quantity && !job.quantity) {
    return say(job.id, 'agente', `${item.name} (${money(item.price)} c/u). ¿Cuántos quieres?`, {
      buttons: QTY_OPTIONS.map(n => ({ label: String(n), action: `qty:${n}` })),
    });
  }
  if (b.steps.details && !job.description) {
    return say(job.id, 'agente', `${item.name}, entendido. ${b.detailsPrompt || 'Cuéntame un poco más, por favor.'}`);
  }
  if (b.steps.schedule && !job.slot) {
    const first = !job.slots;
    const slots = job.slots || availableSlots(b);
    updateJob(job.id, { slots });
    const question = b.scheduleQuestion ||
      (b.steps.schedule === 'entrega' ? '¿Cuándo te lo entregamos?' : '¿Qué horario te acomoda?');
    const intro = first
      ? `Entendido: ${item.name}${job.quantity > 1 ? ` × ${job.quantity}` : ''}. ${question}`
      : 'Elige uno de estos horarios, por favor:';
    return say(job.id, 'agente', intro, {
      buttons: slots.map((s, i) => ({ label: s, action: `slot:${i}` })),
    });
  }
  if (!job.phone) {
    return say(job.id, 'agente',
      '¿A qué número de celular te mandamos el cobro? (10 dígitos, el que tienes ligado a tu banco)');
  }

  const quote = buildQuote(b, item, job.quantity || 1);
  job = updateJob(job.id, { quote });
  notifyJob(job.id);
  const line = quote.items[0];
  const label = scheduleLabel(b);
  const demo = config.demoChargeAmount != null ? ` (demo: se cobrará ${money(config.demoChargeAmount)})` : '';
  const pago = firstChargeKind(job) === 'anticipo'
    ? `Para apartar ${label === 'Cita' ? 'la cita' : 'tu pedido'} pedimos un anticipo del ${b.depositPercent}%: ` +
      `${money(quote.deposit)}${demo}. El resto se paga al terminar.`
    : `Total a pagar: ${money(quote.total)}${demo}.`;
  return say(job.id, 'agente',
    `Tu cotización:\n• ${line.quantity > 1 ? `${line.quantity} × ` : ''}${line.concept}: ${money(line.amount)}` +
    (label ? `\n• ${label}: ${job.slot}` : '') +
    `\n\n${pago} Se paga con CoDi, sin comisión.`,
    {
      buttons: payButtons(),
      kind: 'quote',
      quote: {
        lines: quote.items, total: quote.total, deposit: quote.deposit, chargeKind: firstChargeKind(job),
        depositPercent: b.depositPercent, slot: job.slot, slotLabel: label, demoAmount: config.demoChargeAmount,
      },
    });
}

async function pay(job, method) {
  const b = businessFor(job);
  if (!job.quote) return nextStep(job, b);
  try {
    const kind = firstChargeKind(job);
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
    return say(job.id, 'agente', `No pude generar el cobro: ${err.message}. ¿Intentamos con el otro método?`,
      { buttons: payButtons() });
  }
}
