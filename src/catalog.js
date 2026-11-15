import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { norm } from './nlu.js';

// Negocios configurables (config/businesses.json). Los precios los pone el negocio, nunca el agente.
const root = path.dirname(fileURLToPath(import.meta.url));
const file = process.env.BUSINESSES_FILE || path.join(root, '..', 'config', 'businesses.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

export const brand = data.brand;
export const profiles = data.profiles || {};
export const categories = data.categories || {};
export const modes = data.modes || {};
export const businesses = data.businesses.map(b => ({
  agentName: brand.defaultAgentName,
  depositPercent: 100,
  emoji: '🤝',
  color: '#0f766e',
  rating: null,
  reviews: 0,
  ...b,
  giro: b.giro || categories[b.category]?.label || '',
  steps: { details: false, quantity: false, schedule: null, address: false, ...b.steps },
  items: b.items.map(it => ({ ...it, keywords: (it.keywords || []).map(norm) })),
}));

export function getBusiness(id) {
  return businesses.find(b => b.id === id) || null;
}
export const defaultBusiness = businesses[0];

/**
 * Calificación combinada: la base del catálogo más las calificaciones reales de los clientes.
 * extra: [{ stars }]
 */
export function ratingSummary(b, extra = []) {
  const baseCount = b.reviews || 0;
  const sum = (b.rating || 0) * baseCount + extra.reduce((s, r) => s + r.stars, 0);
  const count = baseCount + extra.length;
  return { rating: count ? Math.round((sum / count) * 10) / 10 : null, reviews: count };
}

/** Datos que puede ver cualquiera (chat, inicio). */
export function publicBusiness(b, extraRatings = []) {
  return {
    id: b.id, name: b.name, owner: b.owner, giro: b.giro, zone: b.zone, hours: b.hours, agentName: b.agentName,
    category: b.category, categoryLabel: categories[b.category]?.label || null,
    mode: b.mode, modeLabel: modes[b.mode] || null, ...ratingSummary(b, extraRatings),
    profile: b.profile, profileLabel: profiles[b.profile] || null,
    emoji: b.emoji, color: b.color, about: b.about,
    steps: b.steps, depositPercent: b.depositPercent,
    items: b.items.map(({ id, name, price }) => ({ id, name, price })),
  };
}

/** Producto o servicio que mejor coincide con el texto (gana la palabra clave más específica). */
export function findItem(business, text) {
  const t = norm(text);
  if (!t) return null;
  let best = null;
  let bestScore = 0;
  for (const it of business.items) {
    if (it.id === t || norm(it.name) === t) return it;
    for (const k of it.keywords) {
      if (k && t.includes(k) && k.length > bestScore) { best = it; bestScore = k.length; }
    }
  }
  return best;
}

export function itemById(business, id) {
  return business.items.find(it => it.id === id) || null;
}

/** "Cita" para servicios, "Entrega" para pedidos; null si el negocio no agenda. */
export function scheduleLabel(business) {
  return business.steps.schedule === 'entrega' ? 'Entrega' : business.steps.schedule === 'cita' ? 'Cita' : null;
}

const DEFAULT_SLOTS = {
  cita: [{ day: 1, time: '9:00' }, { day: 1, time: '16:00' }, { day: 2, time: '11:00' }],
  entrega: [{ day: 1, time: '12:00 a 14:00' }, { day: 1, time: '17:00 a 19:00' }, { day: 2, time: '12:00 a 14:00' }],
};

// Horarios a partir de hoy (hora de CDMX, simplificado). Cada negocio puede definir
// "slots": [{ "day": días a partir de hoy, "time": "texto opcional" }].
export function availableSlots(business, now = new Date()) {
  const fmt = new Intl.DateTimeFormat('es-MX', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Mexico_City',
  });
  const slots = business.slots || DEFAULT_SLOTS[business.steps.schedule] || DEFAULT_SLOTS.cita;
  return slots.slice(0, 3).map(s => {
    const date = s.day === 0 ? 'hoy' : fmt.format(new Date(now.getTime() + s.day * 24 * 3600e3));
    return s.time ? `${date}, ${s.time}` : date;
  });
}

const round2 = n => Math.round(n * 100) / 100;

export function buildQuote(business, item, quantity = 1) {
  const qty = Math.max(1, Math.floor(quantity || 1));
  const total = round2(item.price * qty);
  const deposit = round2((total * business.depositPercent) / 100);
  return {
    items: [{ concept: item.name, quantity: qty, unitPrice: item.price, amount: total }],
    total,
    deposit,
  };
}
