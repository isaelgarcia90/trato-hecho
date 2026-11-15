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
  const scored = slots.map((s, i) => {
    const ns = norm(s);
    const hour = Number((ns.match(/(\d{1,2}):\d{2}/) || [])[1]);
    let score = 0;
    if (day && ns.startsWith(day)) score += 2;
    if (wantsAfternoon && hour >= 13) score += 1;
    if (wantsMorning && hour && hour < 13) score += 1;
    return { i, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].score === scored[1].score) return null; // ambiguo
  return scored[0].i;
}
