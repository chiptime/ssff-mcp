# PRD: Fidelidad OData de ssff-mcp para consultas de empleados (encoding, gramática de paths y effective-dating)

| Metadato | Valor |
|---|---|
| **Documento** | PRD-feature-odata-query-fidelity.md |
| **Versión** | v1.0 |
| **Estado** | CONFIRMADO (CONFIRMED) — decisiones y hallazgos empíricos verificados por el propietario (2026-10-14); autoriza handoff a implementación (SDD) |
| **Fecha** | 2026-10-14 (v0.1 DRAFT → v1.0 CONFIRMED el mismo día) |
| **Autores** | Sesión opencode (workspace operational-centers) + Bruno |
| **Alineación previa** | PRD.md (D-01..D-25), PRD-phase2.md (D-26..D-32), PRD-phase3.md (D-33..D-44), PRD-phase4.md (D-45..D-52), PRD-feature-odata-v4.md, PRD-feature-custom-mdf.md (usa D-62..D-70, D-75 y FR-67..FR-76, FR-86), PRD-feature-picklists.md, PRD-feature-hr-prompts.md. Este PRD es dueño de **D-71..D-74** y **FR-77..FR-85**: colisión cero con custom-mdf y con el resto de PRDs. |

---

## Resumen Ejecutivo

La skill de opencode `clece-sf-search-employees` (búsqueda de empleados activos/inactivos, bajas por `eventReason` y adjuntos documentales en los tenants Clece) debe ejecutar **todas** sus consultas a través de las tools de `ssff-mcp`. Hoy no puede: dos defectos del transporte impiden las consultas filtradas y las keys compuestas que el propio backend de operational-centers usa en producción, y un tercero (effective-dating) impide reproducir las ventanas temporales del catálogo.

Este PRD define tres mejoras quirúrgicas — codificación de valores de opciones de query (M1), gramática de literales en key predicates (M2) y paso explícito de effective-dating con nombres bare `fromDate`/`toDate`/`asOfDate` (M4) — más su batería de tests con **test de paridad** contra el patrón de referencia de operational-centers (M3). Con M1+M2+M3+M4, la skill queda reducida a conocimiento de dominio puro: el catálogo de queries de `IdentificationGetController` pasa a ser ejecutable tal cual por el MCP.

**Decisión marco (D-74):** la skill NUNCA lee la configuración del MCP ni llama a la API de SF por su cuenta; todo el acceso queda dentro de las tools del MCP (auth, saneamiento y allowlist únicos). En consecuencia, el MCP debe cubrir las casuísticas que hoy solo cubre el backend.

---

## 1. Contexto y Problema (evidencia empírica del 2026-10-13/14)

Sesión real de caza de casos de recontratación en `clecesaT2` (TEST). Cadena de fallos observada:

| # | Consulta | Resultado | Causa raíz |
|---|---|---|---|
| 1 | `filter: "status eq 't'"` sobre `User` | 400: SF recibe `status+eq+'t'` | `buildQuery` construye la query con `URLSearchParams` (`src/odata.ts:130-155`), que codifica espacio como `+` |
| 2 | `filter: "status%20eq%20't'"` | 400: SF recibe `%20` literal | El mismo encoding convierte `%`→`%25`; SF decodifica una vez y ve `%20` como caracteres |
| 3 | Key `PaymentInformationDetailV3(PaymentInformationV3_effectiveStartDate=datetime'2013-01-01T00:00:00',...)` | `PATH_INVALID` antes de despachar | La gramática `LITERAL` (`src/odata.ts:23`) solo acepta cadenas entrecomilladas y enteros/decimales: sin prefijos tipados (`datetime'...'`) ni sufijos numéricos (`860259L`) |
| 4 | `orderby: "startDate desc"` | 400: `startDate+desc` | Mismo defecto #1 |

**Patrón de referencia que SÍ funciona en producción** (operational-centers, `recruiting-backend/main`):

- `srv/shared/infrastructure/OData/ODataQuery.ts:19-31` — `getQuery` concatena **crudo**: `$filter=${_filter}` con espacios literales.
- `node_modules/odata-batch/dist/request.js:33` — la request line del `$batch` se escribe sin codificar: `method + ' ' + val.url + ' HTTP/1.1'`.
- `srv/shared/infrastructure/SuccessFactorsRepository.ts` — solo añade `Authorization: Bearer`.

Es decir: **SF acepta la URL interna del batch con espacios en crudo**; el único punto que rompe es el `URLSearchParams` del MCP. Verificación adicional del 2026-10-14: `fetch` directo con espacio→`%20` también funciona contra el mismo tenant (ambas formas, cruda y `%20`, son válidas; `+` no).

### 1.1 Verificación empírica de effective-dating (TEST_basic, 2026-10-14)

Hallazgos verificados contra `TEST_basic`:

1. SAP SuccessFactors OData v2 **ignora silenciosamente** `$fromDate`, `$toDate` y `$asOfDate` cuando llevan prefijo `$` (el servicio cae de vuelta al slice vigente actual, sin error).
2. Solo los nombres **bare** `fromDate`, `toDate` y `asOfDate` (sin `$`) son reconocidos por SAP SF OData v2 — tanto en GET directo como dentro de `$batch`.
3. En operational-centers (`identificationReadRepository.ts:48, 63, 86, 97, 153`), la query `$fromDate=1970-01-12&toDate=9999-12-31` solo **parecía** funcionar: `toDate` iba sin `$` (reconocido) mientras `$fromDate` era silenciosamente ignorado. El backend arrastra este defecto latente.
4. En entidades HRIS de Employee Central (`EmpJob`, `PerPersonal`), la visibilidad effective-dated aplica incluso en lookups de entidad única con key predicate: `EmpJob(seqNumber=1L,startDate=datetime'2013-01-01T00:00:00',userId='1000001')` devuelve `404 Not Found` sin `fromDate`/`toDate`, y `200 OK` con `fromDate=1970-01-12&toDate=9999-12-31`.

Consecuencia normativa: FR-81 pasa a MUST con nombres bare, válidos también en key predicates.

---

## 2. A. Objetivos y No-Objetivos

### Objetivos

1. **M1** — Los valores de `$filter`, `$orderby`, `$select` y `$expand` llegan a SF con espacio como `%20` y el resto de caracteres en crudo (mínima transformación, alineada con el patrón de referencia).
2. **M2** — La gramática de key predicates acepta literales tipados de OData v2 y sufijos numéricos de SF, habilitando keys compuestas reales del tenant.
3. **M3** — Tests de regresión unitarios + **test de paridad** byte-a-byte contra `ODataQuery.getQuery` de operational-centers (modulo el espacio→`%20` acordado) + humo de integración contra TEST.
4. **M4** — Paso explícito de effective-dating en ambas tools: `fromDate`, `toDate` y `asOfDate` opcionales, emitidos como nombres bare (sin `$`), válidos también en lecturas con key predicate, con validación de formato y binding al cursor.

### No-Objetivos

- Soporte OData v4 (NO-GO por D-26; ver PRD-feature-odata-v4.md).
- Parseo o validación semántica del contenido de `$filter`: el filtro sigue siendo pass-through; SF es el validador autoritativo. Solo cambia el transporte.
- Operaciones de escritura: el MCP sigue siendo read-only.
- Válvula de escape tipo `_queryParams` crudo (patrón `ODataQueryParams` del backend): **rechazada por ahora** (D-73) — contradice la filosofía de validación estricta del MCP y con M1+M2+M4 no es necesaria.
- Cualquier acceso fuera del MCP por parte de la skill (D-74).
- Corregir el defecto `$fromDate` del backend de operational-centers (fuera de este repo; aquí solo se documenta en §1.1).

---

## 3. B. Arquitectura y límites

Punto único de fix de M1/M2: `buildQuery()` y la gramática de segmentos (`src/odata.ts`), consumidos por `ssff_query_entity` (`src/tools.ts:445`) y `ssff_batch_get` (`src/tools.ts:596`). M4 añade las opciones de effective-dating en los esquemas de entrada y en `cursorBindingOptions` (`src/tools.ts:232`) de ambas tools.

El cambio es exclusivamente en la construcción del `pathAndQuery` y en las opciones aceptadas; el cuerpo multipart, el parser de respuestas y la allowlist no cambian. `toInnerRequestUrl` (`src/batch.ts:419`) no necesita cambios: con los nombres `$` emitidos en crudo ya no queda `%24` que decodificar y su `replaceAll("%24", "$")` pasa a ser un no-op inofensivo (compatibilidad preservada).

Límite de confianza: los valores de opciones provienen del llamador LLM. Hoy viajan (mal) codificados; mañana viajarán con `%20` y con un rechazo explícito de caracteres de control (§5, FR-80). No se introduce superficie nueva de inyección porque **no se parsea nada**: se transporta. La autorización real sigue siendo RBP del usuario API en SF.

---

## 4. C. Datos y estado

Sin cambios de estado persistente. El cursor (`src/cursor.ts`) sigue atado a argumentos; con v1.0, `cursorBindingOptions` incluye además `fromDate`/`toDate`/`asOfDate`, de modo que el cursor de continuación queda criptográficamente ligado a la ventana de effective-dating de la llamada original. Al cambiar la codificación, los cursors viejos firmados con otra representación de la URL quedan invalidados; es aceptable (mismo tratamiento que un reinicio de servidor) y **debe documentarse en changelog/docs** junto con el nuevo ensamblado crudo+`%20` (cierre de la pregunta de versión en §10).

---

## 5. D. Seguridad

- Invariantes intactos y verificados por test: segmentos de sistema (`$batch`, `$count`, `$value`, `$links`, `$metadata`) bloqueados; `MAX_PATH_LENGTH=512`; `MAX_SEGMENTS=4`; comilla sin cerrar rechazada; `PATH_INVALID` nunca hace echo del path.
- `%` pasa de "rechazado siempre" a "permitido solo como producto del encoding de espacio": la gramática de paths NO admite `%` crudo (sigue `PATH_INVALID`); los valores de opciones SÍ pueden contener `%` (necesario para el propio `%20`).
- **Nuevo invariante (FR-80)**: al dejar de pasar `$filter`, `$orderby`, `$select` y `$expand` por `URLSearchParams`, cualquier carácter de control `[\r\n\0]` en los valores de opciones DEBE rechazarse con `OPTION_INVALID` **antes** del ensamblado. Motivo: dentro del sobre multipart de `$batch`, las request lines HTTP se validan y separan por `\r\n` (`src/batch.ts:210`, `validateAndPrepareEnvelope`); un valor con saltos de línea permitiría inyectar request lines o cabeceras HTTP adicionales. La validación vive en `buildQuery`, antes de cualquier dispatch.
- Secretos: sin cambios (la config no se modifica; `SanitizedError` no hace echo).

---

## 6. Requisitos Funcionales (RFC 2119)

| ID | Requisito | Evidencia |
|---|---|---|
| **FR-77** (MUST) | `buildQuery` ensambla las opciones **sin** `URLSearchParams` para `$filter`, `$orderby`, `$select` y `$expand`: emite `$name=value` aplicando únicamente `value.replace(/ /g, "%20")` (espacios codificados uniformemente como `%20`) y preservando literalmente `'`, `+`, `,`, `/`, `(`, `)`, `:`, `=`, `;`. | `odata.ts:130-155` (estado actual con `URLSearchParams`); referencia `ODataQuery.ts:19-31` y `odata-batch/dist/request.js:33`; `%20` y crudo probados contra `clecesaT2` (2026-10-14) |
| **FR-78** (MUST) | `$skiptoken` sigue siendo opaco y se serializa como `$skiptoken=${encodeURIComponent(options.skiptoken)}`. Razón exacta: `extractSkiptoken` decodifica el parámetro vía `URL.searchParams.get("$skiptoken")` (`odata.ts:238-255`), por lo que el round-trip exige percent-encoding; así las llaves/comillas JSON de los skiptokens quedan percent-encoded y jamás rompen las request lines HTTP del `$batch` (comportamiento actual preservado, `test/odata.test.ts:205-210`). `toInnerRequestUrl` (`src/batch.ts:419`) sigue siendo compatible: sin `%24` residual, su `replaceAll` es un no-op inofensivo. | `odata.ts:144-148`; `test/odata.test.ts:205-210`; `batch.ts:419-421` |
| **FR-79** (MUST) | `LITERAL` (`src/odata.ts`) acepta: (a) prefijos tipados OData v2 **case-insensitive** `(?:datetime\|datetimeoffset\|time\|guid\|binary\|X\|decimal\|float\|double)'(?:[^']\|'')*'` anteponidos a cadenas entrecomilladas; (b) cadenas entrecomilladas simples `'(?:[^']\|'')*'`; (c) literales boolean/null `true\|false\|null`; (d) enteros/decimales con signo y sufijo numérico opcional — categoría `[-+]?\d+(?:\.\d+)?[LfFdDmM]?`, regex concreta `-?\d+(?:\.\d+)?[LfFdDmM]?`. El `%` crudo en `entityPath` sigue rechazado (`PATH_INVALID`). | Keys reales del tenant: `PaymentInformationDetailV3(PaymentInformationV3_effectiveStartDate=datetime'2013-01-01T00:00:00',PaymentInformationV3_worker='1000001',externalCode=860259L)`; `EmpJob(seqNumber=1L,...)` (metadata TEST 2026-10-13) |
| **FR-80** (MUST) | Invariantes de seguridad sin regresión: bloqueo de segmentos `$`, `MAX_PATH_LENGTH`, `MAX_SEGMENTS`, rechazo de comilla sin cerrar, `PATH_INVALID` sin echo del path; **más el nuevo invariante de §5**: cualquier carácter de control `[\r\n\0]` en valores de opciones se rechaza con `OPTION_INVALID` antes del ensamblado (anti-inyección de request-line/cabeceras en el sobre multipart de `$batch`). | `odata.ts:65-94`; `batch.ts:210` |
| **FR-81** (MUST) | `ssff_query_entity` y `ssff_batch_get` aceptan `fromDate`, `toDate` y `asOfDate` opcionales (formato `YYYY-MM-DD`, validado con `/^\d{4}-\d{2}-\d{2}$/`; fecha inválida, o combinación de `asOfDate` con `fromDate`/`toDate`, lanza `OPTION_INVALID`). Se emiten en la query string como `fromDate=<valor>`, `toDate=<valor>`, `asOfDate=<valor>` — nombres **bare**, SIN `$` (SF ignora silenciosamente las variantes con `$`; ver §1.1). Son válidos tanto en lecturas de colección (entity list) **como en lecturas con key predicate**. Se incluyen en `cursorBindingOptions` (`src/tools.ts`) para que el cursor de continuación quede criptográficamente ligado a la ventana de effective-dating. | Verificación empírica TEST_basic 2026-10-14 (§1.1); uso en `identificationReadRepository.ts:48, 63, 86, 97, 153` |
| **FR-82** (MUST) | Tests unitarios de encoding: espacio→`%20`; `+` literal intacto; `$` de nombres intacto; skiptoken percent-encoded con round-trip idéntico (`encodeURIComponent`); rechazo de `[\r\n\0]` en valores de opciones con `OPTION_INVALID`. | — |
| **FR-83** (MUST) | Tests unitarios de gramática: las dos keys reales de FR-79; negativos (segmento `$`, comilla sin cerrar, path > límites). | — |
| **FR-84** (MUST) | **Test de paridad**: para las mismas opciones (`$filter`/`$orderby`/`$select`/`$expand`), el `pathAndQuery` del MCP es idéntico al que produciría `ODataQuery.getQuery` del backend, salvo espacio→`%20`. Nota de alcance: el effective-dating **diverge deliberadamente** del backend (nombres bare) porque el `$fromDate` del backend es silenciosamente ignorado por SF (§1.1); la paridad no cubre esas opciones. | Referencia copiada como fixture del test |
| **FR-85** (SHOULD) | Humo de integración contra `TEST_basic` con las tres queries del catálogo `IdentificationGetController`: `cust_Documentos_Nacionales` y `cust_Otros_Requisitos_Obligatorios` por `externalCode eq`, `PaymentInformationDetailV3` por `PaymentInformationV3_worker eq`. | `identificationReadRepository.ts` (métodos `getDocuments`, `getBankCertificate`, `getOtherRequirements`) |

---

## 7. Decisiones

| ID | Decisión | Justificación |
|---|---|---|
| **D-71** | Encoding = concatenación cruda + espacio→`%20`, **uniforme para `$filter`, `$orderby`, `$select` y `$expand`** (pregunta de §10 cerrada: confirmado uniforme). Rechazadas: mantener `URLSearchParams` (rompe SF), `encodeURIComponent` completo sobre el valor (cambiaría `+` y otros caracteres con significado en filtro), `.replace(/\+/g,'%20')` global (corrompe `+` legítimo entre comillas). | Confirmado por usuario; alineado con patrón de producción de operational-centers; `%20` y crudo ambos probados contra `clecesaT2` |
| **D-72** | Gramática: prefijos tipados (incl. `binary`/`X`, case-insensitive) + boolean/null + sufijos numéricos; sin `%` crudo en paths. | Keys reales del `$metadata` del tenant; `%` solo como producto del encoding de valores |
| **D-73** | Sin escape hatch `_queryParams` (pospuesto). | Filosofía de validación estricta del MCP; no requerido por la skill con M1+M2+M4 |
| **D-74** | La skill `clece-sf-search-employees` accede SOLO vía tools del MCP; prohibido leer su config o llamar a SF directamente. | Decisión del propietario (2026-10-14); auth/auditoría únicas en el MCP |

Confirmaciones v1.0 registradas **sin nuevo ID** (el rango D-71..D-74 queda congelado para no colisionar con custom-mdf, dueño de D-62..D-70 y D-75):

- Effective-dating con nombres bare `fromDate`/`toDate`/`asOfDate`, validación `YYYY-MM-DD`, permitidos también en key predicates e incluidos en el cursor binding — normativizado en FR-81; cierra la pregunta correspondiente de §10.
- Nota obligatoria en changelog/docs: el cursor binding incluye las opciones de effective-dating y el ensamblado de la query pasa a crudo+`%20` (invalidación de cursors antiguos) — cierra la pregunta de versión de §10.

---

## 8. Verification & Acceptance

### 8.1 Niveles y disparadores

| Nivel | Qué | Cuándo dispara | Gate |
|---|---|---|---|
| **V1 — Tests automáticos** | Unitarios de encoding y gramática (FR-82, FR-83) + paridad (FR-84) | Cualquier cambio en `src/odata.ts` | CI / pre-commit |
| **V2 — Humo de integración versionado** | Script en `test/` que ejecuta las queries del catálogo contra `TEST_basic` y aserta resultados | Mismo disparador que V1; obligatorio para aprobar el cambio | verde en el PR |
| **V3 — UAT manual como usuario real** | Ejecutar la skill `clece-sf-search-employees` L1→L3 desde opencode (hunt de inactivos por reason + inventario de adjuntos) y verificar que ya no se necesita ninguna gimnasia | Por release; y en cualquier PR que toque `buildQuery` o la gramática | Checklist firmado antes de archivar |

Definición de clean-room adaptada (no hay sandbox de SF): V2 usa el tenant TEST con credenciales de `~/.config/ssff-mcp/config.json`, sin secretos en el repo ni en la salida.

### 8.2 Escenarios Gherkin

```gherkin
Scenario: Filtro con espacios llega íntegro a SF (FR-77, FR-82) [V1+V2]
  Given el tenant TEST_basic configurado
  When invoco ssff_query_entity con entityPath "User" y filter "status eq 'f'"
  Then la respuesta es 200 con rows cuyo status es 'f'
  And la request line interna contiene "status%20eq%20'f'" y ningún "+"

Scenario: Key compuesta con datetime literal (FR-79, FR-83) [V1+V2]
  Given el tenant TEST_basic configurado
  When invoco ssff_query_entity con entityPath "PaymentInformationDetailV3(PaymentInformationV3_effectiveStartDate=datetime'2013-01-01T00:00:00',PaymentInformationV3_worker='1000001',externalCode=860259L)"
  Then la respuesta es 200 con el registro del worker 1000001
  And el validador no emite PATH_INVALID

Scenario: Paridad con operational-centers (FR-84) [V1]
  Given el fixture de ODataQuery.getQuery del backend
  When construyo la query para filter/orderby/select/expand idénticos
  Then pathAndQuery es igual al fixture salvo espacio→"%20"

Scenario: Effective-dating en colección PerPersonal (FR-81) [V2]
  Given el tenant TEST_basic configurado
  When invoco ssff_query_entity con entityPath "PerPersonal", filter "personIdExternal eq '<id>'", fromDate "1970-01-12" y toDate "9999-12-31"
  Then la respuesta es 200 con el registro vigente
  And la query string lleva fromDate=1970-01-12 y toDate=9999-12-31 sin prefijo "$"

Scenario: Effective-dating en key predicate de EmpJob (FR-81) [V2]
  Given el tenant TEST_basic configurado
  When invoco ssff_query_entity con entityPath "EmpJob(seqNumber=1L,startDate=datetime'2013-01-01T00:00:00',userId='1000001')" sin effective-dating
  Then la respuesta es error HTTP 404 (HTTP_ERROR)
  When repito la llamada con fromDate "1970-01-12" y toDate "9999-12-31"
  Then la respuesta es 200 con el registro del job

Scenario: Validación de opciones de effective-dating (FR-81, FR-82) [V1]
  When invoco ssff_query_entity con fromDate "1970-1-12" (formato inválido)
  Or combino asOfDate "2026-10-14" con fromDate "1970-01-12"
  Or incluyo un salto de línea en filter
  Then cada error es OPTION_INVALID, sin echo del valor
  And no se despacha ninguna petición HTTP

Scenario: Caza E2E de la skill (FR-77..FR-85) [V2+V3]
  Given la skill clece-sf-search-employees instalada
  When ejecuto "terminated --reason-prefix ZB" equivalente vía MCP (censo + jobInfoNav + adjuntos)
  Then obtengo la tabla userId/nombre/DNI/motivo/baja sin ningún paso fuera del MCP
  And el resultado lleva timestamp de verificación
```

### 8.3 Matriz FR × Verificación

| FR | V1 | V2 | V3 | Escenario |
|---|---|---|---|---|
| FR-77 | ✔ | ✔ | ✔ | Filtro con espacios |
| FR-78 | ✔ | — | — | (cubierto por unit skiptoken) |
| FR-79 | ✔ | ✔ | ✔ | Key compuesta datetime |
| FR-80 | ✔ | — | — | Negativos de gramática y control chars |
| FR-81 | ✔ | ✔ | — | Effective-dating (colección, key predicate, validación) |
| FR-82 | ✔ | — | — | Unit encoding |
| FR-83 | ✔ | — | — | Unit gramática |
| FR-84 | ✔ | — | — | Paridad |
| FR-85 | — | ✔ | ✔ | Humo catálogo / E2E skill |

---

## 9. Métricas de éxito

- Suite V1 y V2 en verde; cero regresiones en los tests existentes del repo.
- La skill ejecuta sus niveles 1-3 sin salirse del MCP (verificable: ninguna llamada HTTP fuera de las tools en la sesión de uso).
- Consultas del catálogo `IdentificationGetController` replicables 1:1 por un agente sin workarounds.

---

## 10. Preguntas cerradas y supuestos

- **CERRADA (confirmada)** — Tratamiento `%20` uniforme: aplicar el espacio→`%20` de forma uniforme a `$filter`, `$orderby`, `$select` y `$expand`. **Confirmado uniforme** (D-71, FR-77).
- **CERRADA (confirmada por el usuario)** — Inclusión de `asOfDate` junto a `fromDate`/`toDate`: nombres bare sin `$`, validación `YYYY-MM-DD`, permitidos también en key predicates, incluidos en el cursor binding (FR-81).
- **CERRADA (confirmada)** — Versión / nota de cursor: el changelog y la documentación deben registrar que el cursor binding incluye las opciones de effective-dating y que el ensamblado de la query pasa a crudo+`%20` (con la consiguiente invalidación de cursors antiguos, ya tratada en §4).
- **ASSUMPTION**: el parser de `$batch` de SF decodifica `%XX` exactamente una vez en las URLs internas (evidencia empírica del 2026-10-13; reforzada el 2026-10-14: los nombres bare `fromDate`/`toDate`/`asOfDate` se comportan idéntico en GET directo y dentro de `$batch`; no hay cita de documentación SAP). El humo V2 lo valida con datos reales.
