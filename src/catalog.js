// Negocio de ejemplo. Los precios los pone el negocio, nunca el agente.
export const business = {
  name: 'Plomería Don Beto',
  oficio: 'plomería',
  zone: 'CDMX',
  depositPercent: 50, // anticipo para confirmar la cita
};

export const services = [
  {
    id: 'fuga',
    name: 'Reparación de fuga',
    price: 450,
    keywords: ['fuga', 'gotea', 'goteo', 'gotera', 'tira agua', 'escurre', 'llave', 'mezcladora'],
  },
  {
    id: 'destape',
    name: 'Destape de drenaje o WC',
    price: 380,
    keywords: ['destape', 'tapad', 'tapó', 'tapo', 'drenaje', 'coladera', 'baño', 'wc', 'excusado', 'taza', 'lavabo', 'fregadero'],
  },
  {
    id: 'calentador',
    name: 'Instalación de calentador',
    price: 950,
    keywords: ['calentador', 'boiler', 'bóiler', 'agua caliente', 'regadera fría'],
  },
  {
    id: 'tinaco',
    name: 'Limpieza o revisión de tinaco',
    price: 600,
    keywords: ['tinaco', 'cisterna', 'bomba', 'presión'],
  },
  {
    id: 'revision',
    name: 'Visita de diagnóstico',
    price: 200,
    keywords: ['revis', 'diagnóstico', 'diagnostico', 'no sé', 'no se', 'otro', 'ver qué', 'checar'],
  },
];

export function findService(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  for (const s of services) {
    if (s.id === t || s.name.toLowerCase() === t) return s;
    if (s.keywords.some(k => t.includes(k))) return s;
  }
  return null;
}

export function serviceById(id) {
  return services.find(s => s.id === id) || null;
}

// Tres horarios disponibles a partir de mañana (hora de CDMX, simplificado).
export function availableSlots(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('es-MX', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Mexico_City',
  });
  const day1 = new Date(now.getTime() + 24 * 3600e3);
  const day2 = new Date(now.getTime() + 48 * 3600e3);
  return [
    `${fmt.format(day1)}, 9:00`,
    `${fmt.format(day1)}, 16:00`,
    `${fmt.format(day2)}, 11:00`,
  ];
}

export function buildQuote(service) {
  const total = service.price;
  const deposit = Math.round((total * business.depositPercent) / 100 * 100) / 100;
  return {
    items: [{ concept: service.name, amount: total }],
    total,
    deposit,
  };
}
