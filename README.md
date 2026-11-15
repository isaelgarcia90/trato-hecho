# Trato Hecho · Cuentas claras

Un asistente por chat para cualquier negocio, formal o informal: oficios, micro-emprendedores, freelancers,
negocios de barrio, jóvenes que venden por encargo o personas mayores que venden por catálogo.
**Clarito**, el agente, atiende a los clientes, cotiza con los precios del negocio, agenda si hace falta y
**cobra con CoDi** usando el API de pey. Cuando el banco confirma el pago, el trato queda cerrado y el negocio lo ve
en su panel en tiempo real.

Proyecto para el **Cursor Hackatón México 2026** (sede CDMX).

## Para los jueces

| | |
|---|---|
| **Demo en vivo** | https://trato-hecho-l22c.onrender.com |
| **Panel del negocio** | https://trato-hecho-l22c.onrender.com/panel |
| **Repositorio** | https://github.com/isaelgarcia90/trato-hecho |

> El servidor está en el plan gratis de Render: si nadie lo ha usado en los últimos 15 minutos, la primera carga
> tarda unos 50 segundos en despertar.

**Pruébalo en 2 minutos**
1. En el inicio, busca un negocio (por ejemplo "plomero" o "tamales") o filtra por categoría, y abre su chat.
2. Escribe con tus palabras, por ejemplo: `se me tapó el baño desde ayer en la noche`. También puedes probar
   mensajes incoherentes (`asdfgh`, `quiero una pizza`, `no sé`): el agente explica qué le falta y pide una
   respuesta válida.
3. Elige horario, escribe un celular de 10 dígitos (o `QR`) y pide el cobro.
4. Toca **"Simular que pagué"**: el chat y el panel cambian a "Pagado" al instante.
5. En el panel puedes responder al cliente, agregar un cargo extra y cobrar el restante.

### Estado de la integración con pey: lista, en modo de prueba

La demo en vivo corre en **modo de prueba** (`PEY_MOCK=1`): los cobros no llegan a ningún banco y el botón
"Simular que pagué" hace el papel del webhook de pey. Esto **no es por falta de integración**, sino porque la
cuenta CoDi todavía no está activa:

- **Configurado en producción:** API key de pey, webhook `https://trato-hecho-l22c.onrender.com/webhooks/pey` con
  su secreto y la cuenta bancaria (CLABE) dada de alta en el portal de pey.
- **Lo que pasó al probar:** con la app en modo producción, pey **aceptó la API key** y recibió los cobros bien
  armados (push y QR), pero respondió `400: API key does not have CoDi enabled`.
- **La causa:** la cuenta bancaria se dio de alta el 15 de noviembre de 2026 y está en estado **Pending**. El portal
  indica que se activa en **hasta 5 días hábiles**. No hubo tiempo de usar una CLABE pre-autorizada del evento
  antes de dejar la sede.
- **Lo que sí se verificó en producción:** el webhook rechaza avisos sin firma o con firma falsa
  (`400 invalid signature`), y el simulador de pagos queda bloqueado (`403`) fuera del modo de prueba.
- **Para pasar a cobros reales** solo hay que quitar `PEY_MOCK` en Render cuando pey active la cuenta; no hace
  falta cambiar código. El primer cobro real será de $0.01 (`DEMO_CHARGE_AMOUNT`), antes de la entrega final del
  12 de diciembre.

## El problema

- Los negocios pequeños viven del efectivo y de las transferencias con captura de pantalla.
  Verificar quién pagó, y cuánto, se hace a mano.
- La terminal de tarjeta cobra comisión y tiene contracargos. Un "yo no pedí eso" después de hacer el trabajo
  o entregar el pedido es dinero perdido.
- El cliente pide por chat, pero apartar una cita o un pedido no tiene garantía: la gente no llega o no recoge.

## Un mismo agente, distintos negocios

Cada negocio se configura en [`config/businesses.json`](config/businesses.json): nombre, catálogo con precios fijos,
pasos del flujo, porcentaje de anticipo y nombre del agente (por defecto, Clarito). El catálogo de ejemplo trae
**21 negocios en 9 categorías**: hogar y reparaciones (plomería, electricidad, cerrajería, pintura, limpieza,
línea blanca, jardinería), belleza, salud, comida, clases, diseño y fotografía, mascotas, autos y regalos.
Cubren oficios independientes, negocios establecidos, freelancers, emprendimientos, jóvenes y negocios familiares.

| Flujo | Ejemplo | Cobro |
|---|---|---|
| Servicio → detalles → **cita** → celular | Plomería Don Beto | Anticipo del 50% y el resto al terminar (con extras desde el panel) |
| Servicio → **cita** → celular | Consultorio Dental Sonríe | Anticipo del 30% |
| Paquete → detalles → **fecha de entrega** → celular | Ana Ruiz · Diseño | Anticipo del 50% |
| Producto → **cantidad** → **entrega** → celular | Postres de Sofi | Pago completo |
| Producto → **cantidad** → celular (o QR) | Tamales Doña Mary | Pago completo, venta directa |

Pasos configurables por negocio (`steps`): `details` (pedir detalles), `quantity` (pedir cantidad) y
`schedule` (`"cita"`, `"entrega"` o `null`). Con `depositPercent` menor a 100 se cobra un anticipo.
Opcionales: `slots` (días y horas; `day: 0` es hoy), `scheduleQuestion`, `detailsPrompt`, `detailsExample`,
`agentName`, `emoji`, `color`, `about`, `zone`, `hours`, `category` y `profile`.

## Cómo conversa el agente

El agente funciona con reglas ([`src/nlu.js`](src/nlu.js)); un LLM es opcional. En cada paso valida la respuesta:

- **Texto sin sentido** ("asdfgh", "???"): dice que no entendió y pide un dato concreto con ejemplos.
- **Algo que el negocio no ofrece** ("quiero una pizza" en una plomería): lo dice y muestra lo que sí hay.
- **Detalle insuficiente** ("no sé"): explica por qué lo necesita y da un ejemplo.
- **Celular inválido**: dice cuántos dígitos escribió. También se puede pagar con QR sin dar el celular.
- **Cantidades** en número o palabras ("media docena", "diez"), con un límite de 99 por chat.
- **Horarios en texto libre** ("mañana en la tarde", "el segundo"); si pide un día sin espacio, lo dice.
- **Preguntas en cualquier momento** (precios, horario, zona, cómo pagar): responde y retoma el paso.
- **Detalles extra** a media conversación se anotan para el negocio.
- Tras dos malentendidos, o si el cliente lo pide, ofrece **hablar con el negocio**. El negocio ve una alerta
  en el panel y responde desde ahí; su mensaje llega al mismo chat.

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

- `/`: inicio con buscador y filtros.
- `/chat?n=<id del negocio>` (por ejemplo `plomeria`, `dental`, `tamales`): el chat del cliente.
  Agrega `&nuevo` para empezar otra conversación.
- `/panel`: el negocio.
- En **modo de prueba** (sin `PEY_API_KEY`, o con `PEY_MOCK=1`) aparece el botón "Simular que pagué".
- `npm test`: 17 pruebas, incluidas conversaciones completas con mensajes coherentes e incoherentes.

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
| `PEY_API_KEY` | API key de pey (Bearer). Sin ella, modo de prueba |
| `PEY_MOCK` | `1` fuerza el modo de prueba aunque haya API key (útil mientras pey activa la cuenta) |
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

- Primer cobro CoDi real con webhook en cuanto pey active la cuenta.
- Conectar WhatsApp Business API.
- Base de datos (Postgres) para que los datos no se pierdan al reiniciar el servidor.
- Alta de negocios desde el panel, cada uno con su catálogo y su cuenta CoDi.
- Carrito con varios productos, agenda real y recordatorios.
- Reportes para el negocio: ingresos por semana y comisiones ahorradas contra tarjeta.

## Componentes de terceros

Express, qrcode, standardwebhooks y dotenv (licencias MIT). API de pey. LLM opcional vía API compatible
con OpenAI. Código escrito con ayuda de herramientas de IA.

## Licencia

MIT
