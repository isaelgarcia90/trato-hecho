import 'dotenv/config';

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),

  // pey
  peyApiKey: env.PEY_API_KEY || '',
  peyBaseUrl: (env.PEY_BASE_URL || 'https://api.pey.mx').replace(/\/$/, ''),
  peyWebhookSecret: env.PEY_WEBHOOK_SECRET || '',
  peyBankAccountId: env.PEY_BANK_ACCOUNT_ID || '',
  // Sin API key, la app corre en modo simulado (se marca en la UI).
  peyMock: env.PEY_MOCK === '1' || !env.PEY_API_KEY,

  // Para probar con dinero real a $0.01 sin cambiar las cotizaciones.
  demoChargeAmount: env.DEMO_CHARGE_AMOUNT ? Number(env.DEMO_CHARGE_AMOUNT) : null,

  // Opcional: limitar a qué celulares se pueden mandar cobros (coma-separados).
  allowedPhones: (env.ALLOWED_PHONES || '').split(',').map(s => s.trim()).filter(Boolean),

  // Opcional: protege el panel del negocio con usuario "negocio" y esta contraseña.
  panelPassword: env.PANEL_PASSWORD || '',

  // LLM opcional, cualquier API compatible con OpenAI (OpenAI, Gemini, Groq...).
  llmApiKey: env.LLM_API_KEY || '',
  llmBaseUrl: (env.LLM_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, ''),
  llmModel: env.LLM_MODEL || 'gemini-2.5-flash',

  dataFile: env.DATA_FILE || 'data/db.json',
};
