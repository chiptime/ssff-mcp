# PRD: Cierre de los Vectores de Fuga de `entityAllowlist` (`$expand` y navegación)

> **Estado:** P1 (navegación) y P2 (`$expand`) **IMPLEMENTADOS** en la rama `feat/allowlist-navigation-vectors`. P3 (`filter`/`orderby` con rutas de navegación) sigue **fuera de alcance**. · **Fase del producto:** Fase 1.5 (endurecimiento de seguridad)
> **Baseline:** `63b26b3` · **Última revisión:** 2026-10-17

---

## 1. Resumen Ejecutivo y Objetivos

### 1.1 Visión General

La `entityAllowlist` por entorno (fase 1, ya entregada en `0.4.0`) comprueba **únicamente el primer segmento** de la ruta y **no inspecciona `$expand`**. En OData v2 eso deja dos vías para leer conjuntos de entidades que la allowlist no autoriza:

1. **Navegación en la ruta**: `User('123')/navProperty` alcanza la entidad destino de la navegación sin volver a comprobarse.
2. **`$expand`**: `query_entity({ entityPath: "User", expand: "navProperty" })` arrastra registros de una entidad no autorizada.

Este PRD cierra **ambos** vectores de forma fail-closed. La tercera vía (`filter`/`orderby` con rutas de navegación) queda **explícitamente fuera de alcance** y se planificará aparte (§9).

**Hechos verificados en código (base del diseño):**

| Hecho | Evidencia |
|---|---|
| `$expand` no se valida: solo se rechazan caracteres de control | `src/odata.ts:155-160`; emisión cruda en `src/odata.ts:191` |
| La allowlist solo comprueba el primer segmento | `src/tools.ts` → `isEntityAllowed(entityAllowlist, validatedPath.firstSegmentName)` |
| La ruta ya viene parseada en segmentos, con comillas respetadas | `validateEntityPath` devuelve `{ segments, firstSegmentName }` (`src/odata.ts:83-111`), máximo 4 segmentos |
| La metadata ya modela la navegación a su entidad destino | `EntitySchema.navigationProperties: { name, targetEntitySet, relationship, multiplicity }` (`src/metadata.ts`) |
| El hueco estaba reconocido como cuestión abierta desde el PRD original | `archive/PRD.md:470` (FR-05, Q-2) |
| **SAP decodifica `%27` dentro de una clave** (premisa del rechazo de percent-encoding) | **Validado contra TEST el 2026-10-18**: `User('1211902%27)/empInfo` devuelve **200** con el `EmpEmployment` de `1211902`, y `User('1211902%27)` devuelve **200** con `User('1211902')`. SAP cierra la clave y trata el resto como navegación, así que la ruta validada y la despachada difieren de verdad. |

La consecuencia técnica central: **la allowlist está expresada en términos de entity sets, pero las rutas de navegación y `$expand` usan nombres de `NavigationProperty`**. Comparar nombres directamente sería incorrecto. Hay que **resolver cada propiedad de navegación a su `targetEntitySet`** usando la metadata ya cacheada.

### 1.2 Objetivos Clave (OKRs)

* **O1 — Cero lectura fuera de la allowlist:** ninguna petición de datos puede alcanzar un entity set no autorizado, ni por ruta de navegación ni por `$expand`, en `query_entity` ni en `batch_get`.
* **O2 — Sin regresión en consultas legítimas:** toda consulta cuya ruta y cuyo `expand` resuelvan a entidades autorizadas se comporta **byte a byte** como hoy.
* **O3 — Verificación independiente:** el cambio pasa una revisión adversarial externa (es una frontera de seguridad), sin blockers.

---

## 2. Registro de Decisiones de Arquitectura (Ledger)

| ID | Decisión | Origen / Justificación |
|---|---|---|
| **D-107** | **Fail-Closed Sin Escape Silencioso**: cualquier destino de navegación o de `$expand` que no esté autorizado se deniega con `ENTITY_NOT_ALLOWED` / `NAVIGATION_NOT_ALLOWED`. No se introduce ningún flag que degrade la comprobación a "solo primer segmento". | Una allowlist con opt-out silencioso provoca falsa sensación de control: el usuario cree estar restringido y no lo está. Coherente con D-30. |
| **D-108** | **Resolución de Navegación vía Metadata**: cada segmento de navegación (y cada ruta de `expand`) se resuelve a su `targetEntitySet` recorriendo `EntitySchema.navigationProperties` de la entidad actual. La comprobación se hace **siempre contra el entity set destino**, nunca contra el nombre de la NavigationProperty. | Los nombres de navegación no coinciden con los entity sets (p. ej. `userIdNav` → `User`). Comparar nombres daría falsos negativos (fuga) o falsos positivos (rotura). |
| **D-109** | **Módulo Puro Dedicado**: la lógica vive en `src/allowlist-navigation.ts`. `isEntityAllowed` (`src/allowlist.ts`) **no se modifica**; sigue siendo la comprobación de una entidad contra la lista. | Mantiene la lógica de decisión trivial y testeable por separado de la resolución estructural, que necesita metadata. |
| **D-110** | **Navegación No Resoluble ⇒ Denegar, Sin Refresco Automático**: si un segmento no figura en `navigationProperties` de la entidad actual, se rechaza con `NAVIGATION_NOT_ALLOWED` en lugar de dejar que SAP devuelva un 404. El servidor **no** refresca la metadata por su cuenta: si la causa es un catálogo obsoleto, se resuelve con `ssff-mcp cache invalidate <alias>` y se reintenta. El mensaje de error es genérico (sin eco del nombre) e **indica esa vía**, para que el usuario y el LLM sepan qué hacer. | Coherente con D-107 (no delegar el alcance en el servicio remoto) y con D-111 (la metadata se refresca invalidando, no pidiéndola al vuelo). **Coste asumido:** una navegación legítima que la metadata no modele fallará hasta que se refresque el catálogo; la puerta de medición de §3.4 sigue siendo obligatoria antes de cerrar P1. |
| **D-111** | **Coste de Red Cero: la Metadata Ya Está en Disco**: la resolución de navegación y `expand` reutiliza el `ParsedMetadata` que la clasificación del primer segmento **ya carga hoy** (`src/tools.ts:467` en `query_entity`; `src/tools.ts:649` en el *pass 2* del preflight de `batch_get`). La caché es persistente en disco (`metadata-<alias>.json`, TTL 24 h; en memoria 10 min). **Este PRD no añade ninguna petición nueva**, ni en el caso normal ni con caché fría: ese `$metadata`, cuando ocurre, ya ocurre hoy por la clasificación. Refrescar la metadata es `ssff-mcp cache invalidate`, no una decisión del parser. | La metadata no se vuelve a pedir: está en disco. La suposición contraria (que había que hidratarla para poder resolver) era errónea. |
| **D-112** | **Subconjunto Probado de la Gramática de `$expand`**: parser propio para comas, anidamiento con `/`, sub-opciones entre paréntesis y `$select` como **lista simple de propiedades**. Toda sintaxis que no se pueda probar se rechaza con `OPTION_INVALID` y **nunca se despacha**. **Dentro de `expand`, `$filter` y `$orderby` se rechazan en esta fase** (pertenecen al vector de §9). **Los caracteres percent-encoded se rechazan**: SuccessFactors los decodifica, así que un `;` codificado escondería un `$expand` anidado que el parser no comprobaría. **`$levels` NO se soporta** (es OData v4 y su semántica en v2 no está probada): se rechaza explícitamente. **El `$expand` se resuelve desde la entidad a la que llega la RUTA**, no desde el primer segmento. | `expand` era pass-through crudo: parsearlo reduce capacidad, y ese es el precio de tener una frontera real. Las tres restricciones (percent-encoding, `$select` estricto, sin `$levels`) y el punto de partida de la resolución fueron hallazgos de la verificación independiente. |
| **D-113** | **`filter`/`orderby` con Rutas de Navegación Fuera de Alcance**: no se tocan en este PRD. | Requieren entender el lenguaje de expresiones OData v2; el riesgo de falsos positivos (romper filtros legítimos) y falsos negativos (fugar datos) es de otra naturaleza. Se decidirá con datos de producción (§9). |
| **D-114** | **Política Elegida: (A) Selectiva — CONFIRMADA**: se permite la navegación y el `expand` cuyo **destino resuelto** esté autorizado; cualquier otro destino se deniega. **No** se prohíben en bloque las asociaciones ni `$expand`. | Decisión del usuario (2026-10-17). Preserva una capacidad OData central (`User('x')/nav`, `$expand`) sin abrir la frontera, porque el destino se comprueba siempre contra la allowlist. La política debe estar implementada **y** anunciada en la descripción de la herramienta y en el mensaje de error (FR-151). |

---

## 3. Especificación del Comportamiento

### 3.1 Superficie Afectada

| Superficie | Afectada | Motivo |
|---|---|---|
| `query_entity` | Sí | Acepta `entityPath`, `expand`, `filter`, `orderby` |
| `batch_get` | Sí | Cada ítem reutiliza exactamente la gramática de `query_entity` |
| `inspect_entity` | No | No acepta ruta ni opciones de consulta |
| Recursos `sf://…` | No | No aceptan opciones; su filtrado por allowlist ya es correcto |
| `list_environments` | No | Sin datos de entidad |

### 3.2 Regla de Resolución

1. Validar y parsear la ruta (`validateEntityPath`), obteniendo `segments`.
2. Comprobar `segments[0]` contra la allowlist (**sin cambios** respecto a hoy).
3. Para `segments[1..]`: quitar el predicado de clave, resolver el nombre como `NavigationProperty` de la entidad actual y obtener su `targetEntitySet`. Comprobar ese destinos contra la allowlist. Avanzar a la entidad destino y repetir.
4. Parsear `expand` (si existe) en rutas de navegación, recursivamente. Para cada ruta, aplicar el paso 3 desde la entidad raíz y comprobar **todos** los destinos.
5. Cualquier denegación aborta antes de **cualquier petición de datos**.

### 3.3 Códigos de Error

| Código | Cuándo | Mensaje |
|---|---|---|
| `ENTITY_NOT_ALLOWED` | Destino de navegación o de `expand` resuelto pero no autorizado | Mensaje específico e igualmente sin eco: `a navigation in the entity path is not permitted by the configured entityAllowlist` (o `an expanded navigation …`) |
| `NAVIGATION_NOT_ALLOWED` | Extensión de navegación **no resoluble** en la metadata | Sin eco del nombre, e indica la salida: refrescar el catálogo con `ssff-mcp cache invalidate <alias>` y reintentar |
| `OPTION_INVALID` | `expand` con sintaxis fuera del subconjunto probado, o con `$filter`/`$orderby` anidados | El `OPTION_INVALID` ya existente |

### 3.4 Qué Significa Exactamente "Navegación No Resoluble"

Un segmento posterior al primero se resuelve buscando `name === segmento` en `EntitySchema.navigationProperties` de la entidad actual. Si aparece, su `targetEntitySet` es el destino que se comprueba contra la allowlist. **"No resoluble" = esa búsqueda no encuentra nada.**

| Causa | Ejemplo | Efecto de denegar (D-110) |
|---|---|---|
| Nombre inexistente o errata | `User('1')/noExiste` | Correcto: hoy daría 404 |
| **`$metadata` recortado por los permisos del usuario API** | la asociación existe en el servicio pero no en *nuestra* vista de metadata | **Riesgo real**: romperíamos una consulta legítima |
| Metadata incompleta o de otra versión del tenant | asociaciones no publicadas | Igual que la anterior |
| Segmento especial (`$value`, `$count`, `$links`) | — | Irrelevante: ya lo bloquea `validateEntityPath` antes de llegar aquí |

> **Puerta de medición — COMPLETADA (2026-10-17 · entorno TEST · auth básica).** Resultado: el `$metadata` de `User` expone **~150 `navigationProperties`**, todas con `targetEntitySet` y `multiplicity`, incluidas las estándar (`empInfo` → `EmpEmployment`, `manager` → `User`, `userPermissionsNav` → `UserPermissions`) y las Custom MDF (`cust_*`). **No hay indicio de truncamiento por permisos del usuario API.** D-110 es viable con la metadata actual.
> **Caveat:** medido en un tenant y un usuario concretos. Repetir el muestreo en un tenant cuyo usuario API tenga permisos más restringidos antes de cerrar P1.
> **Hallazgo adicional:** en una **ruta de navegación**, SAP rechaza las opciones de colección (`$top`, `$skip`, `$orderby`, `$skiptoken`, `$inlinecount`) con `COE_BAD_PROPERTY_EXPRESSION`. Afecta a cómo se prueban las rutas de navegación — no al chequeo de allowlist, que ocurre antes del dispatch — pero hay que tenerlo presente al diseñar los tests de P1.

---

## 4. Requisitos Funcionales (FR)

* **FR-141 (MUST)**: todo segmento de navegación posterior al primero DEBE resolverse a su `targetEntitySet` y comprobarse contra la allowlist del entorno resuelto.
* **FR-142 (MUST)**: toda ruta de `$expand` DEBE resolverse recursivamente hasta su `targetEntitySet` y comprobarse contra la allowlist, incluidas las rutas anidadas.
* **FR-143 (MUST)**: la comprobación es **atómica por llamada**: si **cualquier** destino de la ruta o del `expand` está denegado, la llamada entera falla. Nunca hay `expand` parcial.
* **FR-144 (MUST)**: una extensión de navegación no resoluble DEBE rechazarse con `NAVIGATION_NOT_ALLOWED`, sin despachar al servicio.
* **FR-145 (MUST)**: una sintaxis de `expand` que el parser no pueda probar DEBE rechazarse con `OPTION_INVALID` antes de cualquier petición.
* **FR-146 (MUST)**: `$filter` y `$orderby` **anidados dentro** de `expand` DEBEN rechazarse en esta fase con `OPTION_INVALID`.
* **FR-147 (MUST)**: `batch_get` DEBE aplicar exactamente las mismas reglas por ítem, y **un ítem denegado rechaza el lote entero** antes del `$batch` POST (coherente con el preflight actual).
* **FR-148 (MUST)**: la semántica es: allowlist **ausente o `[]`** ⇒ el entorno no está restringido; una allowlist no vacía estrecha; el `entityDenylist` gana sobre la allowlist **para acceso directo a la entidad**. La navegación y `expand` heredan esa misma decisión **solo cuando P1/P2 estén implementadas**; hasta entonces son un vector abierto y la documentación DEBE decirlo (limitación declarada en `docs/configuration.md` y `CHANGELOG.md`).
* **FR-149 (MUST)**: `isEntityAllowed` conserva su contrato actual (entidad + protocolo) y la resolución por entorno de la fase 1 no se altera.
* **FR-150 (MUST)**: la documentación (`docs/configuration.md`, `docs/security.md`, `docs/tools.md`) DEBE declarar el alcance real y sus límites, y `CHANGELOG.md` DEBE registrar el cambio como **breaking**.
* **FR-151 (MUST)**: la descripción de la herramienta y el mensaje de error DEBEN declarar la política de D-114 de forma explícita: qué se permite (navegación y `expand` con destino autorizado) o, si se elige la prohibición total, que **las asociaciones y `$expand` no están soportados** — para que el modelo no reintente a ciegas y el usuario entienda el límite.
* **FR-152 (MUST)**: la política de D-114 es **(A) selectiva** y NO DEBE cambiarse durante la implementación sin actualizar este PRD.
* **FR-153 (MUST)**: ante `NAVIGATION_NOT_ALLOWED`, el mensaje DEBE indicar que el catálogo de metadata puede estar obsoleto y que se refresca con `ssff-mcp cache invalidate <alias>`. El servidor NUNCA DEBE refrescar la metadata automáticamente como reacción a ese error.

---

## 5. Diseño Técnico e Implementación

### 5.1 Ubicación de Código

| Fichero | Cambio |
|---|---|
| `src/allowlist-navigation.ts` | **Nuevo.** Resolución pura: ruta/`expand` → lista de entity sets destino; comprobación contra la allowlist. Sin I/O. |
| `src/expand.ts` | **Nuevo.** Parser del subconjunto probado de `$expand` (comas, `/`, paréntesis, `$select` como lista de propiedades). Rechaza percent-encoding y `$levels`. Errores `OPTION_INVALID`. |
| `src/metadata.ts` | Exponer el mapa `entidad → { navName → targetEntitySet }` desde la metadata ya cacheada. Sin cambiar el formato de caché. |
| `src/tools.ts` | Puntos de llamada en `query_entity` y `batch_get`. |
| `src/allowlist.ts` | **Sin cambios.** |
| `src/odata.ts` | **Sin cambios** en la emisión; el parser de `expand` vive aparte para no engordar `buildQuery`. |

### 5.2 Fases de Entrega

**P1 — Navegación en `entityPath`.** Segmentos `[1..]`, resolución iterativa, `NAVIGATION_NOT_ALLOWED` para lo no resoluble. Sin tocar `expand`.

**P2 — `$expand`.** Parser + resolución recursiva + rechazo de sub-`$filter`/`$orderby`. Se apoya en P1.

**P3 — Cierre.** Docs, CHANGELOG, **verificación independiente**, bump a `0.5.0`.

### 5.3 Fixture de Pruebas

La metadata de los tests debe incluir navegaciones con `targetEntitySet`. Hoy `SAMPLE_METADATA_XML` (`test/helpers.ts`) no tiene ninguna y `mdfMetadataXml` tiene una por entidad: hace falta un fixture nuevo con cadenas de profundidad ≥ 3 y navegaciones que apunten a entidades **fuera** de la allowlist.

---

## 6. Seguridad y Gobernanza (DS)

* **DS-ALLOWLIST-01 (Frontera Real)**: la allowlist DEBE ser una frontera de confidencialidad, no solo un filtro del primer nombre. Un `expand` denegado nunca devuelve datos parciales.
* **DS-ALLOWLIST-02 (Nada de Datos Antes de Denegar)**: una denegación DEBE ocurrir antes de **cualquier petición de datos**. Se permite como máximo un `$metadata` GET para resolver (D-111).
* **DS-ALLOWLIST-03 (Sin Eco de Rutas)**: los mensajes de error nunca incluyen la ruta, el nombre de la navegación ni valores de filtro (coherente con el saneado actual).
* **DS-ALLOWLIST-04 (Solo Lectura Intacta)**: el cambio no añade ninguna superficie de escritura; se mantiene la garantía GET-only.

---

## 7. Plan de Pruebas y Validación

1. **Navegación (`test/allowlist-navigation.test.ts`)**:
   - Ruta de 2 y 3 segmentos con destino autorizado ⇒ permitida, y la petición es byte-idéntica a hoy.
   - Navegación a entidad denegada ⇒ `ENTITY_NOT_ALLOWED`.
   - Navegación no resoluble ⇒ `NAVIGATION_NOT_ALLOWED`.
   - Claves con comillas y paréntesis (`User('a/b')`) parseadas correctamente.
   - Allowlist ausente ⇒ navegación libre; `[]` ⇒ navegación denegada.
2. **`$expand` (`test/allowlist-expand.test.ts`)**:
   - `expand=Allowed` permitido; `expand=Denied` denegado.
   - `expand=Allowed,Denied` ⇒ denegado (sin salida parcial).
   - Anidamiento `expand=A/B` y `expand=A($expand=B)` resuelto en profundidad.
   - Sintaxis ambigua o fuera del subconjunto ⇒ `OPTION_INVALID`.
   - `expand=A($filter=…)` ⇒ `OPTION_INVALID` (FR-146).
3. **`batch_get`**:
   - Un ítem con navegación denegada rechaza el lote entero antes del POST.
   - Se observa como máximo **un** `$metadata` GET, y **cero** peticiones de datos.
4. **No regresión**: la suite actual (436 tests) debe seguir verde; los casos permitidos deben producir la misma URL de salida.
5. **Verificación independiente** (obligatoria, `Risk: item 2`): matriz de superficies, probing de frío, y comparación byte a byte de resultados permitidos contra el baseline.
6. **Evidencia de partida ya medida (2026-10-17, TEST)**: `User?$expand=empInfo&$select=userId,empInfo` devuelve el registro **completo** de `EmpEmployment`. El vector de `$expand` es real: P2 no es teórico. Las pruebas de este PRD deben incluir una aserción equivalente (destino denegado ⇒ nada de datos), no solo la comprobación del código de error.

---

## 8. Estimación de Esfuerzo

* **Complejidad:** Alta (parser de gramática + resolución recursiva sobre metadata, con reducción de capacidad).
* **Story Points:** 13 SP.
* **Tiempo Estimado:** 1,5 a 2 semanas (P1 ~3 días, P2 ~5 días, cierre y verificación ~2 días).
* **Riesgo:** Alto. Es una frontera de seguridad y es breaking.

---

## 9. Fuera de Alcance (Explícito)

| Vector / Capacidad | Estado |
|---|---|
| `$filter` / `$orderby` con rutas de navegación (`navProp/campo`) | **CERRADO para las formas de producción.** `navigationPathsInExpression` extrae las secuencias `nombre/nombre` fuera de literales entrecomillados y comprueba el destino, igual que una ruta o un `$expand`. Es un escaneo **deliberadamente conservador**, no un parser del lenguaje de expresiones: una forma no reconocida no se comprueba, y eso queda declarado en `docs/security.md`. |
| **Normalización de URL en claves entrecomilladas** (`User('x/../Payroll#')`) | **CERRADO.** `validateEntityPath` rechaza `%`, `#`, `?`, `\` y los segmentos `.` / `..` con `PATH_INVALID`: la normalización de URL y el parseo del servicio ocurren **después** de la comprobación, así que la ruta validada y la despachada podían diferir. Añadido en la rama `fix/entity-path-normalisation`. |
| Granularidad por campo (`$select` a nivel de propiedad) | **PUBLICADA en 0.5.0 (2026-10-18).** Solicitada por el usuario después de cerrar este PRD: `fields` en cada entrada de la allowlist, con recorte del payload de respuesta, rechazo de referencias, esquemas que ocultan lo denegado y downgrade de XML. Revisada nativamente (un CRITICAL de rutas de expand intermedias, corregido). |
| Fase 2 (usuarios y roles dentro del tenant) | Aplazada por decisión del usuario. |
| Servicio multi-tenant (Streamable HTTP) | **EN CONSTRUCCIÓN** en la rama `feat/multitenant-hosting` (worktree paralelo): serve mode Streamable HTTP con edge autenticado por clave hasheada, aislamiento de límites por tenant y caché de metadata por tenant. Pendiente de rebasar sobre `main` post-0.5.0 (conflictos esperados en `src/config.ts`), probar levantado en local y solo entonces integrar. |
| Wiring interactivo del asistente `init` | Sin muelle de inyección de prompts: se cubre de forma indirecta. |

> **Advertencia de cierre:** mientras §9 mantenga abierto alguno de sus vectores, la allowlist **no debe presentarse como una frontera de confidencialidad completa** en la documentación de seguridad. Debe declararse su alcance exacto (acceso directo + rutas de navegación + `$expand`) y sus dos huecos conocidos, tal como exige FR-150.
