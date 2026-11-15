// Comprensión de texto por reglas: normaliza, detecta intenciones, cantidades y texto sin sentido.
// Funciona sin LLM; si hay LLM, solo complementa.

export const norm = s => String(s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const has = (t, words) => words.some(w => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(t));

const INTENTS = [
  ['cancel', ['cancela', 'cancelar', 'cancelalo', 'ya no quiero', 'olvidalo', 'mejor no quiero nada']],
  ['human', ['humano', 'persona real', 'hablar con', 'hablar a', 'llamar', 'llamame', 'marcame', 'asesor', 'encargad[oa]', 'duen[oa]', 'atencion a clientes', 'una persona']],
  ['prices', ['cuanto', 'cuantos cuesta', 'precio', 'precios', 'cuesta', 'cuestan', 'costo', 'costos', 'cobran', 'cobras', 'tarifa', 'lista', 'catalogo', 'que venden', 'que vendes', 'que ofrecen', 'que servicios', 'que tienen', 'menu']],
  ['hours', ['horario', 'horarios', 'a que hora', 'que hora', 'abren', 'cierran', 'abierto', 'que dias']],
  ['location', ['donde', 'ubicacion', 'direccion', 'zona', 'a domicilio', 'vienen', 'llegan hasta', 'cobertura']],
  ['payment', ['como pago', 'como se paga', 'formas de pago', 'codi', 'transferencia', 'efectivo', 'tarjeta', 'es seguro', 'como funciona el pago']],
  ['bot', ['eres un robot', 'eres robot', 'eres humano', 'eres una persona', 'eres real', 'eres ia', 'eres un bot', 'con quien hablo']],
  ['thanks', ['gracias', 'muchas gracias', 'mil gracias', 'te agradezco']],
  ['greeting', ['hola', 'buenas', 'buen dia', 'buenos dias', 'buenas tardes', 'buenas noches', 'que tal', 'hey', 'saludos', 'que onda']],
  ['affirm', ['si', 'sip', 'va', 'ok', 'okay', 'dale', 'de acuerdo', 'claro', 'confirmo', 'perfecto', 'sale', 'simon', 'adelante', 'esta bien', 'trato hecho', 'listo']],
  ['deny', ['no', 'nop', 'nel', 'mejor no', 'todavia no', 'aun no']],
];

/** Intenciones presentes en el texto, en orden de prioridad. */
export function intents(text) {
  const t = norm(text);
  return INTENTS.filter(([, words]) => has(t, words)).map(([name]) => name);
}

/** Pregunta informativa (precios, horario, ubicación, pago). */
export const INFO_INTENTS = ['prices', 'hours', 'location', 'payment'];

const NUMBER_WORDS = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, quince: 15, veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50,
};

/** Cantidad pedida: "10", "diez", "una docena", "media docena", "un par". null si no hay. */
export function parseQuantity(text) {
  const t = norm(text);
  if (/\bmedia docena\b/.test(t)) return 6;
  const doz = t.match(/\b(\d{1,2}|un|una|dos|tres|cuatro)\s+docenas?\b/);
  if (doz) return (Number(doz[1]) || NUMBER_WORDS[doz[1]]) * 12;
  if (/\bdocena\b/.test(t)) return 12;
  if (/\bun par\b/.test(t)) return 2;
  const digits = t.replace(/(\d)[\s-](?=\d)/g, '$1').match(/\b(\d{1,3})\b/);
  if (digits) return Number(digits[1]);
  for (const [w, n] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${w}\\b`).test(t)) return n;
  }
  return null;
}

/** Celular de 10 dígitos dentro del texto (acepta espacios, guiones, paréntesis y +52). */
export function parsePhone(text) {
  const runs = String(text || '').match(/\+?[\d][\d\s\-().]{8,}\d/g) || [];
  for (const run of runs) {
    const m = run.replace(/\D/g, '').match(/^(?:52)?(\d{10})$/);
    if (m) return m[1];
  }
  return null;
}

/** El texto sin el celular (para no confundir sus dígitos con una cantidad). */
export const withoutPhone = text => String(text || '').replace(/\+?[\d][\d\s\-().]{8,}\d/g, ' ');

/** ¿Es una pregunta? */
export function isQuestion(text) {
  const t = norm(text);
  return /\?/.test(text || '') || /^(cuanto|cuantos|cuantas|cuando|donde|como|que|cual|cuales|a que|hay|tienen|aceptan|puedo|se puede)\b/.test(t);
}

/** Cuántos dígitos escribió (para explicar por qué un celular no es válido). */
export const digitCount = text => String(text || '').replace(/[^\d]/g, '').length;

/**
 * Valida un celular mexicano. Devuelve { ok, phone } o { ok: false, reason, digits }.
 * Razones: 'none' (no hay dígitos), 'length', 'prefix' (empieza en 0 o 1), 'repeated', 'sequence'.
 */
export function validatePhone(text) {
  // Si el texto trae varios números ("Morelos 45 … cel 55 1234 5678"), se valida cada bloque largo.
  const runs = (String(text || '').match(/\+?\d[\d\s\-().]*\d|\d/g) || []).map(r => r.replace(/\D/g, '')).filter(r => r.length >= 7);
  if (runs.length > 1 || (runs.length === 1 && runs[0].length !== String(text || '').replace(/\D/g, '').length)) {
    let worst = null;
    for (const r of runs) {
      const v = validateDigits(r);
      if (v.ok) return v;
      worst = worst || v;
    }
    return worst;
  }
  return validateDigits(String(text || '').replace(/\D/g, ''));
}

function validateDigits(digits) {
  let d = digits;
  if (!d) return { ok: false, reason: 'none', digits: 0 };
  if (d.length === 12 && d.startsWith('52')) d = d.slice(2);
  else if (d.length === 13 && d.startsWith('521')) d = d.slice(3);
  else if (d.length === 13 && /^04[45]/.test(d)) d = d.slice(3);
  if (d.length !== 10) return { ok: false, reason: 'length', digits: d.length };
  if (/^[01]/.test(d)) return { ok: false, reason: 'prefix', digits: 10 };
  if (/^(\d)\1{9}$/.test(d)) return { ok: false, reason: 'repeated', digits: 10 };
  if ('01234567890123456789'.includes(d) || '98765432109876543210'.includes(d)) return { ok: false, reason: 'sequence', digits: 10 };
  return { ok: true, phone: d };
}

/** Parece que el mensaje trae un número de teléfono (para validarlo aunque esté mal). */
export const looksLikePhone = text => /(?:\+?\d[\d\s\-().]{5,}\d)/.test(String(text || '')) && digitCount(text) >= 7;

const STREET = /\b(calle|c\.|av\.?|avenida|calzada|calz\.?|cerrada|cda\.?|privada|priv\.?|andador|callejon|boulevard|blvd\.?|eje|circuito|prolongacion|retorno|camino)\b/;
const COLONIA = /\b(col\.?|colonia|fracc\.?|fraccionamiento|barrio|unidad|u\.\s?h\.?|pueblo|residencial|ampliacion)\s+([a-z0-9][a-z0-9 .'-]{2,})/;
const CP = /\b(?:c\.?\s?p\.?\s*)?(\d{5})\b/;
const NUMBER = /(?:#|no\.?|num\.?|numero|n°)\s*(\d{1,5}[a-z]?)|\b(\d{1,5}[a-z]?)\b|\b(s\/n|sin numero)\b|\b(mz\.?|manzana)\s*\d+/;

/** ¿El mensaje parece una dirección? (calle, colonia, CP o "vivo en"). */
export function looksLikeAddress(text) {
  const t = norm(text);
  return STREET.test(t) || COLONIA.test(t) || /\b(vivo en|mi direccion|direccion es|estoy en la calle)\b/.test(t) || /\bc\.?\s?p\.?\s*\d{5}\b/.test(t);
}

/**
 * Interpreta una dirección y dice qué le falta. Acepta piezas sueltas en varios mensajes:
 * prev = dirección parcial anterior. Devuelve { street, number, colonia, cp, missing: [] }.
 */
export function parseAddress(text, prev = {}) {
  const raw = String(text || '').trim();
  const t = norm(raw).replace(/^(vivo en|mi direccion es|la direccion es|es en|en)\s+/, '');
  const out = { ...prev };
  const cp = t.match(CP);
  if (cp && !looksLikePhone(raw)) out.cp = cp[1];
  const col = t.match(COLONIA);
  if (col) out.colonia = col[2].replace(/\s*,.*$/, '').replace(/\s+(cp|c\.p\.).*$/, '').trim();
  const body = t.replace(CP, ' ').replace(COLONIA, ' ').replace(/\b(int\.?|interior|depto\.?|departamento|dpto\.?)\s*\w+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const mz = body.match(/\b(?:mz\.?|manzana)\s*(\w+)\s*(?:lt\.?|lote)\s*(\w+)/);
  if (mz) {
    out.number = out.number || `Mz ${mz[1]} Lt ${mz[2]}`;
    if (!out.street) out.street = body.slice(0, mz.index).replace(/[,\s]+$/, '').trim() || 'Sin calle';
  } else {
    const sn = body.match(/\b(s\/n|sin numero)\b/);
    const num = sn ? null : body.match(/(?:#|\bno\.?|\bnum\.?|\bnumero)?\s*\b(\d{1,5}[a-z]?)\b/);
    const cut = sn ? sn.index : num ? num.index : -1;
    if (sn) out.number = 'S/N';
    else if (num) out.number = num[1];
    const before = (cut >= 0 ? body.slice(0, cut) : body).replace(/[,#\s]+$/, '').replace(/^(la|el)\s+/, '').trim();
    const after = cut >= 0 ? body.slice(cut + (sn ? sn[0] : num[0]).length).replace(/^[,\s]+/, '').trim() : '';
    if (!out.street && before && /[a-z]{3,}/.test(before) && !isGibberish(before) && before.split(' ').length <= 6) out.street = before;
    // "Universidad 1200 Narvarte": lo que sigue al número suele ser la colonia.
    if (!out.colonia && after && /^[a-z .'-]{4,40}$/.test(after) && !isGibberish(after)) out.colonia = after;
  }
  // Una respuesta suelta como "Narvarte" cuando ya hay calle y número es la colonia.
  if (!col && prev.street && prev.number && !out.colonia && !cp && /^[a-z .'-]{4,40}$/.test(t) && !isGibberish(t)) out.colonia = t;
  out.missing = [];
  if (!out.street) out.missing.push('street');
  if (!out.number) out.missing.push('number');
  if (!out.colonia && !out.cp) out.missing.push('colonia');
  return out;
}

const title = s => s.replace(/\b([a-zñ])/g, c => c.toUpperCase());

export function formatAddress(a) {
  const street = a.street === 'Sin calle' ? '' : title(a.street || '');
  const parts = [`${street} ${a.number || 'S/N'}`.trim()];
  if (a.colonia) parts.push(`Col. ${title(a.colonia)}`);
  if (a.cp) parts.push(`C.P. ${a.cp}`);
  return parts.join(', ');
}

/** Nombre si el cliente se presenta: "me llamo Laura", "soy Pedro". */
export function parseName(text) {
  const m = String(text || '').match(/\b(?:me llamo|mi nombre es|soy)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ]{2,20})(?:\s+([A-Za-zÁÉÍÓÚÑáéíóúñ]{2,20}))?/i);
  if (!m) return null;
  const first = m[1];
  if (/^(de|el|la|un|una|cliente|nuevo|nueva)$/i.test(first)) return null;
  return first[0].toUpperCase() + first.slice(1).toLowerCase();
}

/** El cliente está corrigiendo algo que ya dijo. */
export const isCorrection = text => /\b(mejor|cambia|cambiar|cambialo|corrige|corrijo|perdon|me equivoque|en realidad|mas bien|no es|era)\b/.test(norm(text));

const KEYBOARD = ['qwert', 'werty', 'asdf', 'sdfg', 'dfgh', 'fghj', 'ghjk', 'hjkl', 'zxcv', 'xcvb', 'cvbn', 'vbnm', 'poiu', 'lkjh', 'mnbv'];

/**
 * Texto sin sentido: solo símbolos, teclazos ("asdfgh"), palabras sin vocales o letras repetidas.
 * Conservador: ante la duda, devuelve false.
 */
export function isGibberish(text) {
  const t = norm(text);
  if (!t) return true;
  const letters = t.replace(/[^a-zn\s]/g, ' ').trim();
  if (!letters) return !/\d/.test(t); // solo signos o emojis
  const words = letters.split(/\s+/).filter(w => w.length >= 4);
  if (!words.length) return false;
  const bad = words.filter(w =>
    !/[aeiouy]/.test(w) ||
    /[bcdfghjklmnpqrstvwxz]{5,}/.test(w) ||
    (/[bcdfghjklmnpqrstvwxz]{4}/.test(w) && !/(nstr|bstr|nscr|bscr|ngst|rstr)/.test(w)) ||
    /q[^u]/.test(w) || /[jkwxz]{2}/.test(w) ||
    /(.)\1{3,}/.test(w) ||
    KEYBOARD.some(k => w.includes(k)));
  return bad.length / words.length >= 0.5;
}

/** Texto con suficiente contenido para servir como descripción del trabajo. */
export function isUsefulDetail(text) {
  const t = norm(text);
  if (isGibberish(t)) return false;
  const words = t.split(/\s+/).filter(w => /[a-z]/.test(w));
  if (words.length < 3 && t.length < 15) return false; // "no sé", "baño", "ok"
  if (intents(t).length && words.length <= 3) return false; // "hola buenas tardes", "ok muchas gracias"
  return true;
}

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

/** Elige un horario de la lista a partir de texto libre ("el 2", "el martes", "en la tarde", "el último"). */
export function matchSlot(text, slots) {
  if (!slots?.length) return null;
  const t = norm(text);
  const n = t.match(/^\s*(?:el |la |opcion )?([1-9])\b/);
  if (n && Number(n[1]) <= slots.length) return Number(n[1]) - 1;
  const ordinals = [['primer', 0], ['segund', 1], ['tercer', 2], ['ultim', slots.length - 1]];
  for (const [w, i] of ordinals) if (new RegExp(`\\b${w}`).test(t) && slots[i]) return i;
  const day = WEEKDAYS.find(d => new RegExp(`\\b${d}\\b`).test(t));
  const wantsAfternoon = /\b(tarde|noche)\b/.test(t);
  const wantsMorning = /\b(temprano|en la manana|por la manana)\b/.test(t);
  const hm = t.match(/\b(?:a las|las|a la|la)\s+(\d{1,2})(?::\d{2})?\b|\b(\d{1,2}):\d{2}\b|\b(\d{1,2})\s*(?:am|pm|hrs?|horas)\b/);
  const askedHour = hm ? Number(hm[1] || hm[2] || hm[3]) : null;
  const scored = slots.map((s, i) => {
    const ns = norm(s);
    const hour = Number((ns.match(/(\d{1,2}):\d{2}/) || [])[1]);
    let score = 0;
    if (askedHour != null && hour && (hour === askedHour || hour === askedHour + 12)) score += 3;
    if (day && ns.startsWith(day)) score += 2;
    if (wantsAfternoon && hour >= 13) score += 1;
    if (wantsMorning && hour && hour < 13) score += 1;
    return { i, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].score === scored[1].score) return null; // ambiguo
  return scored[0].i;
}
