# Trato Hecho · Cuentas claras

Un asistente por chat para cualquier negocio, formal o informal: oficios, micro-emprendedores, freelancers,
negocios de barrio, jóvenes que venden por encargo o personas mayores que venden por catálogo.
**Clarito**, el agente, atiende a los clientes, cotiza con los precios del negocio, agenda si hace falta y
**cobra con CoDi** usando el API de pey. Cuando el banco confirma el pago, el trato queda cerrado y el negocio lo ve
en su panel en tiempo real.

Proyecto para el **Cursor Hackatón México 2026** (CDMX).

## El problema

- Los negocios pequeños viven del efectivo y de las transferencias con captura de pantalla.
  Verificar quién pagó, y cuánto, se hace a mano.
- La terminal de tarjeta cobra comisión y tiene contracargos. Un "yo no pedí eso" después de hacer el trabajo
  o entregar el pedido es dinero perdido.
- El cliente pide por chat, pero apartar una cita o un pedido no tiene garantía: la gente no llega o no recoge.

## Un mismo agente, distintos negocios

Cada negocio se configura en [`config/businesses.json`](config/businesses.json): nombre, catálogo con precios fijos,
pasos del flujo, porcentaje de anticipo y nombre del agente (por defecto, Clarito). El demo trae tres:

| Negocio de ejemplo | Flujo | Cobro |
|---|---|---|
| Plomería Don Beto | Servicio → detalles → **cita** → celular → cotización | Anticipo del 50% y el resto al terminar (con extras desde el panel) |
| Postres de Sofi | Producto → **cantidad** → **fecha de entrega** → celular → cotización | Pago completo |
| Tamales Doña Mary | Producto → **cantidad** → celular → cotización | Pago completo, venta directa |

Pasos configurables por negocio (`steps`): `details` (pedir detalles), `quantity` (pedir cantidad) y
`schedule` (`"cita"`, `"entrega"` o `null`). Con `depositPercent` menor a 100 se cobra un anticipo.

## Qué hace

1. **Chat del cliente** (estilo WhatsApp, web): el agente identifica el producto o servicio a partir del texto libre
   ("se tapó el baño", "quiero 10 tamales verdes") y pregunta solo lo que el negocio necesita.
2. **Cotización**: los precios salen del catálogo del negocio. El agente nunca inventa precios.
3. **Cobro con CoDi**, en dos formas:
   - **Notificación push** (`POST /codi/pn`): el cobro llega directo a la app del banco del cliente.
     No escribe CLABE ni escanea nada.
   - **QR** (`POST /codi/qr`): para quien prefiere escanear.
4. **Webhook de pey** (`codi.pn.payment_received` / `codi.qr.payment_received`): la firma se verifica con
   Standard Webhooks, el evento se procesa una sola vez (idempotencia) y el pago cierra el trato.
5. **Panel del negocio**: tratos, pagado y pendiente en vivo, con filtro por negocio. Permite agregar cargos extra
   y cobrar el restante (push o QR).

## Uso del API de pey

| Paso | Endpoint / evento | Para qué |
|---|---|---|
| Cobro al celular | `POST https://api.pey.mx/codi/pn` (`amount`, `phoneNumber`, `concept`, `numRef`, `metadata`) | Anticipo, pago completo o restante, directo en la app del banco |
| Cobro con QR | `POST https://api.pey.mx/codi/qr` (`amount`, `concept`, `numRef`, `expiration`, `metadata`) | Alternativa con QR; se dibuja a partir de `qrString` |
| Confirmación | Webhook `codi.pn.payment_received` / `codi.qr.payment_received` | Cambia el trato a "confirmada" o "pagada" |

El cobro se relaciona con el evento por `transactionId` (push), `codiQrId` (QR), `metadata.chargeId` o `numRef`.
Nunca se ejecuta dos veces la misma confirmación, y un evento que todavía no encuentra su cobro no se descarta
(el reintento de pey se puede aplicar).

## Correr en local

```bash
npm install
cp .env.example .env     # sin PEY_API_KEY corre en modo simulado
npm start                # http://localhost:3000
```

- `/`: inicio con los negocios de ejemplo.
- `/chat?n=plomeria` (o `postres`, `tamales`): el chat del cliente. Agrega `&nuevo` para empezar otra conversación.
- `/panel`: el negocio.
- En **modo simulado** aparece un botón "Simular que pagué". Ese modo sirve solo para desarrollo:
  la entrega usa pey en producción.

## Deploy (Render, gratis)

1. Sube el repo a GitHub y crea un **Web Service** en Render desde el repo (`render.yaml` ya lo configura).
2. Variables de entorno: `PEY_API_KEY`, `PEY_WEBHOOK_SECRET`, `PUBLIC_URL`, y opcionalmente
   `DEMO_CHARGE_AMOUNT=0.01`, `PANEL_PASSWORD`, `LLM_API_KEY`.
3. En **portal.mipey.mx/developers** → engrane de tu API key → agrega el webhook
   `https://TU-APP.onrender.com/webhooks/pey` → copia el secreto a `PEY_WEBHOOK_SECRET`.
4. Prueba con tu celular: abre un chat, pide el cobro y apruébalo en tu banco.

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
| `BUSINESSES_FILE` | Opcional: ruta a otro archivo de negocios (por defecto `config/businesses.json`) |
| `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | Opcional: LLM compatible con OpenAI (por defecto, Gemini) para entender mejor el texto libre |

## Decisiones y límites (honestos)

- **El canal es un chat web con estilo WhatsApp.** Conectar WhatsApp Business requiere la plataforma de Meta;
  el agente ya está separado del canal para conectarlo después.
- **Los negocios se configuran en un archivo**, no desde una pantalla. Todos cobran a la misma cuenta CoDi
  (la de la API key); cada negocio con su propia cuenta es el siguiente paso.
- **Los precios y los cobros los decide el servidor**, no el LLM. El LLM (opcional) solo entiende el texto
  y redacta. Sin LLM funciona con reglas.
- **Los horarios son de ejemplo** (tres opciones a partir de mañana), no una agenda real.
- **Un pedido es de un solo producto** (con cantidad); el carrito con varios productos queda pendiente.
- **Un pago no prueba identidad ni que el trabajo se hizo.** Por eso los servicios usan anticipo + pago final, y el
  panel registra cada cobro.
- **Almacenamiento en un archivo JSON**, suficiente para el hackatón; el siguiente paso es Postgres.
- **Seguridad:** firma de webhook obligatoria en producción, idempotencia por evento, panel con contraseña
  opcional y lista de celulares permitidos para evitar que alguien use la demo para mandar cobros no deseados.

## Siguientes pasos (4 semanas)

- Conectar WhatsApp Business API.
- Alta de negocios desde el panel, cada uno con su catálogo y su cuenta CoDi.
- Carrito con varios productos, agenda real y recordatorios.
- Reportes para el negocio: ingresos por semana y comisiones ahorradas contra tarjeta.

## Componentes de terceros

Express, qrcode, standardwebhooks y dotenv (licencias MIT). API de pey. LLM opcional vía API compatible
con OpenAI. Código escrito con ayuda de herramientas de IA.

## Licencia

MIT
