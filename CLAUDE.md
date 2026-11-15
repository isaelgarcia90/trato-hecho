# Contexto del proyecto (para Claude Code)

## Qué es
Trato Hecho · Cuentas claras (antes "Chamba"): asistente por chat para cualquier negocio (oficios, emprendedores,
freelancers, negocios informales). El agente por defecto se llama Clarito. Cotiza con precios fijos del catálogo,
agenda si el negocio lo pide y cobra con CoDi usando el API de pey. Panel del negocio en vivo (SSE).
Negocios configurables en `config/businesses.json`: 21 negocios en 9 categorías (`categories`) y 6 tipos de
negocio (`profiles`). El agente valida cada paso con reglas en `src/nlu.js` (texto sin sentido, fuera de catálogo,
cantidades, celulares, horarios, preguntas) y puede pasar la conversación al negocio (`needsHuman`; el negocio
responde desde el panel con `POST /api/panel/jobs/:id/reply`).
Proyecto para el Cursor Hackatón México 2026, sede CDMX.

## Fechas y reglas que importan
- Entrega local CDMX (1 día): domingo 15 nov 2026, 1:00 PM CDMX. Form: https://forms.gle/dfXTnL8ethxoGNk49
  Pide: nombre del equipo, descripción, repo público (obligatorio), link en vivo (preferido), video (opcional), correos.
- Hackatón de 4 semanas: entrega 12 dic 2026 23:59 (reglas: https://hackatonmexico.com/reglas).
  - Criterios: uso de CoDi + API de pey 30%, impacto 25%, ejecución técnica 15%, experiencia/diseño 15%, originalidad 15%.
  - Obligatorio: generar al menos un cobro CoDi real en producción y reaccionar al resultado (webhook). Simulado no cumple.
  - Video ≤ 3 min mostrando un cobro CoDi completo. Solo cuenta trabajo hecho en el periodo.
- pey no tiene sandbox: se prueba en producción con $0.01 (DEMO_CHARGE_AMOUNT=0.01).
  Para hoy se pueden usar las CLABEs pre-autorizadas de la hoja del evento (alta en portal.pey.mx / portal.mipey.mx).

## API de pey (de https://docs.pey.mx/openapi.json)
- Base: https://api.pey.mx · Auth: `Authorization: Bearer <API key>`
- `POST /codi/qr` body: amount (req), concept, expiration (0 o ≥360), numRef (^[0-9]{1,7}$), generateImage,
  bankAccountId, metadata (≤50 pares planos). 201 → { id (IDC), qrString, qrImage|null }
- `POST /codi/pn` body: amount (req, >0), phoneNumber (req, 10 dígitos), concept, expiration (≥360),
  numRef, bankAccountId, metadata. 200 → { transactionId, codiId }
- Webhooks (Standard Webhooks, headers webhook-id/-timestamp/-signature), uno por API key,
  se configura en portal.mipey.mx/developers (engrane de la key):
  - `codi.qr.payment_received`: amount, apiKeyId, codiQrId, concept, datePaid, metadata, numRef, transactionId, type
  - `codi.pn.payment_received`: amount, apiKeyId, concept, datePaid, metadata, numRef, transactionId, type
  - No hay eventos documentados de rechazo/expiración.
- Errores 400: { error: { message, type, requestId } }

## Arquitectura
- `src/server.js` Express: rutas del chat, panel, SSE, webhook (cuerpo crudo + verificación de firma),
  simulador de pago solo en modo mock.
- `config/businesses.json` + `src/catalog.js`: marca, negocios, catálogo, pasos (`details`, `quantity`,
  `schedule`: cita|entrega|null) y `depositPercent` (< 100 = anticipo; 100 = pago completo).
- `src/agent.js` flujo según los pasos del negocio: producto/servicio → cantidad → detalles → horario →
  celular → cotización → cobro (push o QR).
  LLM opcional (API compatible con OpenAI, por defecto Gemini) solo para extraer datos; precios y cobros
  los decide el servidor.
- `src/payments.js` crea cobros, relaciona eventos (transactionId / codiQrId / metadata.chargeId / numRef),
  idempotencia por webhook-id.
- `src/pey.js` cliente HTTP; sin PEY_API_KEY → modo simulado.
- `src/store.js` JSON en `data/db.json` (en Render free el disco es efímero: aceptable para la demo).
- `public/` chat.html (estilo WhatsApp, `?n=<negocio>`), panel.html (filtro por negocio), index.html.

## Estado
- Probado: flujo completo en modo simulado; modo producción contra un pey falso (forma del body correcta);
  firma inválida → 400, válida → confirma cita, duplicado → ignorado; QR se dibuja desde qrString.
- Repo público: https://github.com/isaelgarcia90/trato-hecho (rama master; push → Render redeploya solo).
- Live: https://trato-hecho-l22c.onrender.com (Render free, servicio `trato-hecho`). Variables en Render:
  PEY_API_KEY, PEY_WEBHOOK_SECRET, ALLOWED_PHONES, DEMO_CHARGE_AMOUNT=0.01, PANEL_PASSWORD y PEY_MOCK=1.
- pey real (15 nov 2026): la key se acepta, pero /codi/pn y /codi/qr responden
  `400 API key does not have CoDi enabled` porque la cuenta bancaria está en Pending (hasta 5 días hábiles).
  Webhook configurado y verificado (sin firma → 400). Por eso la demo corre con PEY_MOCK=1.

## Pendiente (en orden)
1. Cuando la cuenta CoDi esté activa: borrar PEY_MOCK en Render y hacer un cobro real de $0.01 (push; si falla, QR).
   Revisar logs `[pay]` y `[webhook]`. Obligatorio antes del 12 dic 2026.
2. Video ≤ 3 min con un cobro CoDi completo.
3. Migrar a Postgres (Neon/Supabase) y después a Vercel; WhatsApp Business API.

## Ideas para las 4 semanas (no implementadas)
- WhatsApp Business API real; multi-negocio; recordatorios; reportes de comisiones ahorradas.
- Alternativa evaluada: gasolinera con anillo/tag NFC + ESP32 (pago CoDi push desbloquea bomba).
- Contexto del kickoff: Ley de Economía Digital (DOF 4 nov 2026) faculta a Hacienda a definir sectores
  solo-digitales (gasolineras y casetas primero); bancos homologan experiencia de pago el 14 dic;
  cuenta N2Bis sin RFC. Argumentos: sin contracargos, dinero al instante; las comisiones de tarjeta van a bajar.

## Estilo
- Respuestas en español, concisas, en viñetas. Descripciones honestas, sin inflar.
