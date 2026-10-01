# PRD — ssff-mcp Fase 2: profundización OData v2 (cursor, totales, batch_get, allowlist, salida XML, OAuth)

| Campo | Valor |
|---|---|
| Estado | **DRAFT v0.1** — borrador; documenta intención, **no autoriza implementación** (hereda D-11) |
| Fecha | 2026-10-01 |
| Fuente de decisiones | PRD.md v0.4 (D-01..D-25) + grill de Fase 2 (2026-10-01, D-26..D-32) + evidencia de sondas en vivo contra `clecesa` |
| Idioma | Español neutro profesional; identificadores y términos de código en inglés |
| Relación con PRD.md | **Sustituye** las secciones de Fase 2 de PRD.md v0.4 (FR-16..FR-24) por FR-25..FR-35 de este documento. El MVP (FR-01..FR-15) sigue vigente sin cambios |

| Versión | Notas |
|---|---|
| v0.1 | Cierre de Q-4 (v4 descartado con evidencia 404), Q-5-cursor (stateless sin TTL), Q-8 (batch_get vía odata-batch, techo 180 docu SAP), apertura de Q-6 (verificación OAuth con admin). Nuevas D-26..D-32, DS-P2-01..04, FR-25..FR-35. |
| v0.2 | Evidencia E2: flujo OAuth verificado contra la implementación de producción del maintainer (grant SAML 2.0 Bearer vía helper `/oauth/idp` de SAP, sin firma XML local; dos endpoints fijos por entorno). DS-P2-05 nuevo; FR-32 y FR-33 enmendados; A-P2-4 pasa de supuesto a evidencia; revisión D-24 realizada y documentada. |

Este documento consolida decisiones ya confirmadas. Ninguna parte autoriza a escribir código, publicar o cambiar licencia (D-10/D-11 de PRD.md siguen vigentes). **MUST / MUST NOT / SHOULD / MAY** según RFC 2119.

Convención (heredada de PRD.md):

- **D-xx** — decisión confirmada por el usuario (D-01..D-25 en PRD.md; D-26..D-32 aquí).
- **DS-P2-xx** — implicación derivada obligatoria por trazabilidad, no decidida directamente.
- **ASSUMPTION (A-P2-xx)** — supuesto técnico no verificado.
- **OPEN QUESTION (Q-P2-xx)** — pregunta registrada, sin responder ahora.

---

## 0. Registro de decisiones (ledger)

### 0.1 Decisiones confirmadas en Fase 2

| ID | Decisión | Fuente |
|---|---|---|
| D-26 | **v4 + selector de protocolo + fallback v2/v4 quedan fuera de Fase 2.** Evidencia: `GET /odata/v4/` y `GET /odata/v4/$metadata` devuelven **404** en `clecesa` (2026-10-01). Se reabren solo cuando exista un tenant con v4 verificado. Cierra Q-4 para este tenant. | User confirmation + sonda |
| D-27 | **Cursor opaco stateless sin TTL de reloj.** El cursor envuelve el `$skiptoken` real del servicio en un sobre `base64(payload + HMAC-SHA256)` con secreto **efímero en memoria del proceso**; payload ligado a `{entorno, entityPath, opciones}`. Sin almacenamiento ni caché entre llamadas. Manipulación, binding cruzado o cursor previo a un reinicio ⇒ rechazo saneado. La vida del cursor es la vida del proceso. | User confirmation (2 rondas) |
| D-28 | **`batch_get` entra**, construido sobre la librería `odata-batch` (MIT, `chiptime/odata-batch` v2.x) con transporte `fetch` inyectado por ssff-mcp. El MCP construye exclusivamente sobres **GET-only sin ChangeSets**. **Techo: 180 peticiones incrustadas** por `$batch` (documentación SAP; ver R9). Respuesta por elemento, en orden. | User confirmation + R9 |
| D-29 | **OAuth entra con verificación previa y gate bloqueante**: registro de cliente OAuth en el admin de SuccessFactors (candidato: OAuth 2.0 **SAML 2.0 Bearer Assertion**, A-4), `tokenUrl` fijo por entorno, TLS obligatorio. La revisión de D-24 (clave privada inline en claro, permisos restrictivos, nunca Git) es **obligatoria antes de implementar**. Si el grant no se verifica contra el tenant, la selección queda **bloqueada para decisión del usuario**. | User confirmation (hay colaboración de admin) |
| D-30 | **`entityAllowlist` entra** con la semántica confirmada de D-15 (PRD.md): claves en inglés `entity`, `protocols`; omisión de `protocols` = ambos protocolos; entidad ausente ⇒ denegada; `$metadata` nunca filtrado. Con v4 fuera (D-26), `protocols` queda como preparación futura. | User confirmation |
| D-31 | **`$inlinecount=allpages` se añade** como opción de `query_entity`. Verificado en vivo: `200` con `__count=96577` para `User` (2026-10-01). | User confirmation + sonda |
| D-32 | **Salida seleccionable por llamada**: `output: json (defecto) | xml`. XML = respuesta cruda del servicio (Atom, `Accept: application/atom+xml`; verificado en vivo: `application/xml` devuelve 406 en datos de entidad y solo es válido para `$metadata`). Campos nativos siempre, sin normalización (D-19 de PRD.md aplicado a v2). | User confirmation |

### 0.2 Implicaciones derivadas (obligatorias)

| ID | Implicación | Derivada de |
|---|---|---|
| DS-P2-01 | El techo de **1.000 registros aplica al TOTAL de la respuesta de `batch_get`** (no por elemento): una llamada MCP nunca devuelve más de 1.000 registros agregados, con independencia del número de elementos del lote. | D-18/FR-15 (PRD.md), D-28 |
| DS-P2-02 | OAuth requiere **caché transitoria del access token en memoria** (por entorno, muere con el proceso). Nunca en disco, nunca en logs, nunca devuelta al modelo. Sin ella el flujo sería un POST al `tokenUrl` por consulta, inaceptable. | D-09, D-12, D-29 |
| DS-P2-03 | Entradas allowlist con `protocols: ["v4"]` (o que excluyan v2) ⇒ **denegadas en esta fase**: sin v4 no hay protocolo disponible para esa entidad. | D-26, D-30 |
| DS-P2-04 | El sobre `$batch` GET-only es **la única** clase de POST a recursos de datos del producto; el POST al `tokenUrl` fijo es la única otra excepción POST (autenticación). No existe ninguna más. | D-07/D-08/DS-08 (PRD.md), D-28, D-29 |
| DS-P2-05 | OAuth usa **dos endpoints fijos por entorno**, ambos TLS y solo desde config, nunca input del modelo: `tokenUrl` (`POST /oauth/token`) y `idpUrl` (`POST /oauth/idp`, derivado por defecto del origen de `tokenUrl` + `/oauth/idp`, sobreescribible). La clave privada solo se transmite al `idpUrl` sobre HTTPS (comportamiento del helper IdP de SAP, E2). | D-29, E2 |

---

## 1. Context & Problem

El MVP de ssff-mcp está implementado, verificado (65/65 V1) y operativo contra `clecesa` (`api2.successfactors.eu`, OData v2). Fase 2 ataca las fricciones reales observadas en uso y verificadas por sondas del 2026-10-01:

- **Sin continuación real**: el techo de una página/1.000 registros (D-18) deja consultas grandes cojas; la alternativa actual (`$skip` cliente) **pierde registros** según la propia SAP (R7). El servicio pagina con `$skiptoken` (ventanas de filas) — existe continuación real que el MVP no expone.
- **Sin totales**: `$inlinecount=allpages` funciona en el tenant y el LLM no puede usarlo.
- **Consultas múltiples caras**: el LLM emite N llamadas MCP secuenciales para N entidades; `$batch` GET-only las agrupa con una sola autenticación.
- **Sin control de alcance por entidad**: la cuenta técnica compartida (D-23) delimita, pero una allowlist da control local explícito.
- **Solo JSON**: XML crudo a veces interesa para diffs/debug de esquema.
- **Solo Basic Auth**: D-12/D-13 prevén OAuth como alternativa; verificarla exige admin del tenant — colaboración disponible ahora.

Evidencia clave de sondas (2026-10-01, tenant `clecesa`, solo lectura):

| Sonda | Resultado |
|---|---|
| `GET /odata/v4/`, `GET /odata/v4/$metadata` | **404** — v4 no disponible (D-26) |
| `GET /odata/v2/$metadata` (Accept xml) | 200, 7.506.695 bytes, **658 EntitySets**, **67 FunctionImports** (`upsert`, `approveOffer`, `initiateOnboarding`…) — confirma exclusión D-25/DS-04 |
| `GET /odata/v2/User?$select=userId` | 200, `results=1000`, `__next` PRESENTE con `$skiptoken` (base64 de `{"startRow":1000,"endRow":2000}`) |
| `GET /odata/v2/User?$top=1&$inlinecount=allpages` | 200, `__count=96577` |
| Docu SAP `$batch` | Máximo **180** peticiones por lote; exceso ⇒ `BadRequestException: "The request count exceeds the maximum request count allowed : 180"` (R9) |

---

## A. Objectives & Non-Objectives

### A.1 Objetivos

1. Continuación de paginación real mediante **cursor opaco stateless** (D-27), sustituyendo el `$skip` a ciegas.
2. **Totales** vía `$inlinecount` (D-31).
3. **`batch_get`** GET-only sobre `$batch` fijo vía `odata-batch`, techo 180 (D-28, DS-P2-01, DS-P2-04).
4. **`entityAllowlist`** local con semántica D-15 (D-30).
5. **Salida `json|xml`** por llamada con campos nativos (D-32).
6. **OAuth 2.0 como alternativa** de Basic Auth, con verificación previa del grant y gate D-24 (D-29, DS-P2-02).

### A.2 Non-Goals (explícito)

- **Familia v4** (protocolo v4, selector, fallback v2/v4): fuera por D-26 hasta tenant con v4 verificado. El fallback pierde sentido sin dos protocolos activos.
- **Toda escritura sobre datos**, sin excepciones nuevas: el sobre `$batch` GET-only es la única excepción POST de datos (DS-P2-04); ni `batch_get` ni ningún otro mecanismo aceptan internos no GET, ChangeSets o method tunneling.
- **Function imports / operaciones custom**: siguen excluidos (D-25 PRD.md). El inventario real (67) refuerza la exclusión; su reapertura exigiría verificación individual de ausencia de efectos secundarios + allowlist explícita.
- **Normalización de esquema**: nunca (D-19 PRD.md).
- **Auto-paginación o combinación de páginas**: nunca (D-18 PRD.md); el cursor es siempre explícito, una página por llamada.
- **Caché de respuestas en disco / persistencia**: nunca (D-09 PRD.md). Solo memoria transitoria de proceso (secreto HMAC, token OAuth).
- **Publicación open source / licencia / visibilidad**: sigue diferido (D-10/Q-7 PRD.md). Este PRD no autoriza publicación.
- **Plataformas distintas de Linux y clientes distintos de OpenCode**: sin cambios (D-04 PRD.md).
- **Re-litigar el MVP**: FR-01..FR-15 y todas las restricciones negativas del PRD.md siguen vigentes tal cual (FR-35).

---

## B. Architecture & Trust Boundaries

Flujo por petición ( deltas sobre PRD.md B.1; todo lo no mencionado hereda del MVP ):

```
Host/Cliente MCP (OpenCode) ── STDIO ──▶ Servidor MCP ssff-mcp (TypeScript)
        │
        ├─ [NUEVO] Validador de cursor: HMAC (secreto efímero de proceso),
        │          binding {entorno, entityPath, opciones}; inválido/cruzado/previo-a-reinicio ⇒ rechazo
        ├─ [NUEVO] Allowlist de entidades (config; ausente ⇒ denegada; $metadata nunca filtrado)
        ├─ Constructor de URL OData v2 (heredado; + $inlinecount)
        ├─ [NUEVO] Selector de salida: json (defecto) | xml (Accept application/xml)
        ├─ [NUEVO] batch_get: sobre multipart GET-only (odata-batch, fetch inyectado)
        │          → POST ÚNICO al $batch fijo; techo 180 items; techo total 1.000 registros
        └─ [NUEVO] OAuth: token manager con caché transitoria por entorno
                   → POST solo al tokenUrl fijo (TLS); Basic Auth sigue disponible
        ▼
SAP SuccessFactors OData v2 (api2.successfactors.eu) ── respuesta ──▶ saneamiento → llamador
```

Límites de confianza: T1–T5 de PRD.md B.2 siguen vigentes y se extienden:

- **T1** (modelo no confiable para política): el cursor llega del modelo pero **solo el servidor lo genera y valida** (HMAC + binding); `batch_get` acepta items solo en la gramática GET de `query_entity`; `output` solo selecciona representación, nunca alcance.
- **T3** (red): nueva clase de destino POST `$batch` fijo (DS-P2-04); token POST solo a `tokenUrl` fijo con TLS; redirects mismo-host https (heredado).
- **T5** (cursor): el sobre firmado garantiza que un cursor no puede alterar host, método, base URL, entorno, entidad ni consulta; su vida termina con el proceso.

---

## C. Data Schema & State Machine

### C.1 Config (`~/.config/ssff-mcp/config.json`) — ampliación ilustrativa (esquema final Q-1 PRD.md sigue abierto en lo no confirmado)

```jsonc
{
  "environments": {
    "<alias>": {
      "baseUrl": "https://api2.successfactors.eu",
      "auth": { "type": "basic", "username": "<api-user>", "password": "<secreto>" }
      // Fase 2 OAuth (D-29): alternativa POR ENTORNO, no sustitución:
      // "auth": { "type": "oauth", "tokenUrl": "https://<token-endpoint-fijo>", "<campos según grant verificado>": "..." }
    }
  },
  "entityAllowlist": [                      // D-30; opcional: ausente ⇒ sin allowlist (todo lo que la cuenta pueda leer)
    { "entity": "User" },                   // protocols omitido ⇒ ambos (hoy: v2)
    { "entity": "JobRequisition", "protocols": ["v2"] }
  ]
}
```

Notas: `auth.type` pasa de `"basic"` literal a `"basic" | "oauth"` (oauth solo tras FR-32). Clave privada OAuth inline en claro **solo tras el gate D-24** (permisos 600, nunca Git, revisión documentada). Sin entorno por defecto (D-02 heredado).

### C.2 Cursor opaco (D-27)

```
cursor = base64( payloadUtf8 || "." || hex(HMAC-SHA256(secretoEfímero, payloadUtf8)) )
payload = { v: 1, env: "<alias>", path: "<entityPath>", options: {…}, skiptoken: "<del servicio>" }
```

- `skiptoken`: cadena opaca devuelta por el servicio en `__next`; el MCP **nunca** la interpreta ni reescribe (ventanas de filas; ver A-P2-3).
- Secreto: aleatorio por arranque del proceso, solo en memoria. Reinicio ⇒ todos los cursores anteriores inválidos (comportamiento documentado, no error).
- Validación por llamada: firma correcta + `env` coincide con el entorno solicitado + `path`/`options` coinciden con la llamada en curso. Cualquier desajuste ⇒ rechazo saneado.

### C.3 Máquina de estados

Sin cambios respecto a PRD.md C.2: procesamiento por petición, sin estado de negocio. Los únicos estados transitorios de proceso son: caché TTL de nombres de `$metadata` (MVP), **secreto HMAC del cursor** y **token OAuth por entorno** (DS-P2-02). Todos mueren con el proceso; ningón disco.

---

## D. Security & Threat Modeling

Amenazas nuevas (las de PRD.md D. siguen vigentes):

| Amenaza | Vector | Mitigación | Trazado |
|---|---|---|---|
| Cursor falsificado/modificado | El modelo fabrica o edita un cursor (skiptoken en claro es trivial de inventar) | HMAC con secreto efímero; fallo de firma ⇒ rechazo saneado antes de despacho | D-27, DS-10 |
| Cursor cruzado | Cursor emitido para consulta A usado en consulta B u otro entorno | Binding {env, path, options} dentro del payload firmado; desajuste ⇒ rechazo | D-27 |
| Contrabando de escritura en batch | Item incrustado con método no GET, ChangeSet, o cabeceras de túnel | El MCP construye el sobre íntegro desde su propia gramática GET; item no conforme ⇒ **lote completo rechazado antes del despacho**; la librería nunca recibe métodos del modelo | D-28, DS-P2-04, FR-29 |
| Bomba de contexto vía batch | 180 items × 1.000 registros = 180.000 registros a contexto | Techo TOTAL 1.000 registros por respuesta batch_get (DS-P2-01) | D-18, DS-P2-01 |
| Fuga de token OAuth | Token en logs, errores o respuestas | Token solo en memoria de proceso; logs de metadatos (heredado); errores saneados sin tokens | DS-P2-02, D-20 |
| tokenUrl arbitrario | POST de token a endpoint aportado por el modelo | `tokenUrl` fijo por entorno en config; nunca input; TLS obligatorio | D-13/D-29, DS-07 |
| Allowlist bypass | Consulta a entidad no listada; path con navegación que esquive la lista | Validación del primer segmento (heredada del MVP) + allowlist sobre EntitySet; navegación posterior solo tras entidad listada | D-30, FR-28 |
| Clave privada OAuth en disco | Config en claro | Gate D-24 obligatorio antes de implementar; permisos 600; nunca Git; declaración de texto plano en README (heredada FR-03) | D-24, D-29 |

---

## E. Success Metrics & Acceptance Criteria

Métricas (resultado, no actividad):

- **Cero** operaciones no GET despachadas salvo las dos clases DS-P2-04 (suite negativa extendida con batch).
- **Cero** secretos/tokens/URLs sensibles/datos personales en logs y errores (heredado + token OAuth).
- Continuación real: la página 2 de `User` vía cursor devuelve exactamente la ventana `startRow=1000` del servicio (no `$skip`).
- `batch_get` nunca excede 180 items ni 1.000 registros totales.

### E.1 Criterios positivos

1. `query_entity` con continuación real devuelve cursor válido; la llamada explícita siguiente con ese cursor devuelve la página siguiente del servicio (ventana skiptoken). [FR-25]
2. `inlinecount` devuelve el total real (`User` = 96.577 en `clecesa`). [FR-26]
3. `output: "xml"` devuelve el cuerpo crudo del servicio con `Accept: application/xml`. [FR-27]
4. Con allowlist configurada: entidad listada permitida, ausente denegada, `$metadata` sin filtrar; entrada solo-v4 denegada en esta fase. [FR-28, DS-P2-03]
5. `batch_get` con N items GET válidos ejecuta **un** POST al `$batch` fijo y responde por elemento en orden. [FR-29]
6. OAuth (condicional): grant verificado contra el tenant ⇒ flujo funcional con `tokenUrl` fijo y caché transitoria; grant NO verificado ⇒ bloqueado con informe, sin implementación a ciegas. [FR-32]

### E.2 Criterios negativos (fail-closed)

1. Cursor manipulado, de otra consulta/entorno, o previo a un reinicio del servidor ⇒ rechazo saneado; nunca despacha. [FR-25]
2. `batch_get` con cualquier item no GET / ChangeSet / fuera de gramática ⇒ **lote completo** rechazado antes del despacho de red. [FR-29]
3. Respuesta `batch_get` jamás supera 1.000 registros totales ni 180 items. [DS-P2-01, FR-29/30]
4. `entityAllowlist` presente + entidad ausente ⇒ denegada; `$metadata` nunca filtrado. [FR-28]
5. Token OAuth nunca aparece en logs, errores ni respuestas; solo en memoria de proceso. [FR-33]
6. POST jamás dirigido a ningún destino distinto de `$batch` fijo (datos) y `tokenUrl` fijo (auth). [DS-P2-04]
7. Todos los criterios negativos del MVP (PRD.md E.2.1..12) siguen pasando sin cambios. [FR-35]

### E.3 Enfoque de verificación

V1 automatizada (suite negativa/positiva extendida) es la base, misma condición no-gate que PRD.md E.3. La verificación empírica del techo 180 (Q-P2-1) y del grant OAuth (Q-P2-2) se ejecutan en implementación.

---

## Requisitos funcionales (FR-25..FR-35; sustituyen a FR-16..FR-24 de PRD.md)

- **FR-25** — `query_entity` DEBE (MUST) devolver un cursor de continuación opaco cuando el servicio entregue `__next`, y DEBE (MUST) aceptarlo en una llamada explícita posterior para devolver exactamente la siguiente página del servicio. El cursor DEBE (MUST) ser un sobre firmado HMAC con secreto efímero de proceso, ligado a entorno+entityPath+opciones, sin TTL de reloj y sin almacenamiento servidor. Cursor manipulado, cruzado o previo a reinicio ⇒ rechazo saneado pre-despacho. Nunca MUST NOT inventarse continuación inexistente. Fuente: D-27; sustituye FR-23.
- **FR-26** — `query_entity` DEBE (MUST) aceptar la opción `inlinecount` (`allpages`) y devolver `totalCount` cuando el servicio provea `__count`; valor crudo sin reescritura. Fuente: D-31, sonda 2026-10-01.
- **FR-27** — `query_entity` DEBE (MUST) aceptar `output: "json" (defecto) | "xml"`; xml = cuerpo crudo del servicio con `Accept: application/xml`; campos nativos siempre, sin normalización. Fuente: D-32; sustituye FR-24 (ámbito v2).
- **FR-28** — El servidor DEBE (MUST) aplicar `entityAllowlist` cuando exista en config: entidad ausente ⇒ denegada; `protocols` opcional por entrada (omisión = ambos; entradas sin v2 disponible ⇒ denegadas en esta fase); `$metadata` NO MUST NOT filtrarse jamás. Fuente: D-30, DS-P2-03; sustituye FR-19 (ámbito v2).
- **FR-29** — `batch_get` DEBE (MUST) aceptar exclusivamente items conformes a la gramática GET de `query_entity` (mismo validador), construir un sobre multipart **sin ChangeSets** y despacharlo como **único POST al `$batch` fijo** del entorno. Cualquier item no conforme ⇒ lote completo rechazado antes del despacho. Máximo **180 items** por lote. Fuente: D-28, R9; sustituye FR-17.
- **FR-30** — La respuesta de `batch_get` DEBE (MUST) ser por elemento, en el orden de envío, con estado por elemento; el total agregado de registros devueltos NO DEBE (MUST NOT) exceder 1.000, con independencia del número de items. Fuente: DS-P2-01, D-18.
- **FR-31** — La construcción/parseo del sobre multipart DEBE (MUST) delegarse a `odata-batch` (MIT) con transporte `fetch` inyectado por ssff-mcp; la superficie de escritura de la librería NO DEBE (MUST NOT) ser alcanzable desde ningún input del modelo. Fuente: D-28.
- **FR-32** — OAuth 2.0 PODRÁ (MAY) añadirse como `auth.type: "oauth"` por entorno **solo tras** verificación del grant contra el tenant (candidato SAML 2.0 Bearer Assertion, A-4) con colaboración de admin, y **solo tras** la revisión de D-24 sobre almacenamiento de clave privada. Flujo verificado (E2): paso 1 `POST {idpUrl}` form-urlencoded `{client_id, user_id, token_url, private_key}` → aserción SAML base64 firmada por SAP; paso 2 `POST {tokenUrl}` form-urlencoded `{client_id, grant_type=urn:ietf:params:oauth:grant-type:saml2-bearer, company_id, assertion}` → `{access_token, expires_in}`. `user_id` SIN sufijo de compañía en el paso 1; `company_id` va en el paso 2; `token_url` del paso 1 debe coincidir EXACTAMENTE con `tokenUrl` (SAP lo embebe en la `AudienceRestriction`). Endpoints fijos por config, TLS, POST únicamente ahí (DS-P2-05); sin verificación live ⇒ bloqueado para decisión del usuario. Fuente: D-29, E2, DS-P2-05; sustituye FR-16.
- **FR-33** — El access token OAuth DEBE (MUST) mantenerse solo en caché transitoria en memoria **por entorno** (vida del proceso), con: single-flight (una sola adquisición concurrente por entorno), margen de caducidad `min(60s, 10% de expires_in)`, validación estricta del payload (rechazar 200 con cuerpo HTML/JSON sin `access_token` o con `expires_in <= 0`), reintento limitado (3 intentos con backoff) y **invalidación + un único reintento** ante 401 en una lectura de datos. NEVER en disco, logs, errores o respuestas. Fuente: DS-P2-02, E2.
- **FR-34** — v4, selector de protocolo y fallback NO DEBEN (MUST NOT) implementarse en esta fase (evidencia 404, D-26). Su reapertura exige tenant con v4 verificado y nueva decisión del usuario. Fuente: D-26; sustituye FR-18/FR-20/FR-21.
- **FR-35** — Todos los requisitos y restricciones del MVP (PRD.md FR-01..FR-15, E.2) permanecen vinculantes sin cambios. Fuente: herencia.

---

## OPEN QUESTIONS

1. **Q-P2-1** — Verificación empírica del techo 180 (R9 es documentación web; un probe real de `$batch` es un POST al tenant y se ejecutará en implementación con lote GET-only de prueba).
2. **Q-P2-2** — ~~Verificación live de OAuth~~ **CERRADA (2026-10-01)**: flujo idp→token→lectura con Bearer verificado en vivo desde ssff-mcp contra `api2.successfactors.eu` (entorno PROD, `query_entity User` devuelve registros). Hallazgos operativos: (a) `private_key` se envía **verbatim**, tal como la exporta/almacena el maintainer (valor compuesto `base64(clave###compañía)/base64(...)`); decodificarlo o retranscribirlo rompe la clave; (b) SAP responde los errores de `/oauth/*` con `{errorHttpCode, errorMessage}`, no con RFC 6749; (c) `/oauth/idp` responde 500 "Invalid X.509 private key" ante clave inválida y el token endpoint 401 "Unable to verify the signature" ante clave que no es la pareja del `client_id`.
3. **Q-P2-3** — Compatibilidad efectiva `odata-batch` ↔ formato `$batch` de este tenant (la librería nació de uso real; validación en integración).

## ASSUMPTIONS

- **A-P2-1** — `odata-batch` v2.x produce/parsea el formato multipart exacto que espera `api2.successfactors.eu` (librería del maintainer, origen en uso real; Q-P2-3 lo valida).
- **A-P2-2** — El techo 180 de R9 aplica a este tenant tal cual (verificación empírica Q-P2-1).
- **A-P2-3** — Los `$skiptoken` son ventanas de filas estables a corto plazo (evidencia base64); ante datos volátiles la ventana puede desplazarse — comportamiento documentado, no error.
- **A-P2-4** — ~~SAML 2.0 Bearer Assertion sigue siendo el grant candidato~~ **Verificado a nivel de flujo (E2, v0.2)**: grant SAML 2.0 Bearer vía helper `/oauth/idp` de SAP. Pendiente solo la verificación live (Q-P2-2).
- **Revisión D-24 (realizada, v0.2)** — Almacenamiento de la clave privada: inline en claro en `~/.config/ssff-mcp/config.json` (permisos 600, nunca Git, declaración de texto plano en README). Con el flujo helper-IdP, la clave **además transita por HTTPS al `idpUrl`** en cada adquisición de aserción (DS-05) — comportamiento idéntico al de la implementación de producción de referencia, aceptado como tradeoff temporal. Mitigaciones vigentes: TLS obligatorio, endpoints fijos por config, saneamiento que jamás incluye la clave en errores/logs. La opción de firma local (clave nunca sale del proceso) queda registrada como mejora futura fuera de esta fase.

## Referencias

- **R1–R8** — heredadas de PRD.md.
- **R9** — SAP SuccessFactors OData API, límite de `$batch`: máximo **180** peticiones por lote; exceso ⇒ `BadRequestException: "The request count exceeds the maximum request count allowed : 180"` (verificado en documentación SAP vía web, 2026-10-01).
- **E1** — Sondas en vivo del 2026-10-01 contra `clecesa` (sección 1): v4 404; 658 EntitySets / 67 FunctionImports; `__next` con `$skiptoken` base64 `{"startRow":1000,"endRow":2000}`; `$inlinecount` 200 con `__count=96577`; `$metadata` 7,5 MB exigiendo `Accept: application/xml`.
- **E2** — Flujo OAuth verificado el 2026-10-01 mediante revisión de la implementación de producción del maintainer en su entorno laboral (revisión de flujo, sin copia de código; detalle protocolar completo en FR-32/FR-33/DS-P2-05). Hechos clave: grant `urn:ietf:params:oauth:grant-type:saml2-bearer`; **sin firma XML local** (helper `POST /oauth/idp` de SAP devuelve la aserción firmada a cambio de `{client_id, user_id, token_url, private_key}` form-urlencoded); `expires_in` real observado: 86400s; riesgo operativo documentado: SAP puede devolver **200 con cuerpo HTML de error** (validación estricta obligatoria) y exige **whitelisting de IP** en Admin Center (Password & Login Policy Settings → API login exceptions). La alternativa RFC 7522 (firma local de la aserción con node:crypto, clave nunca sale del proceso) queda registrada como opción futura, fuera de esta fase.

---

*Fin del documento. PRD Fase 2 en estado DRAFT v0.1: registra intención y no autoriza implementación, inicialización adicional de Git ni publicación.*
