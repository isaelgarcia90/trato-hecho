# Chamba · el agente que cotiza y cobra con CoDi

Chamba atiende por chat a los clientes de un oficio (plomero, electricista, cerrajero…): entiende el problema,
cotiza con los precios del negocio, agenda la cita y **cobra el anticipo con CoDi** usando el API de pey.
Cuando el banco confirma el pago, la cita queda apartada sola y el negocio lo ve en su panel en tiempo real.
Al terminar el trabajo, el negocio agrega extras (refacciones) y cobra el restante desde el mismo panel.

Proyecto para el **Cursor Hackatón México 2026** (CDMX).

## El problema

- Los oficios y los negocios de barrio viven del efectivo y de las transferencias con captura de pantalla.
  Verificar quién pagó, y cuánto, se hace a mano.
- La terminal de tarjeta cobra comisión y tiene contracargos. Para un plomero, un "yo no pedí ese servicio"
  después de hacer el trabajo es dinero perdido.
- El cliente pide por chat, pero apartar una cita no tiene garantía: la gente no llega y el técnico pierde la mañana.

## Qué hace

1. **Chat del cliente** (estilo WhatsApp, web): el agente identifica el servicio a partir del texto libre
   ("se tapó el baño"), pide detalles, ofrece horarios y el celular del cliente.
2. **Cotización**: los precios salen del catálogo del negocio. El agente nunca inventa precios.
3. **Cobro del anticipo con CoDi**, en dos formas:
   - **Notificación push** (`POST /codi/pn`): el cobro llega directo a la app del banco del cliente.
     No escribe CLABE ni escanea nada.
   - **QR** (`POST /codi/qr`): para quien prefiere escanear.
4. **Webhook de pey** (`codi.pn.payment_received` / `codi.qr.payment_received`): la firma se verifica con
   Standard Webhooks, el evento se procesa una sola vez (idempotencia) y el pago confirma la cita.
5. **Panel del negocio**: citas, pagado y pendiente en vivo. Permite agregar cargos extra y cobrar el restante
   (push o QR) cuando se termina el trabajo.

## Uso del API de pey

| Paso | Endpoint / evento | Para qué |
|---|---|---|
| Cobro al celular | `POST https://api.pey.mx/codi/pn` (`amount`, `phoneNumber`, `concept`, `numRef`, `metadata`) | Anticipo y pago final directo en la app del banco |
| Cobro con QR | `POST https://api.pey.mx/codi/qr` (`amount`, `concept`, `numRef`, `expiration`, `metadata`) | Alternativa con QR; se dibuja a partir de `qrString` |
| Confirmación | Webhook `codi.pn.payment_received` / `codi.qr.payment_received` | Cambia la cita a "confirmada" o "pagada" |

El cobro se relaciona con el evento por `transactionId` (push), `codiQrId` (QR) o `numRef`, y además se manda
`metadata.chargeId`. Nunca se ejecuta dos veces la misma confirmación.

## Correr en local

```bash
npm install
cp .env.example .env     # sin PEY_API_KEY corre en modo simulado
npm start                # http://localhost:3000
```

- `/chat`: el cliente. `/chat?nuevo` abre una conversación nueva.
- `/panel`: el negocio.
- En **modo simulado** aparece un botón "Simular que pagué". Ese modo sirve solo para desarrollo:
  la entrega usa pey en producción.

## Deploy (Render, gratis)

1. Sube el repo a GitHub y crea un **Web Service** en Render desde el repo (`render.yaml` ya lo configura).
2. Variables de entorno: `PEY_API_KEY`, `PEY_WEBHOOK_SECRET`, `PUBLIC_URL`, y opcionalmente
   `DEMO_CHARGE_AMOUNT=0.01`, `PANEL_PASSWORD`, `LLM_API_KEY`.
3. En **portal.mipey.mx/developers** → engrane de tu API key → agrega el webhook
   `https://TU-APP.onrender.com/webhooks/pey` → copia el secreto a `PEY_WEBHOOK_SECRET`.
4. Prueba con tu celular: abre `/chat`, pide el cobro y apruébalo en tu banco.

> Las pruebas con pey son en producción. Con `DEMO_CHARGE_AMOUNT=0.01` la cotización muestra el precio real,
> pero se cobra $0.01.

## Variables de entorno

| Variable | Descripción |
|---|---|
| `PEY_API_KEY` | API key de pey (Bearer). Sin ella, modo simulado |
| `PEY_WEBHOOK_SECRET` | Secreto del webhook (Standard Webhooks) |
| `PEY_BANK_ACCOUNT_ID` | Opcional: cuenta CoDi específica (ULID) |
| `DEMO_CHARGE_AMOUNT` | Opcional: monto real a cobrar en pruebas (ej. `0.01`) |
| `ALLOWED_PHONES` | Opcional: celulares permitidos para cobros push, separados por coma |
| `PANEL_PASSWORD` | Opcional: protege `/panel` (usuario cualquiera) |
| `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | Opcional: LLM compatible con OpenAI (por defecto, Gemini) para entender mejor el texto libre |

## Decisiones y límites (honestos)

- **El canal es un chat web con estilo WhatsApp.** Conectar WhatsApp Business requiere la aprobación de Meta;
  el agente ya está separado del canal para conectarlo después.
- **Los precios y los cobros los decide el servidor**, no el LLM. El LLM (opcional) solo entiende el texto
  y redacta. Sin LLM funciona con reglas.
- **Un pago no prueba identidad ni que el trabajo se hizo.** Por eso el flujo es anticipo + pago final, y el
  panel registra cada cobro.
- **Pagos tardíos:** si llega un pago después de que el cobro expiró, se registra igual y la cita se confirma.
  Si el cliente paga dos veces, el panel lo muestra para devolverlo.
- **Almacenamiento en un archivo JSON**, suficiente para el hackatón; el siguiente paso es Postgres.
- **Seguridad:** firma de webhook obligatoria en producción, idempotencia por evento, panel con contraseña
  opcional y lista de celulares permitidos para evitar que alguien use la demo para mandar cobros no deseados.

## Siguientes pasos (4 semanas)

- Conectar WhatsApp Business API.
- Multi-negocio: que cada técnico configure su catálogo y su cuenta CoDi.
- Recordatorios antes de la cita y cobro automático al marcar "trabajo terminado".
- Reportes para el negocio: ingresos por semana y comisiones ahorradas contra tarjeta.

## Componentes de terceros

Express, qrcode, standardwebhooks y dotenv (licencias MIT). API de pey. LLM opcional vía API compatible
con OpenAI. Código escrito con ayuda de herramientas de IA.

## Licencia

MIT
