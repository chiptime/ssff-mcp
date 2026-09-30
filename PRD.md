# PRD — ssff-mcp: Servidor MCP de solo lectura para SAP SuccessFactors (OData v2 en MVP; OData v4 en Fase 2)

| Campo | Valor |
|---|---|
| Estado | **DRAFT v0.4** — borrador; documenta intención, **no autoriza implementación** |
| Fecha | 2026-09-30 |
| Fuente de decisiones | Registro de decisiones confirmadas (D-01..D-25, confirmación del usuario) |
| Idioma | Español neutro profesional; identificadores y términos de código en inglés |

| Versión | Notas |
|---|---|
| v0.2 | Consolidación inicial (D-01..D-13). |
| v0.3 | Ruta exacta de configuración (D-03); despliegue MVP (Linux/STDIO/OpenCode/TypeScript, D-04/D-21); preparación open source (D-22); cuenta técnica compartida (D-23); saneamiento de errores (D-20); techo de paginación 1.000/una página (D-18); y alcance de Fase 2: OData v4 (D-14), allowlist común con `protocols` (D-15), fallback acotado (D-16), opciones de consulta (D-17), cursor opaco, salida JSON/XML con campos nativos (D-19), OAuth con `tokenUrl` fijo (D-12/D-13) y almacenamiento temporal en claro de la clave (D-24). Nuevas evidencias R5, R7 y R8. |
| v0.4 | Grill de alcance cerrado: comportamiento de fallback, allowlist y metadata, consultas crudas, cursor/paginación, salida JSON/XML, cuenta técnica compartida, plantilla/documentación open-source-ready y revisión futura de operaciones OData custom; ver D-14..D-25. Verification approach marked as proposal, not delivery gates. |

Este documento consolida decisiones de producto ya confirmadas en un PRD. No sustituye a la fase de diseño/planificación (SDD): ninguna parte de este documento autoriza a escribir código, inicializar Git ni publicar nada. Las palabras clave **MUST / MUST NOT / SHOULD / MAY** se interpretan según RFC 2119.

Convención de lectura:

- **D-xx** — decisión confirmada por el usuario. Cada una se etiqueta **MVP** o **Fase 2**.
- **DS-xx** — implicación derivada (seguridad/arquitectura) obligatoria por trazabilidad, no decidida directamente por el usuario.
- **ASSUMPTION (A-xx)** — supuesto técnico no verificado; no es decisión.
- **OPEN QUESTION (Q-xx)** — pregunta registrada y sin responder; no se responde ahora ni se adivina.
- La **Fase 2 no autoriza trabajo**: exige cerrar sus preguntas abiertas y, donde se indica, especificación propia.

---

## 0. Registro de decisiones (ledger)

### 0.1 Decisiones confirmadas por el usuario

| ID | Alcance | Decisión | Fuente |
|---|---|---|---|
| D-01 | MVP | Producto independiente: servidor MCP para las instancias SAP SuccessFactors (SSFF) del usuario. API objetivo del MVP: **OData v2 únicamente** (OData v4 se añade en Fase 2, D-14). | User confirmation |
| D-02 | MVP | Soporte de **múltiples entornos**. Cada petición indica el entorno seleccionado de forma explícita. Si no se especifica un entorno configurado, se **rechaza** la petición; nunca se elige uno en silencio. | User confirmation |
| D-03 | MVP | Fichero de configuración local por usuario en la ruta exacta **`~/.config/ssff-mcp/config.json`** (no `.config.json` como nombre de fichero). Vive fuera del repositorio y **nunca se confirma en Git**; cada usuario lo configura. El repositorio se prepara desde el MVP para una posible publicación open source: **plantilla de configuración sin secretos** (solo placeholders) y **documentación que explica la ruta y los campos**. Sin compromiso actual de publicar (D-10, D-22). Esquema final y nombre del fichero plantilla: OPEN QUESTION (Q-1). No incluye URLs de tenant, usuarios ni secretos reales. | User confirmation |
| D-04 | MVP | Cada usuario ejecuta el MCP en su propia máquina, **solo Linux en el MVP**; transporte **STDIO local**; **OpenCode como primer cliente objetivo**. | User confirmation |
| D-05 | MVP | `GET $metadata` **sin filtrado por allowlist** y lecturas **GET directas OData v2** sobre todas las entidades permitidas por la cuenta configurada en el origen. Todas las operaciones de datos son de solo lectura; se exige una cuenta de **mínimo privilegio y solo lectura en el origen** como defensa en profundidad. | User confirmation |
| D-06 | MVP | **Sin herramienta de método arbitrario ni HTTP crudo**; sin input de URL cruda, host ni base URL. Todo método no GET sobre recursos de datos OData se rechaza **antes del despacho**. Basic Auth es el método de autenticación del MVP, por entorno, **solo sobre HTTPS**. | User confirmation |
| D-07 | MVP | Excluidas **todas** las operaciones de escritura: POST/creación, `upsert`, PUT, PATCH, DELETE — y **MERGE** (verbo de escritura en OData v2, incluido aunque el usuario no lo listara). **En el MVP no existe ninguna excepción de método no GET.** En Fase 2 existen exactamente dos clases de POST acotadas: autenticación al `tokenUrl` fijo (D-13) y el sobre al `$batch` fijo con todas las peticiones internas GET (D-08); el flujo OAuth puede repetir solicitudes de token según su ciclo de vida, pero ninguna clase permite escribir datos. Se deniegan cabeceras de túnel/sobreescritura de método (`X-HTTP-Method`, etc.). | User confirmation |
| D-08 | Fase 2 | `batch_get` y allowlist de entidades (allowlist común; ver D-15) se aplazan a la **Fase 2**; el MVP **no** tiene allowlist de entidades. `batch_get` se permite **solo si cada petición incrustada es GET**; el POST externo va únicamente al `$batch` fijo; **sin ChangeSets** y **sin POST genérico**. Sus requisitos detallados requieren seguimiento propio (Q-8). | User confirmation |
| D-09 | MVP | El MCP **no persiste** datos de respuesta ni credenciales. Los logs de operación contienen **solo metadatos**; los errores devueltos al modelo se **sanean** a código/mensaje y omiten secretos, tokens, URLs/cadenas de consulta cuando son sensibles, y datos personales. | User confirmation |
| D-10 | MVP | Posible publicación open source: **no es un compromiso**. Licencia, visibilidad del repositorio y política de contribución/release quedan diferidas hasta que el usuario decida; este PRD **no autoriza publicación** (Q-7). | User confirmation |
| D-11 | Documento | Este PRD registra intención y **no autoriza implementación, inicialización de Git ni publicación**. | User confirmation |
| D-12 | Fase 2 | Alternativa **OAuth 2.0** además de Basic Auth. Candidato preliminar: OAuth 2.0 **SAML 2.0 Bearer Assertion**; **no** debe asumirse que el grant genérico `client_credentials` está soportado hasta verificar documentación oficial específica del tenant. | User confirmation; el grant concreto es supuesto (A-4, Q-6) |
| D-13 | Fase 2 | Se permite **POST de solo autenticación únicamente al** token endpoint fijo (`tokenUrl`) configurado una vez por entorno por cada usuario. El flujo OAuth puede repetir solicitudes de token según lo requiera su ciclo de vida; no se permite ningún otro destino o tipo de POST salvo el `$batch` GET-only de D-08. **TLS obligatorio** en el token endpoint. | User confirmation |
| D-14 | Fase 2 | Se añade **OData v4 junto a v2**. El LLM elige el protocolo preferido en cada llamada; v2/v4 **no** son una relación de reemplazo. | User confirmation |
| D-15 | Fase 2 | **Una allowlist común de entidades** para ambas versiones. Una entidad ausente de la lista se **deniega**. Cada entrada puede llevar una lista `protocols`; su omisión significa **ambos protocolos habilitados** (v2 y v4); `protocols: ["v2"]` permite solo v2. Claves JSON en inglés (`entity`, `protocols`) confirmadas (las claves en español anteriores eran ilustrativas). `$metadata` **nunca** se restringe por la allowlist. | User confirmation |
| D-16 | Fase 2 | **Fallback automático de versión** solo dentro del conjunto de protocolos permitidos para esa entidad, y solo por **incompatibilidad reconocible de servicio/entidad/feature de consulta o limitación de resultados**. Sin fallback ante errores de autenticación, errores de red, resultados vacíos válidos o errores ordinarios de sintaxis/consulta inválida. **No se reescriben valores crudos de consulta** para intentar que funcionen. Si el fallback tiene éxito: **una sola respuesta** (nunca combinación v2/v4) con `protocolUsed` y un `fallbackReason` saneado. | User confirmation |
| D-17 | Fase 2 | Los **valores crudos** de las opciones de consulta OData de lectura conocidas/permitidas pasan tal cual; los **nombres de opción desconocidos se rechazan**. La lista exacta por versión requiere verificación técnica y queda como OPEN QUESTION (Q-2). Los errores de sintaxis de `$filter` se devuelven como **errores OData saneados** para que el LLM los corrija; **sin reintento entre versiones** por errores de sintaxis. | User confirmation |
| D-18 | MVP (techo y página única) / Fase 2 (cursor) | Máximo **1.000 registros por llamada MCP**, **una sola página OData**, **nunca seguir next links automáticamente**. Una página posterior requiere **otra llamada MCP explícita** con un **cursor opaco** ligado a entorno, entidad, protocolo y consulta. Si no existe continuación, **no se inventa**. | User confirmation |
| D-19 | Fase 2 | La respuesta **preserva los campos nativos de SuccessFactors**; sin normalización de esquema v2/v4. La representación de salida la selecciona el LLM: **JSON por defecto, XML como alternativa**. | User confirmation |
| D-20 | MVP | Los resultados de error se **sanean** (código/mensaje); sin credenciales, tokens, datos personales ni detalles secretos de consulta. Se mantiene en Fase 2. | User confirmation |
| D-21 | MVP | Runtime **TypeScript** confirmado (se consideró Rust inicialmente; el estado de los SDK oficiales MCP inclinó la decisión, R8). Linux y OpenCode según D-04. | User confirmation |
| D-22 | MVP | Preparación open source desde el MVP: plantilla de configuración sin secretos y documentación de ruta y campos (ver D-03). Sin compromiso de publicación; licencia y visibilidad diferidas (D-10, Q-7). | User confirmation |
| D-23 | MVP (expectativa de despliegue) | La configuración local por usuario puede contener una **cuenta técnica compartida** de solo lectura de SuccessFactors del equipo del usuario. Es una **expectativa de despliegue, no una restricción universal del producto**. El usuario acepta que la auditoría del origen **atribuya a la cuenta técnica compartida** y no a cada usuario local. No elimina el requisito de mínimo privilegio/solo lectura (DS-02). | User confirmation |
| D-24 | Fase 2 (temporal) | Toda la configuración, **incluida una clave privada** si el flujo OAuth verificado la requiere, se almacena **inline en el JSON de configuración local**. El usuario lo acepta como **tradeoff temporal**, entendiendo que queda **en claro en disco** salvo cifrado del SO; se exigen permisos restrictivos de fichero, **nunca Git**, y **revisión antes de implementar OAuth**. | User confirmation |
| D-25 | MVP (exclusión) / Fase 2 (revisión) | Las operaciones de servicio OData custom / **function imports** invocables por GET quedan **excluidas del MVP** y se revisarán en Fase 2 antes de permitir alguna. | User confirmation |

### 0.2 Implicaciones derivadas (seguridad/arquitectura)

Derivadas de las decisiones de producto y de las referencias técnicas aplicables (R1–R8). Se listan aparte para que los requisitos puedan trazarse también a ellas.

| ID | Implicación | Derivada de |
|---|---|---|
| DS-01 | HTTPS obligatorio en todos los endpoints de SuccessFactors (Basic Auth no es confidencial sin TLS). No registrar cabeceras Authorization ni secretos. No seguir redirects a un host no configurado. Los inputs de las herramientas no pueden sobrescribir scheme, host ni base URL. | D-06, R3 |
| DS-02 | Cada cuenta de SuccessFactors usada debe ser de **mínimo privilegio y solo lectura en el origen** (roles del tenant), con independencia de la aplicación que hace el MCP. Es condición de aceptación; la configuración de roles del tenant debe verificarse durante la implementación. La forma de cuenta técnica compartida (D-23) no relaja este requisito. | D-05, D-06, D-23 |
| DS-03 | `~/.config/ssff-mcp/config.json` almacena secretos en texto plano salvo que el SO proteja el fichero; en Fase 2 incluye temporalmente una clave privada (D-24). Acceso restringido por usuario; ignorado por Git **antes** de que exista repositorio o publicación; «ignorar por Git» no es cifrado y no debe describirse como tal. El almacenamiento de la clave debe revisarse antes de implementar OAuth. | D-03, D-24 |
| DS-04 | No exponer operaciones de servicio arbitrarias por GET: OData v2 permite operaciones custom por GET/POST, y su especificación indica que solo deberían permitirse por GET si no tienen efectos secundarios. El MVP solo permite `$metadata` y lecturas de entidades/recursos; las operaciones custom y function imports quedan fuera salvo verificación individual de solo lectura y allowlist explícita (D-25). | D-07, D-25, R1 |
| DS-05 | Sin servidor/escucha HTTP; solo transporte STDIO entre host y servidor MCP. | D-04 |
| DS-06 | Los prompts del modelo **no son un control de seguridad**. La frontera de solo lectura se impone en el código del servidor MCP y se refuerza con permisos de solo lectura en el origen. | D-06, DS-02 |
| DS-07 | La excepción OAuth de Fase 2 es un POST exclusivamente al `tokenUrl` fijo configurado por entorno, con TLS obligatorio. No es una operación de datos OData, no amplía la superficie de métodos para consultas y no admite URLs aportadas por el modelo. | D-13, FR-16, R6 |
| DS-08 | La Fase 2 define **exactamente dos clases/destinos** POST acotados: (a) POST de autenticación al `tokenUrl` fijo, repetible según el ciclo OAuth; (b) sobre POST al `$batch` fijo con todas las peticiones internas GET y sin ChangeSets. Cualquier otro método no GET sigue rechazado antes del despacho y nunca existe un POST genérico. En el MVP no hay excepciones. | D-07, D-08, D-13 |
| DS-09 | El fallback de Fase 2 no amplía alcance: solo dentro de los protocolos permitidos de la entidad, nunca ante errores de autenticación/red o resultados vacíos válidos, y nunca reescribiendo valores de consulta. Debe devolverse una única respuesta con razón saneada. El fallback no puede convertirse en un oráculo de reintentos. | D-16 |
| DS-10 | El techo de 1.000 registros y la página única se aplican **en el MCP con independencia del comportamiento real del servicio** (defensa en profundidad). El cursor de Fase 2 es opaco, validado por el servidor y ligado a entorno+entidad+protocolo+consulta; no puede alterar host, método ni base URL. | D-18, R5, R7 |
| DS-11 | Los nombres de opciones de consulta desconocidos se rechazan antes del despacho; los valores crudos pasan solo para opciones de lectura permitidas; los errores del servicio se devuelven saneados. | D-17, R1 |

---

## 1. Context & Problem

El usuario necesita consultar varias instancias de SAP SuccessFactors mediante asistentes de IA integrados con MCP (Model Context Protocol), con OpenCode como primer cliente objetivo sobre Linux. El producto debe facilitar el cambio explícito entre entornos y evitar que la superficie de consulta pueda invocar operaciones de escritura o exponga credenciales. Un cliente HTTP genérico sin una frontera de solo lectura podría permitir escrituras accidentales o ampliar el acceso más allá del entorno previsto; el MCP se diseña para reducir esos riesgos.

Este PRD define un servidor MCP **local, de solo lectura**, escrito en TypeScript, que expone un conjunto mínimo y controlado de herramientas de lectura OData v2 (MVP) sobre los entornos configurados —y OData v4 como ampliación de Fase 2—, con rechazo por defecto de todo lo que no sea lectura verificada.

Alcance del producto según D-01, D-04, D-05, D-14 y D-21: instancias SSFF del propio usuario; OData v2 en el MVP y v2+v4 en Fase 2; lecturas directas amplias por entidad (limitadas por los permisos de la cuenta del tenant); ejecución local Linux con STDIO; OpenCode como primer cliente.

---

## A. Objectives & Non-Objectives

### A.1 Objetivos

1. Servidor MCP ejecutado localmente (STDIO, Linux, TypeScript) que exponga lecturas OData v2 a OpenCode como primer cliente (D-01, D-04, D-21) y OData v4 en Fase 2 (D-14).
2. Garantizar la frontera de **solo lectura en el propio MCP**, sin depender de la buena conducta del modelo ni del prompt (D-06, DS-06).
3. Soportar múltiples entornos con selector explícito por petición y comportamiento *fail-closed* (D-02).
4. Mantener credenciales en un único fichero local por usuario, `~/.config/ssff-mcp/config.json`, fuera del repositorio y nunca en Git (D-03, DS-03).
5. Minimizar la superficie de datos: sin persistencia de respuestas ni credenciales; logs limitados a metadatos de operación; errores devueltos saneados (D-09, D-20).
6. Preparar el repositorio para una posible publicación open source desde el MVP: plantilla de configuración sin secretos y documentación de ruta y campos, sin compromiso de publicación (D-22, D-10).
7. Acotar la paginación: máximo 1.000 registros por llamada, una sola página OData, sin seguimiento automático de next links (D-18).

### A.2 Non-Goals (explícito)

Lo siguiente está **fuera de alcance** y no se deduce «por omisión»: se declara.

- **Toda operación de escritura sobre recursos de datos**: POST/creación, `upsert`, PUT, PATCH, DELETE y MERGE (D-07). En el MVP no hay ninguna excepción de método no GET; en Fase 2 las **únicas** excepciones POST son el token endpoint fijo de autenticación (D-13) y el sobre `$batch` con todas las peticiones internas GET (D-08); ninguna permite escribir datos.
- **Operaciones de servicio personalizadas / function imports** por GET u otro método, sin verificación individual de ausencia de efectos secundarios ni allowlist explícita futura (D-07, D-25, DS-04).
- **Herramienta genérica de HTTP crudo / método arbitrario / URL-host-base URL arbitrarios** (D-06).
- **Escucha HTTP / transporte remoto**: solo STDIO local (D-04, DS-05).
- **Plataformas distintas de Linux y clientes distintos de OpenCode durante el MVP** (D-04, D-21); la portabilidad posterior no se descarta, pero no está en el alcance del MVP.
- **OData v4, allowlist de entidades, fallback de versión, cursor de paginación, selección JSON/XML y `batch_get`**: fuera del MVP; son alcance de Fase 2 (D-08, D-14..D-19).
- **Normalización de esquema v2/v4 y fusión de resultados entre protocolos**: nunca; la respuesta preserva campos nativos y el fallback devuelve una única respuesta (D-16, D-19).
- **Auto-paginación**: seguir next links automáticamente, combinar páginas o inventar continuaciones (D-18).
- **Reescritura de valores de consulta** para intentar que funcionen en otra versión (D-16).
- **Persistencia duradera o historial** de respuestas (D-09). El comportamiento de cualquier caché transitoria queda por definir.
- **Métodos de autenticación distintos de Basic Auth** para el MVP; OAuth 2.0 es Fase 2 (D-12). Asumir el grant genérico `client_credentials` sin verificación por tenant tampoco es objetivo (A-4, Q-6).
- **Publicación open source sin decisión del usuario**: licencia, visibilidad y momento quedan diferidos; este PRD no autoriza publicación (D-10, D-22, Q-7).

---

## B. Architecture & Trust Boundaries

### B.1 Flujo (por petición, sin estado)

```
Host/Cliente MCP (OpenCode, primer cliente objetivo; Linux local)
        │  STDIO (transporte local; sin escucha HTTP)
        ▼
Servidor MCP ssff-mcp (TypeScript)
        │  herramientas de solo lectura (propuesta: get_metadata, get_entity/query_entity)
        ▼
Resolvedor de entorno
        │  selector de entorno explícito → ~/.config/ssff-mcp/config.json
        │  (local por usuario, fuera del repositorio, nunca en Git)
        │  entorno ausente/desconocido ⇒ rechazo (fail-closed, sin fallback)
        ▼
[Fase 2] Selector de protocolo (v2/v4 según preferencia del LLM)
        │  allowlist común de entidades (ausente ⇒ denegada; `protocols` por entrada)
        │  fallback acotado solo dentro de los protocolos permitidos
        ▼
Constructor de URL OData
        │  scheme/host/base URL fijados por la configuración del entorno;
        │  los inputs de la herramienta no pueden sobrescribirlos
        │  [Fase 2] valores crudos de opciones de consulta conocidas;
        │  nombres de opción desconocidos ⇒ rechazo
        ▼
Cliente HTTPS + Basic Auth (MVP) / [Fase 2] Bearer token
        │  [Fase 2] token OAuth: POST de solo autenticación al tokenUrl fijo configurado
        │  solo TLS; sin redirects a hosts no configurados
        │  una sola página OData por llamada; techo de 1.000 registros;
        │  nunca seguir next links automáticamente
        ▼
SAP SuccessFactors (OData v2; [Fase 2] también OData v4)
        │  respuesta (o error)
        ▼
Saneamiento de errores y metadatos de log → retorno al llamador (sin persistencia)
        │  errores saneados a código/mensaje (sin secretos, tokens, URLs/queries
        │  sensibles ni datos personales)
        │  [Fase 2] protocolUsed + fallbackReason saneado tras fallback con éxito
        │  [Fase 2] salida con campos nativos: JSON (defecto) / XML (alternativa)
```

### B.2 Límites de confianza

| # | Frontera | Confianza |
|---|---|---|
| T1 | Host/Cliente MCP ↔ servidor MCP (STDIO local) | El host y el modelo **no son de confianza** para política: sus inputs nunca determinan método HTTP, host, scheme ni base URL (D-06, DS-01, DS-06). En Fase 2 el LLM elige el protocolo preferido y la representación de salida, pero siempre **dentro** de lo permitido por configuración y allowlist (D-14, D-15, D-19). |
| T2 | Servidor MCP ↔ `~/.config/ssff-mcp/config.json` (sistema de ficheros local) | Fichero local por usuario, texto plano, permisos restrictivos, fuera del repositorio y excluido de Git antes de que exista repo o publicación; en Fase 2 puede contener temporalmente una clave privada (D-03, D-24, DS-03). La plantilla del repositorio no contiene secretos (D-22). |
| T3 | Servidor MCP ↔ SuccessFactors (red, Internet) | Solo HTTPS con Basic Auth (R3, DS-01); en Fase 2, cada solicitud/renovación de token OAuth usa POST únicamente al `tokenUrl` fijo con TLS (D-13, R6); sin redirects fuera de hosts configurados. |
| T4 | Servidor ↔ logs/almacenamiento | Sin persistencia de cuerpos ni credenciales; logs solo con metadatos de operación (D-09). |
| T5 | Servidor ↔ cursor de paginación (Fase 2) | El cursor es opaco, generado y validado por el servidor, y está ligado a entorno+entidad+protocolo+consulta; el modelo no puede usarlo para alterar host, método, base URL ni alcance (D-18, DS-10). |

La frontera de solo lectura se aplica **dentro del servidor MCP** (rechazo previo a cualquier despacho de red) y se **refuerza en el origen** con una cuenta de tenant de mínimo privilegio y solo lectura (DS-02, DS-06).

---

## C. Data Schema & State Machine

### C.1 Esquema de datos: `~/.config/ssff-mcp/config.json` (ILUSTRATIVO — ASSUMPTION A-2)

La **ruta exacta está confirmada** (D-03: `~/.config/ssff-mcp/config.json`, fuera del repositorio, nunca en Git). El esquema final, los nombres de los alias de entorno y el nombre del fichero plantilla son OPEN QUESTION (Q-1). El siguiente esqueleto es ilustrativo, con valores de ejemplo sintéticos:

```json
{
  "environments": {
    "<alias-entorno>": {
      "baseUrl": "https://<host-del-tenant-configurado>",
      "auth": { "type": "basic", "username": "<usuario-api>", "password": "<secreto>" }
    }
  },
  "defaultEnvironment": null
}
```

Notas: `defaultEnvironment` es `null`/ausente por diseño — no existe entorno por defecto (D-02). La plantilla versionada en el repositorio usa **solo placeholders**, sin URLs de tenant, usuarios ni secretos reales, y la documentación explica la ruta y los campos (D-03, D-22); su nombre exacto es OPEN QUESTION (Q-1).

Ampliación ilustrativa de **Fase 2** (esquema final abierto, Q-1; semántica de la allowlist confirmada en D-15):

```json
{
  "environments": {
    "<alias-entorno>": {
      "baseUrl": "https://<host-del-tenant-configurado>",
      "auth": { "type": "basic", "username": "<usuario-api>", "password": "<secreto>" },
      "oauth": {
        "tokenUrl": "https://<token-endpoint-fijo>",
        "<campos-segun-grant-verificado>": "<p. ej., clave privada; formato pendiente de Q-6>"
      }
    }
  },
  "entityAllowlist": [
    { "entity": "CandidateLight" },
    { "entity": "JobRequisition", "protocols": ["v2"] }
  ]
}
```

Semántica confirmada de `entityAllowlist` (D-15): solo se permiten las entidades listadas — `CandidateLight` queda habilitada en ambos protocolos activados (v2 y v4, por omisión de `protocols`) y `JobRequisition` solo en v2. Las claves son en inglés (`entity`, `protocols`); las claves en español usadas inicialmente eran ilustrativas. `tokenUrl` es fijo por entorno y se configura una vez, nunca como argumento de una llamada MCP (D-13). El almacenamiento inline de la clave privada es un tradeoff temporal aceptado: permisos restrictivos, nunca Git, revisión antes de implementar OAuth (D-24, DS-03).

### C.2 Máquina de estados

**No se necesita máquina de estados.** El servidor procesa cada petición de forma independiente y sin estado de negocio: resuelve el entorno desde la configuración en cada llamada, ejecuta la lectura GET solicitada y devuelve el resultado sin persistencia duradera. En Fase 2, la selección de protocolo, la decisión de fallback y la resolución del cursor son decisiones **por petición**, no estados con transiciones. No hay sesiones ni transiciones entre estados de aplicación. El único estado externo es el fichero de configuración local, gestionado manualmente por el usuario. El ciclo de vida del cursor opaco es OPEN QUESTION (Q-5); cualquier almacenamiento transitorio o caché queda fuera de esta definición y debe resolverse en el diseño.

---

## D. Security & Threat Modeling

| Amenaza | Vector | Mitigación | Trazado |
|---|---|---|---|
| Interceptación de credenciales en tránsito | Basic Auth viaja codificada en Base64, no cifrada; sin TLS no es confidencial | HTTPS obligatorio; credenciales solo bajo TLS | R3, DS-01, FR-10 |
| Robo de credenciales en reposo | `~/.config/ssff-mcp/config.json` en texto plano en disco; en Fase 2 incluye temporalmente una clave privada | Permisos restrictivos por usuario; exclusión de Git antes de que exista repo; documentación que declara texto plano; revisión del almacenamiento de la clave antes de implementar OAuth | DS-03, D-24, FR-03 |
| Fuga por logs o errores devueltos | Cuerpos, secretos, queries completas o datos personales registrados o devueltos al modelo | Logs solo con metadatos de operación; errores saneados a código/mensaje, sin secretos, tokens, URLs/queries sensibles ni datos personales | D-09, D-20, FR-12, FR-14 |
| Escritura accidental vía prompt/inyección | El modelo pide crear/modificar/borrar | Métodos de escritura sobre OData se rechazan antes del despacho; MVP sin excepciones; Fase 2 con exactamente dos POST acotados; sin herramienta HTTP cruda | D-06, D-07, DS-06, DS-08, FR-06 |
| Túnel de método | Cabeceras `X-HTTP-Method`/similares convierten un GET aparente en escritura | Denegación explícita de cabeceras de sobreescritura de método | D-07, FR-09 |
| Escritura vía `$batch` | Un único POST a `$batch` puede contener lecturas y ChangeSets de inserción/actualización/borrado | `$batch` excluido del MVP; en Fase 2 solo sobre POST al `$batch` fijo con todas las peticiones internas GET y sin ChangeSets | R2, D-07, D-08, FR-09, FR-17 |
| Efectos secundarios vía operación custom / function import | OData v2 permite operaciones custom por GET (solo deberían ser GET si no tienen efectos secundarios) | Excluidas del MVP; en Fase 2 solo con verificación individual de ausencia de efectos secundarios y allowlist explícita | R1, DS-04, D-25, FR-08 |
| Redirect malicioso | El endpoint responde con redirección a otro host | No seguir redirects a hosts no configurados | DS-01, FR-11 |
| Confusión de entornos | Petición sin entorno, o error que «cae» a otro tenant | Selector explícito; fail-closed; sin fallback de entorno | D-02, FR-02 |
| Exceso de permisos en el tenant | La cuenta configurada tiene permisos de escritura | Cuenta de mínimo privilegio y solo lectura en el origen, verificada en implementación; la cuenta técnica compartida aceptada (D-23) no relaja el requisito | DS-02, D-23, FR-13 |
| Ampliación de alcance por URL | Input de herramienta inyecta host/ruta/base URL arbitrarios | El constructor de URL fija scheme/host/base URL desde la configuración; los inputs no los sobrescriben | DS-01, FR-07 |
| Inyección por opciones de consulta (Fase 2) | Nombres de opción desconocidos o manipulación de valores | Nombres desconocidos rechazados antes del despacho; valores crudos solo para opciones de lectura permitidas; errores saneados | DS-11, D-17, FR-22 |
| Consumo descontrolado / paginación encadenada | Seguir next links o acumular páginas en una llamada | Techo de 1.000 registros; una página por llamada; sin auto-follow; continuación solo mediante llamada MCP explícita con cursor | D-18, DS-10, R5, R7, FR-15, FR-23 |
| Abuso del cursor (Fase 2) | Cursor manipulado para alterar el alcance de la consulta | Cursor opaco, generado y validado por el servidor, ligado a entorno+entidad+protocolo+consulta; no altera host, método ni base URL | DS-10, D-18, FR-23 |
| Fallback como ampliación de alcance (Fase 2) | Reintentar en otra versión ante errores no contemplados | Fallback solo dentro de los protocolos permitidos y de las categorías confirmadas; nunca ante auth/red/vacío válido/sintaxis; una única respuesta con razón saneada | D-16, DS-09, FR-20, FR-21 |
| Token endpoint arbitrario (Fase 2) | POST a un endpoint no configurado o aportado por el modelo | `tokenUrl` fijo por entorno desde la configuración; nunca input del modelo; TLS obligatorio | D-13, DS-07, R6, FR-16 |
| Atribución de auditoría a cuenta compartida | La auditoría del origen no identifica al usuario local individual | Riesgo **aceptado explícitamente** por el usuario (cuenta técnica compartida); no es una mitigación pendiente | D-23 |

Nota sobre datos personales: las respuestas del tenant pueden contener datos de RR. HH.; viajan al contexto del modelo del usuario por diseño del producto (el propósito es consultarlo). Las mitigaciones aplicadas son no **persistirlos ni registrarlos** (D-09, FR-12), devolver errores saneados sin datos personales (D-20, FR-14) y limitar el alcance de la cuenta en el origen (DS-02).

---

## E. Success Metrics & Acceptance Criteria

Métricas de éxito (resultado, no actividad):

- Instalación y primer arranque en una máquina Linux limpia siguiendo **solo** la documentación publicada; el tiempo objetivo se medirá y definirá en diseño (Q-10).
- **Cero** operaciones de escritura despachadas por la superficie completa de herramientas (suite negativa, V1/V2).
- **Cero** secretos, tokens, cadenas de consulta sensibles o datos personales en logs y artefactos generados (V1/V2).
- **Cero** rutas personales absolutas o tenants/hosts hardcodeados en ficheros versionados; la plantilla usa solo placeholders (V2).
- Configuración creada por el usuario desde la plantilla del repositorio, sin secretos en el repo (V2/V3).

### E.1 Criterios positivos

1. `GET $metadata` funciona para el entorno seleccionado, sin filtrado por allowlist en todas las fases (D-05, D-15, R1).
2. Una lectura GET directa funciona para rutas de entidad permitidas por la cuenta (D-05).
3. El selector de entorno explícito resuelve correctamente el entorno indicado (D-02).
4. Las respuestas llegan al llamador sin almacenamiento persistido intermedio (D-09).
5. Instalación/first-run en Linux siguiendo solo la documentación, con plantilla sin secretos (D-03, D-22).
6. Fase 2, cuando llegue: protocolo preferido respetado dentro de lo permitido; allowlist común aplicada; fallback conforme a sus categorías exactas con respuesta única; continuación solo con cursor explícito; salida JSON/XML con campos nativos (D-14..D-19).

### E.2 Criterios negativos (fail-closed)

1. Entorno faltante o desconocido ⇒ rechazo; **nunca** selección implícita ni fallback a otro entorno (D-02).
2. Host/ruta arbitrarios en el input ⇒ denegados (DS-01).
3. Todo método no GET dirigido a recursos OData ⇒ rechazado **antes** del despacho de red. En el MVP **sin excepciones**; en Fase 2 las únicas excepciones POST son el `tokenUrl` fijo (solo autenticación) y el sobre `$batch` con internos GET exclusivamente (D-07, DS-08).
4. Cabeceras de sobreescritura de método ⇒ denegadas (D-07).
5. `POST $batch` ⇒ no disponible en MVP (D-07, R2).
6. Ningún log ni persistencia de respuestas o credenciales (D-09).
7. Basic Auth únicamente sobre HTTPS (R3, DS-01).
8. Redirects a hosts no configurados ⇒ no seguidos (DS-01).
9. Ningún fallo relaja restricciones, degrada a otro entorno ni reescribe valores de consulta (D-02, D-16).
10. La cuenta usada es de solo lectura en el origen, verificada de forma independiente a la aplicación (DS-02, D-23).
11. Nunca se combinan más de 1.000 registros ni más de una página por llamada; nunca se siguen next links automáticamente; sin continuación real, no se ofrece una (D-18).
12. Errores devueltos al modelo sin credenciales, tokens, URLs/queries sensibles ni datos personales (D-20).
13. Entidad ausente de la allowlist (Fase 2) ⇒ denegada (D-15).
14. Nombre de opción de consulta desconocido (Fase 2) ⇒ rechazado antes del despacho (D-17).

### E.3 Enfoque de verificación propuesto (V1–V3; no fija gates de entrega)

Los niveles V1–V3 siguientes son una **propuesta** para ilustrar cómo demostrar E.1/E.2; no establecen gates de CI, pre-commit, aprobación de PR, UAT firmada ni condición de archivo. Herramientas, disparadores, cobertura, presupuesto de tiempo y obligatoriedad quedan para diseño técnico (A-7, Q-10).

| Nivel propuesto | Qué | Cuándo se podría usar | Estado |
|---|---|---|---|
| **V1 — Pruebas automatizadas** | Pruebas de lógica de servidor: bloqueo de escrituras antes del despacho, construcción de URL desde configuración, saneamiento de errores/logs, techo de paginación, allowlist/protocolos, fallback, cursor y rechazo de opciones desconocidas | Para cambios que toquen la superficie del servidor | Propuesta; puerta CI/pre-commit no decidida |
| **V2 — Smoke en entorno limpio** | Arranque con `HOME` aislado, sin secretos previos; servicios OData simulados/grabados según corresponda; ejecución de los pasos documentados | Para validar instalación y documentación | Propuesta; automatización, fixture y obligatoriedad no decididas |
| **V3 — UAT manual** | Prueba por una persona en Linux contra un tenant no productivo, siguiendo la documentación y registrando fricciones/tiempo | Antes de un release o cambio de instalación, si se decide | Propuesta; frecuencia y aprobación formal no decididas |

Entorno limpio (V2) se refiere a `HOME` recién creado y sin secretos previos. Si se necesita un harness versionado para reproducibilidad es una decisión de diseño, no un requisito ya confirmado.

#### Escenarios ilustrativos de aceptación (Gherkin)

Los escenarios y etiquetas V1–V3 siguientes ilustran formas de verificar E.1/E.2; no añaden gates ni políticas de entrega y siguen sujetos a diseño (A-7, Q-10).

```gherkin
Scenario: Primer arranque local desde máquina limpia (FR-01, FR-03) [V2]
  Given un entorno limpio sin rastro previo del producto
  And el repositorio clonado en una ruta arbitraria no estándar
  When ejecuto los pasos de instalación/first-run documentados verbatim
  Then el servidor MCP arranca en Linux y se comunica solo por STDIO
  And no se abre ninguna escucha HTTP
  And no se requiere ninguna edición manual de ficheros del repositorio

Scenario: Configuración creada desde la plantilla sin secretos (FR-03) [V2]
  Given el repositorio clonado y la documentación publicada
  When copio la plantilla de configuración a ~/.config/ssff-mcp/config.json
  And relleno solo los placeholders con mis valores
  Then el repositorio y la plantilla no contienen ningún secreto real
  And la documentación explica la ruta exacta y el significado de cada campo
  And el fichero creado tiene permisos restrictivos para el usuario

Scenario: Lectura de metadatos y entidades en el entorno seleccionado (FR-02, FR-04, FR-05) [V2]
  Given un entorno configurado con cuenta de solo lectura de prueba
  When solicito $metadata y una lectura de entidad con el entorno explícito
  Then obtengo resultados sin almacenamiento persistido intermedio

Scenario: Rechazo de escrituras OData y cabeceras de túnel (FR-06, FR-09) [V1+V2]
  Given el servidor en ejecución
  When intento cualquier operación no GET sobre recursos OData (POST/PUT/PATCH/DELETE/MERGE/upsert)
  Or envío cabeceras X-HTTP-Method o equivalentes
  Then cada intento se rechaza antes de cualquier despacho de red
  And el mensaje de error no contiene secretos ni URLs sensibles

Scenario: $batch no disponible en el MVP (FR-09) [V1+V2]
  Given el servidor MCP ejecutándose en modo MVP
  When intento invocar $batch
  Then la petición se rechaza antes del despacho de red

Scenario: Sin HTTP crudo ni overrides de host/base URL (FR-07, FR-11) [V1+V2]
  Given el servidor en ejecución
  When un input de herramienta incluye URL cruda, host, base URL o scheme arbitrarios
  Then el input se ignora o rechaza, y la URL se construye solo desde la configuración
  And una respuesta de redirección a un host no configurado no se sigue

Scenario: Techo de 1.000 registros y una sola página (FR-15) [V1+V2]
  Given una consulta cuyo resultado excede una página OData
  When ejecuto la llamada MCP
  Then recibo como máximo 1.000 registros de una sola página
  And no se sigue ningún next link automáticamente
  And sin continuación real no se ofrece ni inventa ninguna

Scenario: Errores y logs sin secretos ni datos personales (FR-12, FR-14) [V1+V2]
  Given el servidor en ejecución con logs activos
  When fuerzo errores de autenticación, de consulta y de red
  Then los errores devueltos al modelo contienen solo código/mensaje saneados
  And los logs contienen solo metadatos de operación
  And un barrido de logs y artefactos no encuentra credenciales, tokens, queries completas ni datos personales

Scenario: Entorno ausente ⇒ rechazo fail-closed (FR-02) [V1+V2]
  Given el servidor en ejecución
  When una petición llega sin entorno o con un entorno desconocido
  Then se rechaza sin selección implícita ni reintento contra otro entorno

Scenario: Diagnóstico con corrección exacta (FR-03) [V2]
  Given el servidor instalado sin fichero de configuración
  When ejecuto el primer arranque
  Then el error nombra la ruta exacta ~/.config/ssff-mcp/config.json y la plantilla del repositorio a copiar

Scenario: Reinstalación idempotente (FR-01, FR-03) [V2]
  Given el producto instalado y configurado
  When repito los pasos documentados de instalación/first-run
  Then la configuración existente se conserva y el comportamiento no se degrada

Scenario: UAT propuesto como usuario real (global) [V3]
  Given una máquina/VM limpia y solo la documentación publicada
  When un usuario real completa la lista de comprobación contra un tenant no productivo
  Then se registra el resultado y el tiempo observado para decidir un objetivo en diseño
  And las fricciones quedan anotadas sin establecer una aprobación formal de release

# Fase 2 (cuando se implemente; no autoriza trabajo ahora)

Scenario: F2 — POST únicamente al tokenUrl fijo con TLS (FR-16) [V1+V2]
  Given un entorno con OAuth configurado
  When se obtiene o renueva el token
  Then las solicitudes de token usan POST solo al tokenUrl fijo de la configuración
  And no se despacha POST a recursos OData, $batch ni endpoints arbitrarios
  And el endpoint usa TLS y nunca acepta URLs aportadas por el modelo

Scenario: F2 — allowlist común con protocols (FR-19) [V1+V2]
  Given una allowlist con {"entity":"CandidateLight"} y {"entity":"JobRequisition","protocols":["v2"]}
  When consulto cada entidad en cada protocolo
  Then CandidateLight se permite en ambos protocolos habilitados y JobRequisition solo en v2
  And una entidad ausente de la lista se deniega
  And $metadata no se filtra por la allowlist

Scenario: F2 — fallback acotado y respuesta única (FR-20, FR-21) [V1+V2]
  Given una entidad habilitada en v2 y v4
  When v4 falla por incompatibilidad reconocible o limitación de resultados
  Then el reintento ocurre solo dentro de los protocolos permitidos
  And devuelvo exactamente una respuesta con protocolUsed y fallbackReason saneado
  But ante error de autenticación, de red, resultado vacío válido o sintaxis inválida no hay fallback
  And los valores crudos de la consulta no se reescriben

Scenario: F2 — opciones de consulta crudas y rechazo de desconocidas (FR-22) [V1+V2]
  Given una consulta con opciones de lectura permitidas
  When paso sus valores crudos
  Then pasan sin reescritura
  But un nombre de opción desconocido se rechaza antes del despacho
  And un error de sintaxis de $filter se devuelve saneado sin reintento entre versiones

Scenario: F2 — cursor opaco de continuación (FR-23) [V1+V2]
  Given una primera página con continuación real
  When pido la página siguiente en otra llamada MCP explícita
  Then el cursor opaco resuelve la página ligada a entorno+entidad+protocolo+consulta
  And un cursor manipulado se rechaza sin alterar host, método ni base URL

Scenario: F2 — batch_get solo con internos GET (FR-17) [V1+V2]
  Given batch_get implementado según su especificación de Fase 2
  When algún elemento incrustado no es GET o aparece un ChangeSet
  Then el lote completo se rechaza
  And el POST externo va solo al $batch fijo

Scenario: F2 — salida JSON/XML con campos nativos (FR-24) [V2]
  Given una lectura correcta
  When el LLM selecciona la representación de salida
  Then la respuesta usa JSON por defecto o XML como alternativa
  And los campos nativos de SuccessFactors se preservan sin normalización v2/v4
```

#### Matriz de trazabilidad FR → verificación

| FR | V1 | V2 | V3 | Escenario |
|---|---|---|---|---|
| FR-01 | ✔ | ✔ | ✔ | Primer arranque local desde máquina limpia; Reinstalación idempotente |
| FR-02 | ✔ | ✔ | — | Entorno ausente ⇒ rechazo fail-closed |
| FR-03 | — | ✔ | ✔ | Configuración creada desde la plantilla sin secretos; Diagnóstico con corrección exacta |
| FR-04 | ✔ | ✔ | ✔ | Lectura de metadatos y entidades |
| FR-05 | ✔ | ✔ | ✔ | Lectura de metadatos y entidades |
| FR-06 | ✔ | ✔ | — | Rechazo de todo no-GET y cabeceras de túnel |
| FR-07 | ✔ | ✔ | — | Sin HTTP crudo ni overrides de host/base URL |
| FR-08 | ✔ | ✔ | — | Rechazo de todo no-GET y cabeceras de túnel (operaciones custom denegadas) |
| FR-09 | ✔ | ✔ | — | Rechazo de todo no-GET y cabeceras de túnel |
| FR-10 | ✔ | ✔ | — | Sin HTTP crudo ni overrides (canal TLS forzado) |
| FR-11 | ✔ | ✔ | — | Sin HTTP crudo ni overrides de host/base URL |
| FR-12 | ✔ | ✔ | — | Errores y logs sin secretos ni datos personales |
| FR-13 | — | — | ✔ | UAT con cuenta de solo lectura verificada en el origen |
| FR-14 | ✔ | ✔ | — | Errores y logs sin secretos ni datos personales |
| FR-15 | ✔ | ✔ | — | Techo de 1.000 registros y una sola página |
| FR-16 | ✔ | ✔ | — | F2 — POST únicamente al tokenUrl fijo con TLS |
| FR-17 | ✔ | ✔ | — | F2 — batch_get solo con internos GET |
| FR-18 | ✔ | ✔ | ✔ | F2 — lectura por protocolo preferido (V3 contra tenant real) |
| FR-19 | ✔ | ✔ | — | F2 — allowlist común con protocols |
| FR-20 | ✔ | ✔ | — | F2 — fallback acotado y respuesta única |
| FR-21 | ✔ | ✔ | — | F2 — fallback acotado y respuesta única |
| FR-22 | ✔ | ✔ | — | F2 — opciones de consulta crudas y rechazo de desconocidas |
| FR-23 | ✔ | ✔ | — | F2 — cursor opaco de continuación |
| FR-24 | — | ✔ | — | F2 — salida JSON/XML con campos nativos |

---

## Requisitos funcionales (FR)

Trazado: cada FR referencia su decisión fuente (D-xx) o implicación derivada (DS-xx) y, cuando aplica, evidencia técnica (Rx). Los requisitos se agrupan por alcance: **MVP** (FR-01..FR-15) y **Fase 2** (FR-16..FR-24). La Fase 2 no autoriza implementación.

### MVP

- **FR-01** — El producto DEBE (MUST) ser un servidor MCP ejecutado localmente por el usuario, escrito en **TypeScript**, con alcance de plataforma **Linux únicamente** en el MVP y **OpenCode como primer cliente objetivo**, que se comunique con el host/cliente MCP exclusivamente por **STDIO**; NO DEBE (MUST NOT) abrir ningún servidor ni escucha HTTP. Evidencia: TypeScript está en Tier 1 de los SDK oficiales MCP y Rust aún soporta la especificación vigente en beta, lo que motivó la elección del runtime (R8). Fuente: D-01, D-04, D-21, DS-05.
- **FR-02** — Cada petición DEBE (MUST) indicar un entorno configurado de forma explícita. Ante un entorno ausente, desconocido o mal formado, el servidor DEBE (MUST) rechazar la petición (*fail-closed*) y NO DEBE (MUST NOT) seleccionar un entorno implícito ni reintentar contra otro entorno ante cualquier error. Fuente: D-02.
- **FR-03** — La configuración multi-entorno DEBE (MUST) residir en la ruta exacta `~/.config/ssff-mcp/config.json`, local por usuario, **fuera del repositorio** y **nunca confirmada en Git** (ignorada antes de que exista cualquier repositorio o publicación), con permisos de acceso restringidos al usuario. El repositorio DEBE (MUST) incluir desde el MVP una **plantilla de configuración sin secretos** (solo placeholders) y **documentación que explique la ruta y los campos**, como preparación para una posible publicación open source sin compromiso actual de publicar. La documentación del proyecto DEBE (MUST) declarar que el fichero contiene secretos en texto plano y que la exclusión de Git no es cifrado. El esquema final y el nombre de la plantilla son OPEN QUESTION (Q-1). Fuente: D-03, D-22, DS-03.
- **FR-04** — El servidor DEBE (MUST) exponer una herramienta (nombre propuesto: `get_metadata`; ver ASSUMPTION A-1) que recupere `$metadata` del entorno seleccionado mediante GET, **sin filtrado por allowlist** — esta propiedad se mantiene en todas las fases. Evidencia: OData v2 recupera `$metadata` mediante GET (R1). Fuente: D-05, D-15.
- **FR-05** — El servidor DEBE (MUST) exponer una herramienta (nombre propuesto: `get_entity`/`query_entity`; ver ASSUMPTION A-1) que realice lecturas GET directas OData v2 sobre las rutas de entidad permitidas por la cuenta configurada en el origen, **sin allowlist de entidades en el MVP**. PUEDE (MAY) aceptar opciones de consulta de solo lectura de OData v2 (`$filter`, `$orderby`, paginación, `$select`, `$expand`) únicamente donde el tenant las soporte; el subconjunto exacto aplicable al MVP y su validación son OPEN QUESTION (Q-2); la semántica completa de paso de valores crudos y rechazo de nombres desconocidos está confirmada para Fase 2 (FR-22). Evidencia: R1 (OData v2 define filtro, ordenación, paginación y selección/expansión). Fuente: D-05, D-08.
- **FR-06** — Toda petición a un recurso de datos OData DEBE (MUST) usar GET. El servidor DEBE (MUST) rechazar **antes del despacho de red** cualquier otro método hacia la superficie OData — incluidos POST, PUT, PATCH, DELETE y MERGE — y toda operación de escritura específica como `upsert`. **En el MVP no existe ninguna excepción de método no GET.** En Fase 2 solo se permiten dos clases/destinos POST: autenticación al `tokenUrl` fijo (FR-16; repetible cuando el flujo necesite emitir/renovar tokens) y el sobre POST al `$batch` fijo con todas las peticiones internas GET (FR-17); ninguno puede dirigirse a otros recursos ni escribir datos. Evidencia: en OData v2, crear/actualizar/borrar se corresponden con POST, PUT/MERGE y DELETE (R1); la exclusión de MERGE como verbo de escritura es decisión del usuario (D-07). Fuente: D-06, D-07, DS-08.
- **FR-07** — El servidor NO DEBE (MUST NOT) ofrecer ninguna herramienta de método arbitrario ni HTTP crudo, ni aceptar URLs crudas. Los inputs de las herramientas NO DEBEN (MUST NOT) poder sobrescribir scheme, host ni base URL: estos se fijan exclusivamente desde la configuración del entorno. Fuente: D-06, DS-01.
- **FR-08** — El servidor NO DEBE (MUST NOT) exponer operaciones de servicio personalizadas ni function imports (ni por GET ni por POST) en el MVP. En Fase 2, una operación de servicio solo PODRÁ (MAY) incorporarse si se **verifica individualmente** que carece de efectos secundarios y se incluye en una **allowlist explícita**. Evidencia: OData v2 permite operaciones custom por GET/POST y su especificación indica que solo deberían permitirse por GET si carecen de efectos secundarios (R1). Fuente: D-07, D-25, DS-04.
- **FR-09** — El servidor DEBE (MUST) denegar cabeceras de túnel/sobreescritura de método (`X-HTTP-Method` y equivalentes) y NO DEBE (MUST NOT) permitir `$batch` en el MVP. Evidencia: el procesamiento por lotes de OData v2 se envía como un único POST a `$batch` con un cuerpo que puede contener ChangeSets de inserción/actualización/borrado (R2); el lote de solo lectura de Fase 2 exige un sobre POST validado con rigor (D-08, FR-17). Fuente: D-07, R2.
- **FR-10** — Todas las conexiones a SuccessFactors DEBEN (MUST) usar HTTPS. Las credenciales Basic Auth NO DEBEN (MUST NOT) transmitirse jamás por un canal sin TLS. Evidencia: RFC 7617 — Basic transmite user-id/password en Base64 y no es seguro sin TLS (R3). Fuente: DS-01, R3.
- **FR-11** — El servidor NO DEBE (MUST NOT) seguir redirecciones a hosts distintos del configurado para el entorno seleccionado. Fuente: DS-01.
- **FR-12** — El servidor NO DEBE (MUST NOT) persistir cuerpos de respuesta ni credenciales. Los logs de actividad DEBEN (MUST) limitarse a metadatos de operación, excluyendo credenciales, cabeceras Authorization, cuerpos de respuesta, cadenas de consulta completas y datos personales devueltos. Fuente: D-09.
- **FR-13** — Como condición de aceptación y despliegue, cada cuenta de SuccessFactors utilizada DEBE (MUST) configurarse en el tenant con permisos de **mínimo privilegio y solo lectura**, con independencia del cumplimiento del MCP; la verificación de los roles del tenant DEBE (MUST) realizarse durante la implementación. La configuración local PUEDE (MAY) usar una **cuenta técnica compartida** de solo lectura del equipo del usuario: es una expectativa de despliegue aceptada, no una restricción universal del producto, y el usuario acepta que la auditoría del origen atribuya a dicha cuenta compartida en lugar de a cada usuario local. Esta aceptación NO DEBE (MUST NOT) relajar el requisito de solo lectura. Fuente: DS-02, D-05, D-23.
- **FR-14** — Los errores devueltos al modelo DEBEN (MUST) estar saneados: únicamente código y mensaje. DEBEN (MUST) omitirse secretos, tokens, URLs y cadenas de consulta cuando sean sensibles, y datos personales. Fuente: D-09, D-20.
- **FR-15** — Cada llamada MCP DEBE (MUST) devolver como máximo **1.000 registros** y **exactamente una página OData**; el servidor NO DEBE (MUST NOT) seguir next links automáticamente ni combinar páginas en una llamada. Si no existe continuación real, NO DEBE (MUST NOT) ofrecerse ni inventarse ninguna. Este techo se aplica en el MCP **con independencia del comportamiento del servicio** (DS-10). Evidencia: SAP documenta que la API OData de SuccessFactors devuelve como máximo 1.000 registros por página y recomienda paginación del lado del servidor (R5), y que la paginación cliente con `$top`/`$skip` puede perder o duplicar registros (R7). Fuente: D-18.

### Fase 2 (no autoriza implementación)

- **FR-16** — El producto DEBE (MUST) añadir OAuth 2.0 compatible con SAP SuccessFactors como alternativa a Basic Auth. La investigación preliminar apunta a **SAML 2.0 Bearer Assertion**, no al grant genérico `client_credentials`; el grant y el soporte efectivo DEBEN (MUST) verificarse con documentación oficial vigente y contra cada tenant objetivo antes de seleccionarlo. El token endpoint (`tokenUrl`) DEBE (MUST) ser fijo, configurarse una vez por usuario y entorno, y usar TLS; la herramienta MCP nunca aceptará su URL como input. Al obtener o renovar un token, el servidor DEBE (MUST) usar POST **únicamente** a ese endpoint; DEBE (MUST) rechazarlo si el host no coincide con la configuración del entorno y NO DEBE (MUST NOT) permitir POST a recursos OData, `$batch` ni endpoints arbitrarios. Toda la configuración necesaria, incluida una **clave privada** si el flujo verificado la requiere, DEBE (MUST) almacenarse temporalmente inline en el JSON local con permisos restrictivos y nunca en Git (D-24); este almacenamiento DEBE (MUST) revisarse antes de implementar OAuth. El diseño también DEBE (MUST) resolver registro del cliente, identidad/RBP del usuario de servicio, ciclo de vida del token y formato/permisos de la clave. Si no puede verificarse un flujo soportado por los tenants objetivo, la selección queda bloqueada para decisión del usuario. Evidencia: RFC 6749 exige HTTP POST y TLS en el token endpoint (R6). Fuente: D-12, D-13, D-24, DS-03, DS-07; ver ASSUMPTION A-4 y OPEN QUESTION Q-6.
- **FR-17** — `batch_get` DEBE (MUST) permitirse solo si **cada petición incrustada es GET**; el POST externo DEBE (MUST) dirigirse únicamente al `$batch` fijo; NO DEBEN (MUST NOT) aceptarse ChangeSets ni existir un POST genérico. Sus requisitos detallados (límites, tamaño, validaciones por elemento) requieren una especificación propia de Fase 2 (Q-8) antes de implementarse. Evidencia: el lote OData v2 es un único POST a `$batch` cuyo cuerpo puede mezclar recuperaciones GET y ChangeSets de escritura (R2). Fuente: D-08, DS-08.
- **FR-18** — El producto DEBE (MUST) añadir OData v4 junto a v2, permitiendo que el LLM elija el **protocolo preferido por llamada** dentro de los habilitados; v2 y v4 NO DEBEN (MUST NOT) tratarse como relación de reemplazo. La cobertura real de servicios/entidades v4 y el comportamiento de paginación por tenant DEBEN (MUST) verificarse (Q-4, A-6); el techo de FR-15 se aplica con independencia de dicho comportamiento. Evidencia: la página oficial de SAP SuccessFactors Platform publica referencias de API para OData v2 y v4, pero no permite confirmar disponibilidad por tenant (R4). Fuente: D-14.
- **FR-19** — DEBE (MUST) existir **una sola allowlist común de entidades** para ambas versiones. Una entidad ausente de la lista DEBE (MUST) denegarse. Cada entrada PUEDE (MAY) llevar una lista `protocols` (claves JSON en inglés `entity`, `protocols`, confirmadas): su omisión significa todos los protocolos habilitados (v2 y v4); una lista explícita restringe a los protocolos indicados (p. ej., `protocols: ["v2"]` permite solo v2). `$metadata` NO DEBE (MUST NOT) restringirse por la allowlist en ninguna fase. Fuente: D-15, D-08.
- **FR-20** — El fallback automático de versión DEBE (MUST) producirse solo dentro del conjunto de protocolos permitidos para esa entidad y solo ante **incompatibilidad reconocible de servicio/entidad/feature de consulta o limitación de resultados**. NO DEBE (MUST NOT) haber fallback ante errores de autenticación, errores de red, resultados vacíos válidos ni errores ordinarios de sintaxis/consulta inválida. El servidor NO DEBE (MUST NOT) reescribir valores crudos de consulta para intentar que funcionen. La semántica exacta de umbrales de «limitación de resultados» es OPEN QUESTION (Q-5) y NO PUEDE (MAY NOT) ampliarse con categorías no confirmadas sin una nueva decisión del usuario. Fuente: D-16, DS-09.
- **FR-21** — Cuando el fallback tenga éxito, el servidor DEBE (MUST) devolver **exactamente una respuesta** (nunca una combinación de resultados v2/v4) e incluir `protocolUsed` y un `fallbackReason` saneado conforme a FR-14. Fuente: D-16, D-20.
- **FR-22** — Los valores crudos de las opciones de consulta OData de lectura conocidas/permitidas DEBEN (MUST) pasarse sin reescritura; los nombres de opción desconocidos DEBEN (MUST) rechazarse antes del despacho. La lista exacta por versión y su validación son OPEN QUESTION (Q-2). Los errores de sintaxis de `$filter` DEBEN (MUST) devolverse como errores OData saneados para que el LLM los corrija; NO DEBE (MUST NOT) haber reintento entre versiones por errores de sintaxis. Fuente: D-17, DS-11.
- **FR-23** — Una página posterior DEBE (MUST) requerir otra llamada MCP explícita que presente un **cursor opaco** generado por el servidor y ligado a entorno, entidad, protocolo y consulta. El cursor DEBE (MUST) validarse en el servidor y NO DEBE (MUST NOT) permitir alterar host, método ni base URL. Si no existe continuación, NO DEBE (MUST NOT) inventarse. El ciclo de vida del token de cursor es OPEN QUESTION (Q-5). Fuente: D-18, DS-10.
- **FR-24** — La respuesta DEBE (MUST) preservar los campos nativos de SuccessFactors; NO DEBE (MUST NOT) aplicarse normalización de esquema v2/v4. La representación de salida DEBE (MUST) ser seleccionable por el LLM: **JSON por defecto, XML como alternativa**. (Para el MVP, la salida JSON con campos nativos es ASSUMPTION A-5.) Fuente: D-19.

### Roadmap posterior al MVP (informativo, no autoriza trabajo)

- **Fase 2 — OData v4 y selección de protocolo**: añadir v4 junto a v2 con elección de protocolo preferido por llamada (FR-18), sujeto a verificación de cobertura por tenant (Q-4).
- **Fase 2 — allowlist común**: una lista de entidades para ambas versiones con `protocols` opcional por entrada (FR-19).
- **Fase 2 — fallback acotado**: reintento de versión solo dentro de los protocolos permitidos y de las categorías confirmadas, con respuesta única `protocolUsed`/`fallbackReason` (FR-20, FR-21); semántica de umbrales pendiente (Q-5).
- **Fase 2 — opciones de consulta**: paso de valores crudos, rechazo de nombres desconocidos y errores `$filter` saneados sin reintento entre versiones (FR-22); lista exacta por versión pendiente (Q-2).
- **Fase 2 — cursor de paginación**: continuación explícita mediante cursor opaco ligado a entorno+entidad+protocolo+consulta (FR-23); ciclo de vida pendiente (Q-5).
- **Fase 2 — salida JSON/XML**: representación seleccionable por el LLM con campos nativos sin normalización (FR-24).
- **Fase 2 — autenticación OAuth**: alternativa OAuth 2.0 según FR-16, sujeta a la validación de Q-6. La investigación preliminar apunta a OAuth 2.0 **SAML 2.0 Bearer Assertion**; tratarlo como candidato, no como decisión cerrada (A-4). Antes de implementarla, DEBE (MUST) revisarse el almacenamiento temporal en claro de la clave privada (D-24).
- **Fase 2 — lecturas por lotes**: `batch_get` de solo lectura según FR-17; requiere especificación propia antes de implementarse (Q-8, R2).
- **Fase 2 — operaciones custom verificadas**: revisión de function imports/operaciones de servicio con verificación individual de ausencia de efectos secundarios y allowlist explícita (D-25, FR-08).

---

## OPEN QUESTIONS

1. **Q-1** — Esquema final exacto de `~/.config/ssff-mcp/config.json` (aliases de entorno, `baseUrl`, campos Basic Auth, campos OAuth/`tokenUrl` de Fase 2, allowlist de entidades, selección de protocolo) y nombre del fichero plantilla sin secretos. La ruta ya está confirmada (D-03); los nombres finales se mantienen abiertos donde no están confirmados, con ejemplos seguros de solo placeholders (D-03, D-22).
2. **Q-2** — Lista exacta por versión de nombres de opciones de consulta OData de solo lectura admitidas y cómo se valida cada una; rechazo de claves desconocidas. Incluye el subconjunto aplicable al MVP (FR-05) y el allowlist por versión de Fase 2 (FR-22, D-17).
3. **Q-3** — Si se incorpora alguna operación de servicio custom / function import por GET en Fase 2: verificación individual de ausencia de efectos secundarios y allowlist explícita (D-25, FR-08).
4. **Q-4** — Verificar por tenant la cobertura real de servicios/entidades OData v4 y su comportamiento de paginación (R4). El MCP DEBE aplicar el techo de 1.000 registros decidido por el usuario aunque el comportamiento del servicio difiera (D-18, DS-10, FR-18).
5. **Q-5** — Semántica exacta de los umbrales de fallback/limitación de resultados y ciclo de vida del token de cursor opaco (FR-20, FR-23). Ninguna categoría de fallback fuera de las confirmadas en D-16 puede añadirse sin nueva decisión del usuario.
6. **Q-6** — Confirmar el grant OAuth por tenant (candidato SAML 2.0 Bearer Assertion frente a cualquier `client_credentials` soportado), registro de aplicación, identidad/mapeo RBP del usuario, ciclo de vida del token, `tokenUrl` y formato/permisos de la clave privada, antes de implementar (FR-16, D-12).
7. **Q-7** — Licencia, visibilidad del repositorio y momento de publicación si el proyecto se publica como open source (D-10, D-22; sin compromiso). Este PRD NO autoriza publicación.
8. **Q-8** — Requisitos detallados de `batch_get` en Fase 2: sobre POST al `$batch` fijo, todas las peticiones internas GET, sin ChangeSets, sin POST genérico (D-08, FR-17).
9. **Q-9** — Nombres exactos de los perfiles de entorno y verificaciones de permisos específicas del tenant durante la implementación (DS-02, Q-1).
10. **Q-10** — Herramientas, cobertura, disparadores y obligatoriedad del enfoque V1–V3; presupuesto de tiempo para instalación/first-run y si la UAT manual debe ser una puerta de release (E.3).

Estas preguntas quedan registradas; **no** se solicita responderlas ahora.

---

## ASSUMPTIONS

- **A-1** — Los nombres de herramienta `get_metadata` y `get_entity`/`query_entity` son una **propuesta**, no decisión confirmada (FR-04, FR-05).
- **A-2** — Los esqueletos JSON de la sección C.1 son ilustrativos; la ruta del fichero está confirmada, pero el esquema final no (Q-1).
- **A-3** — Se asume que Basic Auth es válido contra los endpoints OData v2 de los tenants objetivo para las cuentas configuradas. La referencia R4 es la página oficial de entrada de la documentación de la API de SuccessFactors y **no** permite afirmar compatibilidad de autenticación; esto debe verificarse durante la implementación.
- **A-4** — La investigación preliminar identifica OAuth 2.0 con **SAML 2.0 Bearer Assertion** como candidato específico de SuccessFactors para complementar Basic Auth en Fase 2. No se considera confirmado: R4 es una página general de entrada a la documentación SAP, por lo que debe localizarse y verificarse la guía de autenticación vigente para cada tenant antes de cerrar el grant. No se debe asumir que el grant estándar `client_credentials` es compatible (Q-6).
- **A-5** — Para el MVP se asume salida **JSON con campos nativos**; la selección JSON/XML y la preservación de campos nativos sin normalización están confirmadas como comportamiento de Fase 2 (D-19, FR-24).
- **A-6** — Se asume que los tenants objetivo exponen OData v4 utilizable; sin verificar (R4, Q-4). El producto lo confirma por tenant antes de depender de ello en Fase 2.
- **A-7** — Los niveles V1–V3 de E.3 son una propuesta de profundidad de verificación, no gates de entrega confirmados por el usuario. Su obligatoriedad, tooling y disparadores quedan abiertos (Q-10).

---

## Referencias

- **R1** — OData Version 2.0, Part 2: Operations. https://www.odata.org/documentation/odata-version-2-0/operations/ — GET para recuperaciones y `$metadata`; POST/PUT/MERGE/DELETE para crear/actualizar/borrar; operaciones de servicio custom por GET/POST (GET solo si no tienen efectos secundarios); opciones de consulta de filtro, ordenación, paginación y selección/expansión.
- **R2** — OData Version 2.0, Batch Processing. https://www.odata.org/documentation/odata-version-2-0/batch-processing/ — el lote se envía como un único POST a `$batch` con operaciones de recuperación y/o ChangeSets de inserción/actualización/borrado.
- **R3** — IETF RFC 7617, The 'Basic' HTTP Authentication Scheme. https://www.rfc-editor.org/rfc/rfc7617.html — Basic transmite user-id/password codificados en Base64 y no es seguro salvo combinado con TLS.
- **R4** — SAP Help Portal, SAP SuccessFactors Platform. https://help.sap.com/docs/SAP_SUCCESSFACTORS_PLATFORM — página de entrada de la documentación oficial; existen referencias de API para OData v2 y v4, pero **no** permite confirmar disponibilidad de entidades por tenant ni un grant OAuth concreto: la cobertura v4 real, el grant exacto y el manejo del secreto OAuth quedan como verificación técnica por tenant (Q-4, Q-6).
- **R5** — SAP KBA 2735876. https://userapps.support.sap.com/sap/support/knowledge/en/2735876 — la API OData de SuccessFactors devuelve como máximo 1.000 registros en una sola página; recomienda paginación del lado del servidor; trata dimensionamiento de consultas y rendimiento.
- **R6** — IETF RFC 6749, The OAuth 2.0 Authorization Framework, §3.2. https://www.rfc-editor.org/rfc/rfc6749.html#section-3.2 — exige que las solicitudes de acceso al token endpoint usen HTTP POST y TLS.
- **R7** — SAP KBA 2675265. https://userapps.support.sap.com/sap/support/knowledge/en/2675265 — `$top` controla el número de resultados y `$skip` la posición; la paginación cliente con `$top`/`$skip` puede perder o duplicar registros en volúmenes grandes; se recomienda paginación del lado del servidor.
- **R8** — MCP SDK status (blog oficial de Model Context Protocol, entrada de la spec GA del 2026-07-28). https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/blog/content/posts/2026-07-28-spec-ga/index.md — TypeScript, Python, Go y C# en Tier 1; Rust soporta la especificación vigente en beta. Base de la justificación del runtime TypeScript (D-21).

Las restricciones del producto provienen de las decisiones del usuario (D-01..D-25); R1–R3 y R5–R7 sustentan las afirmaciones técnicas sobre OData v2, `$batch`, Basic Auth, límites de paginación de SuccessFactors y el token endpoint OAuth; R4 delimita qué debe verificarse por tenant; R8 sustenta la elección de runtime. El flujo OAuth y la cobertura v4 de Fase 2 permanecen como candidatos explícitamente no verificados (A-4, A-6, R4, Q-4, Q-6).

---

*Fin del documento. PRD en estado DRAFT v0.4: registra intención y no autoriza implementación, inicialización de Git ni publicación.*
