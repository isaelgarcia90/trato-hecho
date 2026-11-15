import { config } from './config.js';
import { availableSlots, buildQuote, business, findService, serviceById, services } from './catalog.js';
import { chargeJob, money, notifyJob, say } from './payments.js';
import { getJob, updateJob } from './store.js';

// El agente decide QUÉ preguntar; los precios y los cobros los decide el servidor.
// Con LLM_API_KEY usa un LLM para entender texto libre; sin ella, usa reglas simples.

const serviceButtons = () => services.map(s => ({ label: `${s.name} · ${money(s.price)}`, action: `service:${s.id}` }));

export function greet(job) {
  say(job.id, 'agente',
    `Hola, soy el asistente de ${business.name}. Te ayudo a cotizar y agendar. ¿Qué problema tienes en casa?`,
    { buttons: serviceButtons() });
}

function extractByRules(job, text) {
  const out = {};
  const t = text.trim();
  const phone = t.replace(/[\s\-().+]/g, '').match(/(?:52)?(\d{10})$/);
  if (phone) out.phone = phone[1];
  if (!job.serviceId) {
    const s = findService(t);
    if (s) out.serviceId = s.id;
  }
  if (job.serviceId && !job.description && t.length > 3 && !phone) out.description = t;
  if (job.slots && !job.slot) {
    const n = t.match(/^\s*([123])\b/);
    if (n) out.slotIndex = Number(n[1]) - 1;
  }
  if (/^(s[ií]|va|ok|dale|confirmo|de acuerdo|claro)\b/i.test(t)) out.confirm = true;
  return out;
}

async function extractByLlm(job, text) {
  const system = [
    `Eres el asistente por chat de "${business.name}" (${business.oficio}, ${business.zone}).`,
    'Extrae datos del mensaje del cliente y responde en español de México, breve y amable.',
    'NUNCA inventes precios, descuentos ni horarios; el sistema los da.',
    `Servicios válidos (id: nombre): ${services.map(s => `${s.id}: ${s.name}`).join('; ')}.`,
    `Horarios ofrecidos: ${(job.slots || []).map((s, i) => `${i + 1}) ${s}`).join(' ') || 'aún no ofrecidos'}.`,
    `Datos ya conocidos: ${JSON.stringify({ serviceId: job.serviceId, description: job.description, slot: job.slot, phone: job.phone })}.`,
    'Devuelve SOLO JSON: {"serviceId": string|null, "description": string|null, "slotIndex": 0|1|2|null,',
    '"phone": "10 dígitos"|null, "name": string|null, "confirm": true|null, "reply": string}.',
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
  if (parsed.serviceId && !serviceById(parsed.serviceId)) delete parsed.serviceId;
  if (parsed.phone) parsed.phone = String(parsed.phone).replace(/\D/g, '').slice(-10);
  return parsed;
}

async function extract(job, text) {
  const rules = extractByRules(job, text);
  if (!config.llmApiKey) return rules;
  try {
    const llm = await extractByLlm(job, text);
    // Las reglas ganan en datos exactos (celular, número de horario).
    return { ...llm, ...Object.fromEntries(Object.entries(rules).filter(([, v]) => v != null)) };
  } catch (err) {
    console.warn('[agent] LLM falló, uso reglas:', err.message);
    return rules;
  }
}

function applyAction(job, action) {
  if (action.startsWith('service:')) return { serviceId: action.slice(8) };
  if (action.startsWith('slot:')) return { slotIndex: Number(action.slice(5)) };
  return {};
}

export async function handleClientMessage(jobId, { text, action }) {
  let job = getJob(jobId);
  if (!job) throw new Error('Conversación no encontrada');
  if (text) say(job.id, 'cliente', text);

  // Pagos y cambios explícitos (botones).
  if (action === 'pay_push' || action === 'pay_qr') return pay(job, action === 'pay_push' ? 'push' : 'qr');
  if (action === 'change') {
    updateJob(job.id, { serviceId: null, description: null, slot: null, quote: null, step: 'inicio', status: 'cotizando' });
    notifyJob(job.id);
    return say(job.id, 'agente', 'Sin problema, empecemos de nuevo. ¿Qué servicio necesitas?', { buttons: serviceButtons() });
  }

  const data = action ? applyAction(job, action) : await extract(job, text || '');
  const patch = {};
  if (data.serviceId && !job.quote) {
    patch.serviceId = data.serviceId;
    // Si el primer mensaje ya describe el problema, lo usamos como descripción.
    if (!job.description && text && text.length > 12) patch.description = text;
  }
  if (data.description && !job.description && (job.serviceId || patch.serviceId)) patch.description = data.description;
  if (data.slotIndex != null && job.slots?.[data.slotIndex]) patch.slot = job.slots[data.slotIndex];
  if (data.phone && /^\d{10}$/.test(data.phone)) patch.phone = data.phone;
  if (data.name) patch.name = data.name;
  job = updateJob(job.id, patch);
  notifyJob(job.id);

  // Ya cotizado: confirmar = mandar cobro al celular.
  if (job.quote && job.status === 'cotizando') {
    if (data.confirm) return pay(job, 'push');
    if (data.reply) return say(job.id, 'agente', data.reply, { buttons: payButtons() });
    return say(job.id, 'agente', '¿Cómo prefieres pagar el anticipo?', { buttons: payButtons() });
  }
  if (job.status !== 'cotizando') {
    return say(job.id, 'agente', data.reply ||
      'Tu cita ya está en proceso. Si necesitas algo más, escríbenos y Don Beto te contacta.');
  }

  return nextStep(job, data.reply);
}

function payButtons() {
  return [
    { label: 'Mándame el cobro a mi app del banco', action: 'pay_push' },
    { label: 'Prefiero pagar con QR', action: 'pay_qr' },
    { label: 'Cambiar algo', action: 'change' },
  ];
}

function nextStep(job, llmReply) {
  if (!job.serviceId) {
    return say(job.id, 'agente', llmReply || 'Para cotizarte, elige el servicio que más se parece:', { buttons: serviceButtons() });
  }
  const service = serviceById(job.serviceId);
  if (!job.description) {
    return say(job.id, 'agente', `${service.name}, entendido. Cuéntame un poco más: ¿dónde es y desde cuándo pasa?`);
  }
  if (!job.slot) {
    const first = !job.slots;
    const slots = job.slots || availableSlots();
    updateJob(job.id, { slots });
    const intro = first
      ? `Entendido: ${service.name.toLowerCase()} (${money(service.price)}). ¿Qué horario te acomoda?`
      : 'Elige uno de estos horarios, por favor:';
    return say(job.id, 'agente', intro, {
      buttons: slots.map((s, i) => ({ label: s, action: `slot:${i}` })),
    });
  }
  if (!job.phone) {
    return say(job.id, 'agente',
      '¿A qué número de celular te mandamos el cobro del anticipo? (10 dígitos, el que tienes ligado a tu banco)');
  }

  const quote = buildQuote(service);
  updateJob(job.id, { quote });
  notifyJob(job.id);
  const demo = config.demoChargeAmount != null ? ` (demo: se cobrará ${money(config.demoChargeAmount)})` : '';
  return say(job.id, 'agente',
    `Tu cotización:\n• ${service.name}: ${money(quote.total)}\n• Cita: ${job.slot}\n\n` +
    `Para apartar la cita pedimos un anticipo del ${business.depositPercent}%: ${money(quote.deposit)}${demo}. ` +
    'Se paga con CoDi, sin comisión. El resto se paga al terminar el trabajo.',
    { buttons: payButtons(), kind: 'quote' });
}

async function pay(job, method) {
  if (!job.quote) return nextStep(job);
  try {
    const charge = await chargeJob(job, 'anticipo', method);
    if (method === 'push') {
      return say(job.id, 'agente',
        `Listo, te mandé un cobro CoDi por ${money(charge.quotedAmount)} al celular ${job.phone}. ` +
        'Ábrelo en la app de tu banco y apruébalo; aquí te confirmo en cuanto llegue.',
        { kind: 'charge', chargeId: charge.id, simulated: charge.simulated });
    }
    return say(job.id, 'agente',
      `Escanea este QR desde la app de tu banco para pagar ${money(charge.quotedAmount)}:`,
      { kind: 'charge', chargeId: charge.id, qrDataUrl: charge.qrDataUrl, simulated: charge.simulated });
  } catch (err) {
    console.error('[pay]', err.message);
    return say(job.id, 'agente', `No pude generar el cobro: ${err.message}. ¿Intentamos con el otro método?`,
      { buttons: payButtons() });
  }
}
