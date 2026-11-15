import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Negocios configurables (config/businesses.json). Los precios los pone el negocio, nunca el agente.
const root = path.dirname(fileURLToPath(import.meta.url));
const file = process.env.BUSINESSES_FILE || path.join(root, '..', 'config', 'businesses.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

export const brand = data.brand;
export const businesses = data.businesses.map(b => ({
  agentName: brand.defaultAgentName,
  depositPercent: 100,
  ...b,
  steps: { details: false, quantity: false, schedule: null, ...b.steps },
}));

export function getBusiness(id) {
  return businesses.find(b => b.id === id) || null;
}
export const defaultBusiness = businesses[0];

/** Datos que puede ver cualquiera (chat, landing). */
export function publicBusiness(b) {
  return {
    id: b.id, name: b.name, owner: b.owner, giro: b.giro, agentName: b.agentName,
    steps: b.steps, depositPercent: b.depositPercent,
    items: b.items.map(({ id, name, price }) => ({ id, name, price })),
  };
}

export function findItem(business, text) {
  if (!text) return null;
  const t = text.toLowerCase();
  for (const it of business.items) {
    if (it.id === t || it.name.toLowerCase() === t) return it;
    if ((it.keywords || []).some(k => t.includes(k))) return it;
  }
  return null;
}

export function itemById(business, id) {
  return business.items.find(it => it.id === id) || null;
}

/** "cita" para servicios, "entrega" para pedidos; null si el negocio no agenda. */
export function scheduleLabel(business) {
  return business.steps.schedule === 'entrega' ? 'Entrega' : business.steps.schedule === 'cita' ? 'Cita' : null;
}

// Tres horarios disponibles a partir de mañana (hora de CDMX, simplificado).
export function availableSlots(business, now = new Date()) {
  const fmt = new Intl.DateTimeFormat('es-MX', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Mexico_City',
  });
  const day1 = fmt.format(new Date(now.getTime() + 24 * 3600e3));
  const day2 = fmt.format(new Date(now.getTime() + 48 * 3600e3));
  if (business.steps.schedule === 'entrega') {
    return [`${day1}, 12:00 a 14:00`, `${day1}, 17:00 a 19:00`, `${day2}, 12:00 a 14:00`];
  }
  return [`${day1}, 9:00`, `${day1}, 16:00`, `${day2}, 11:00`];
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
