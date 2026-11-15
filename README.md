# Trato Hecho · Cuentas claras

Cotiza, aparta y paga **por chat** con los negocios de tu colonia: el plomero, la estética, la señora de los
tamales o la freelancer de diseño. **Clarito**, el asistente de cada negocio, entiende lo que escribes, te da un
precio claro y te cobra con **CoDi** (API de pey), sin tarjeta y sin comisión.

Proyecto para el **Cursor Hackatón México 2026** (sede CDMX).

| | |
|---|---|
| **Demo** | https://trato-hecho-l22c.onrender.com |
| **Panel del negocio** | https://trato-hecho-l22c.onrender.com/panel |

> Render gratis: si nadie lo usó en 15 minutos, la primera carga tarda ~50 s.

## Pruébalo en 2 minutos

1. Desliza la historia del inicio y busca un servicio (por ejemplo "plomero" o "tamales").
2. En el chat escribe con tus palabras: `hola, me llamo Laura, se me tapó el baño desde ayer`.
   Prueba también cosas raras: `asdfgh`, `quiero una pizza`, un celular como `1234567890`.
3. Da tu dirección y celular, y pide el cobro. Toca **"Simular que pagué"** y califica al negocio.
4. En el panel ves el trato, el pago y la calificación en vivo, y puedes responderle al cliente.

## Qué tiene

- **38 negocios en 9 categorías**, con calificación, precio desde y dónde atiende (va a tu casa, en su local,
  en línea o para llevar). Búsqueda, categorías y 3 filtros simples.
- **Agente que valida todo** ([`src/agent.js`](src/agent.js), [`src/nlu.js`](src/nlu.js)):
  - Celulares reales de México (10 dígitos; no empiezan con 0 o 1; ni repetidos ni consecutivos; acepta +52).
  - Direcciones por partes: calle, número (o "sin número", manzana y lote) y colonia o código postal.
  - Recuerda lo que ya dijiste (nombre, dirección, celular) y acepta correcciones ("mejor a las 9").
  - Si no entiende, explica qué le falta; tras dos intentos, ofrece hablar con el negocio.
- **Calificaciones**: al pagar, el cliente da de 1 a 5 estrellas y un comentario opcional.
- **Pago con CoDi** por notificación a la app del banco o por QR. El webhook de pey se verifica con firma
  (Standard Webhooks) y cada pago se procesa una sola vez.

## Estado de pey: integración lista, demo en modo de prueba

La demo corre con `PEY_MOCK=1`: los cobros no llegan a un banco y "Simular que pagué" hace de webhook.

- **Ya configurado en producción:** API key, webhook `/webhooks/pey` con su secreto y cuenta CoDi (CLABE).
- **Al probar con dinero real**, pey aceptó la llave pero respondió `400: API key does not have CoDi enabled`:
  la cuenta se dio de alta el 15 de noviembre de 2026 y sigue **pendiente** (hasta 5 días hábiles). No alcanzó
  el tiempo para usar una CLABE pre-autorizada del evento.
- **Verificado en producción:** el webhook rechaza avisos sin firma o con firma falsa y el simulador se bloquea.
- **Siguiente paso:** cuando pey active la cuenta, quitar `PEY_MOCK` y hacer el primer cobro real de $0.01.

## Correr en local

```bash
npm install
npm start      # http://localhost:3000 (sin PEY_API_KEY corre en modo de prueba)
npm test       # 23 pruebas, incluidas conversaciones completas
```

Los negocios se editan en [`config/businesses.json`](config/businesses.json). Las calificaciones iniciales del
catálogo son de ejemplo; las nuevas se suman con cada cliente.

Variables principales: `PEY_API_KEY`, `PEY_WEBHOOK_SECRET`, `PEY_MOCK`, `DEMO_CHARGE_AMOUNT` (ej. `0.01`),
`ALLOWED_PHONES`, `PANEL_PASSWORD` y, opcional, `LLM_API_KEY` para entender mejor el texto libre.

## Límites honestos

- Chat web con estilo de WhatsApp; conectar WhatsApp Business es el siguiente paso.
- Datos en un archivo JSON: en Render gratis se borran al reiniciar. Siguiente paso: Postgres.
- Horarios de ejemplo, no una agenda real. Todos los negocios cobran a la misma cuenta CoDi por ahora.

MIT · Hecho con Express, qrcode, standardwebhooks y la API de pey.
