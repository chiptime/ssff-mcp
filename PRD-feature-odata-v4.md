# PRD: Evaluación y Soporte de OData v4 en SAP SuccessFactors

| Metadato | Valor |
|---|---|
| **Documento** | PRD-feature-odata-v4.md |
| **Versión** | v1.0 |
| **Estado** | PROPUESTO / EVALUADO (Recomendación: NO-GO para implementación inmediata; Arquitectura y Gates definidos) |
| **Fecha** | 2026-10-14 |
| **Autores** | Subagente de Investigación & Arquitectura ssff-mcp |
| **Alineación previa** | archive/PRD.md (v0.4, D-01..D-25), archive/PRD-phase2.md (D-26..D-32), archive/PRD-phase3.md (D-33..D-44), archive/PRD-phase4.md (D-45..D-52) |

---

## Resumen Ejecutivo

Este documento define la evaluación técnica exhaustiva, el diseño de arquitectura y el análisis de viabilidad para incorporar soporte del protocolo **OData v4** en el servidor MCP `ssff-mcp`.

En las fases iniciales del proyecto (MVP y Fase 2), OData v4 fue considerado como una posible ampliación (FR-18..FR-21), pero fue formalmente congelado y descartado mediante la **Decisión D-26** tras verificar empíricamente que las sondas de descubrimiento (`GET /odata/v4/` y `GET /odata/v4/$metadata`) contra el tenant de producción `clecesa` (`api2.successfactors.eu`) devolvían **HTTP 404 Not Found**.

La investigación actual revela las causas fundamentales de ese comportamiento, documenta el estado real de adopción de OData v4 en la plataforma SAP SuccessFactors, establece el diseño arquitectónico necesario para una coexistencia dual v2/v4 sin romper los contratos estrictos de las Fases 1 a 4, y evalúa el esfuerzo y los riesgos asociados.

**Conclusión y Recomendación:** Se recomienda un **NO-GO** para el desarrollo inmediato de OData v4 en la versión actual (0.2.x). El 95%+ del catálogo de datos consumido por clientes de SuccessFactors (Core HR / Employee Central) reside y opera exclusivamente en OData v2. Desarrollar OData v4 sin un tenant que lo tenga aprovisionado y verificado violaría el principio empírico de diseño de `ssff-mcp`, introduciendo deuda técnica y riesgo de regresión sobre una librería monolítica altamente contrastada. Se definen puertas de enlace (*gates*) estrictas para su reapertura.

---

## 1. Estado Real de OData v4 en SAP SuccessFactors

### 1.1 Disponibilidad y Topología de Servicios
A diferencia de OData v2, que en SuccessFactors se presenta como un servicio monolítico y consolidado bajo un único *service root* (`https://<API-Server-Host>/odata/v2/`), SAP ha diseñado OData v4 bajo una **arquitectura desacoplada y modular**.

1. **No existe un endpoint monolítico `/odata/v4/`**:
   - En la suite SAP SuccessFactors HXM, no existe una raíz universal `/odata/v4/` ni un `$metadata` único que contenga todo el catálogo de la suite.
   - OData v4 se expone a través de endpoints de dominio bajo la estructura de rutas:
     $$\text{https://<API-Server-Host>/odatav4/<namespace>/<service>/<version>/}$$
     *(Nótese la ausencia de barra entre `odata` y `v4`: `/odatav4/`)*.
     *Ejemplo:* `https://api2.successfactors.eu/odatav4/talent/cdp/v1/$metadata`

2. **Cobertura Funcional por Módulo**:
   - **Core HR / Employee Central (EC)**: **Puramente OData v2**. Entidades troncales como `User`, `EmpEmployment`, `EmpJob`, `PerPerson`, `PerPersonal`, `FOCompany`, etc., no están migradas a OData v4 de forma unificada. Todos los paquetes estándar de integración de SAP (SAP Integration Suite / CPI) y conectores oficiales siguen operando sobre `/odata/v2/`.
   - **Recruiting (RCM)**: Posee servicios OData v4 especializados y más recientes (p. ej. APIs de Candidate y Job Application para integraciones ATS de alta demanda), aunque coexiste con el modelo v2.
   - **Talent Management & CDP (Career Development Planning)**: Servicios modulares bajo `/odatav4/talent/...`.
   - **Audit Log Service**: Expone eventos de auditoría y lecturas críticas de cumplimiento sobre arquitecturas modernas V4/REST.
   - **Metadata Framework (MDF) Custom Objects & SAP BTP**: Soporte V4 orientado a extensiones en SAP Build y SAP Business Technology Platform.

### 1.2 Análisis Forense: Por qué `clecesa` devolvió 404 (Decisión D-26)
El 2026-10-01, una sonda en vivo sobre el tenant de producción `clecesa` (`api2.successfactors.eu`) arrojó:
- `GET /odata/v4/` $\rightarrow$ **404 Not Found**
- `GET /odata/v4/$metadata` $\rightarrow$ **404 Not Found**

**Causas técnicas confirmadas:**
1. **Ruta base incorrecta en la sonda**: Se probó `/odata/v4/` en lugar del prefijo oficial `/odatav4/`.
2. **Ausencia de endpoint raíz general**: Invocaciones a la raíz `/odatav4/` sin especificar namespace y servicio devuelven 404 en el API Gateway de SAP, ya que el dispatching se realiza por microservicio.
3. **Aprovisionamiento y permisos del Tenant**: Los servicios OData v4 requieren que el módulo correspondiente esté activado en Provisioning, cuente con licencias activas y el usuario API tenga permisos RBP (*Manage Integration Tools $\rightarrow$ Access to OData API*, más permisos específicos de dominio). En `clecesa`, configurado primordialmente como tenant de Core HR, los servicios V4 modulares no se encuentran enrutados ni requeridos.

La decisión **D-26** fue completamente acertada al detener la inversión de esfuerzo sobre una hipótesis no verificada en producción.

---

### 1.3 Diferencias Estructurales y Gramaticales: OData v2 vs. OData v4

| Dimensión | OData v2 (Actual en `ssff-mcp`) | OData v4 (Objetivo de Evaluación) |
|---|---|---|
| **Formato de Carga Útil** | JSON o Atom XML (`Accept: application/atom+xml`) | **JSON estricto** (Atom XML deprecado / no soportado en SAP SF V4) |
| **$metadata (CSDL)** | EDMX 1.0 (`http://schemas.microsoft.com/ado/2007/06/edmx`) | EDMX 4.0 / OASIS (`http://docs.oasis-open.org/odata/ns/edmx`) |
| **Relaciones en EDMX** | Elementos globales `<Association>` y `<AssociationSet>` en el `<EntityContainer>` | **Eliminados `<Association>` y `<AssociationSet>`**. `<NavigationProperty>` inline en `<EntityType>` y `<NavigationPropertyBinding>` en `<EntitySet>` |
| **Tipos de Datos** | `Edm.DateTime` (serializado como `/Date(1580000000000)/`), `Edm.Time` | `Edm.Date`, `Edm.TimeOfDay`, `Edm.Duration`, serializados como strings ISO-8601 nativos |
| **Tipos Complejos / Enums** | Limitados; sin tipos enumerados nativos | `<EnumType>` y `<ComplexType>` tipados con herencia y validación |
| **Envoltorio Feed (Colección)** | `{ "d": { "results": [ ... ], "__count": "100", "__next": "..." } }` | `{ "@odata.context": "...", "@odata.count": 100, "@odata.nextLink": "...", "value": [ ... ] }` |
| **Envoltorio Single Entity** | `{ "d": { "userId": "admin", ... } }` | `{ "@odata.context": "...", "userId": "admin", ... }` (Objeto plano, **sin** clave `d`) |
| **Paginación** | `d.__next` con parámetro `$skiptoken` propietario | `@odata.nextLink` con token de continuación estándar |
| **Conteo de Registros** | `$inlinecount=allpages` $\rightarrow$ `d.__count` (string o número) | `$count=true` $\rightarrow$ `@odata.count` (entero nativo). `$inlinecount` es **inválido** en v4 |
| **Operadores de Filtro** | `substringof('val', Field)`, `startswith`, `endswith` | `contains(Field, 'val')`, `startswith`, `endswith`, operador `in` |
| **Expansiones anidadas** | `$expand=nav&$select=nav/prop` (plano) | `$expand=nav($select=prop;$filter=...;$top=...)` (anidado) |
| **$batch: Mecanismo** | Multipart MIME (`multipart/mixed; boundary=...`) | Multipart MIME (OData 4.0) o **JSON Batching** (`application/json`) (OData 4.01) |
| **$batch: Límite SAP SF** | **Máximo 180 peticiones** por lote (D-28, R9) | **Máximo 50 peticiones** por lote (Límite estricto de SAP en OData V4) |
| **$batch: Ámbito** | Monolítico: `POST /odata/v2/$batch` aplica a toda entidad | Modular: `POST /odatav4/<module>/$batch` circunscrito al servicio |

---

## 2. Arquitectura de Coexistencia en `ssff-mcp`

Para incorporar OData v4 sin quebrar los contratos inmutables de Fase 1 a Fase 4, se debe diseñar una coexistencia limpia basada en invariantes estrictas.

### 2.1 Invariantes del Producto (No Negociables)
1. **Read-only / GET-only estricto**: No se añade ninguna mutación. Las únicas excepciones POST siguen siendo la obtención de tokens OAuth y el sobre `$batch` GET-only.
2. **Cero Normalización de Esquema (D-19, FR-24)**: Los registros se devuelven preservando fielmente los nombres y valores de campo que emite SAP. No se intentará convertir fechas `/Date(...)` a ISO en v2, ni aplanar objetos v4 para que parezcan v2.
3. **Seguridad y Errores Sanitizados**: Cero filtrado de credenciales, tokens o URLs en logs o mensajes de error (`SanitizedError`).
4. **Cursors Opacos y Stateless (D-27)**: El token de cursor se genera con HMAC-SHA256 en memoria, vinculando `{environment, entityPath, options, protocol}`. Un cursor emitido para una consulta OData v2 **nunca** podrá reusarse en una consulta OData v4.

---

### 2.2 Estrategia de Enrutamiento y Detección de Protocolo

#### Opción A: Protocolo a nivel de Entorno (Descartada)
Obligar a que un entorno sea puramente v2 o v4 (`protocol: "v4"`) no refleja la realidad de SAP, donde el mismo tenant aloja Core HR en v2 y módulos especializados en v4.

#### Opción B: Protocolo Mixto mediante Mapeo de Servicios y Allowlist (Aprobada)
1. **Configuración de Entorno (`config.json`)**:
   El entorno mantiene su `baseUrl` base (p. ej. `https://api2.successfactors.eu`). Se introduce una sección opcional de servicios v4:
   ```json
   {
     "environments": {
       "prod": {
         "baseUrl": "https://api2.successfactors.eu",
         "auth": { "type": "oauth", ... },
         "v4Services": {
           "Candidate": "odatav4/talent/candidate/v1",
           "AuditLog": "odatav4/audit/log/v1"
         }
       }
     }
   }
   ```
2. **Semántica de `entityAllowlist` (D-15, D-30)**:
   Actualmente el código en `src/allowlist.ts` ya contempla:
   ```typescript
   export type AllowlistProtocol = "v2" | "v4";
   export interface AllowlistEntry {
     entity: string;
     protocols?: AllowlistProtocol[];
   }
   ```
   - Si una entidad lista `protocols: ["v2"]`, solo se podrá consultar por v2.
   - Si lista `protocols: ["v4"]`, solo por v4.
   - Si se omite `protocols`, está permitida en ambos (sujeto a disponibilidad en el catálogo).

3. **Herramientas MCP (`query_entity` y `batch_get`)**:
   Se añade un argumento opcional:
   ```typescript
   protocol: z.enum(["v2", "v4"]).optional().default("v2")
   ```
   - Por defecto es `"v2"`, garantizando **100% de compatibilidad hacia atrás** con prompts, clientes y tests existentes.
   - Si el LLM solicita `protocol: "v4"`, se valida que la entidad admita v4 en la allowlist y que el servicio modular esté resuelto.

---

### 2.3 Procesamiento de Respuestas: `unwrapODataV4`
Se introduce en `src/odata.ts` una función análoga a `unwrapODataV2`:

```typescript
export function unwrapODataV4(body: unknown): UnwrappedFeed {
  if (typeof body !== "object" || body === null) {
    throw new SanitizedError("RESPONSE_INVALID", "the service response is not an OData v4 JSON document");
  }
  const root = body as Record<string, unknown>;
  
  let records: unknown[];
  let hasMore = false;
  let nextUrl: string | null = null;

  if (Array.isArray(root.value)) {
    // Feed de colección
    records = root.value;
    const nextLink = root["@odata.nextLink"];
    if (typeof nextLink === "string" && nextLink.length > 0) {
      hasMore = true;
      nextUrl = nextLink;
    }
  } else {
    // Entidad individual directa (sin envelope 'value' ni 'd')
    records = [root];
  }

  // En v4 el conteo viene en @odata.count como número entero
  const totalCount = parseTotalCount(root["@odata.count"]);

  let truncatedToCeiling = false;
  if (records.length > RECORD_CEILING) {
    records = records.slice(0, RECORD_CEILING);
    truncatedToCeiling = true;
  }

  return { records, hasMore, truncatedToCeiling, nextUrl, totalCount };
}
```

*Regla sobre XML en V4:* OData v4 en SAP SuccessFactors no produce payloads Atom XML. Si una petición v4 solicita `output: "xml"`, el servidor devolverá de inmediato `SanitizedError("OPTION_INVALID", "xml output is not supported for OData v4 services")`.

---

### 2.4 Cursors y Paginación en V4
- `extractSkiptoken` continuará parseando `@odata.nextLink` para extraer la semilla de paginación (`$skiptoken`).
- El cursor generado por `encodeContinuationCursor` incluirá en su carga HMAC:
  $$\text{payload} = \{\text{env}, \text{path}, \text{options}, \text{protocol: "v4"}, \text{skiptoken}\}$$
- Si el cliente intenta utilizar un cursor v4 enviando `protocol: "v2"`, la verificación de HMAC o el desacople de binding fallará con `CURSOR_INVALID`.

---

### 2.5 Tratamiento de `$batch` en V4
En OData v4, `$batch` introduce dos restricciones críticas:
1. **Límite de Peticiones**: Mientras que OData v2 permite hasta 180 peticiones por lote, **OData v4 en SAP impone un techo duro de 50 peticiones**. Si la llamada MCP especifica `protocol: "v4"` y el array `requests` contiene más de 50 elementos, `batch_get` rechazará la petición preflight con `SanitizedError("OPTION_INVALID", "batch requests for OData v4 exceed the maximum limit of 50 items")`.
2. **Formato del Lote**:
   - OData 4.0 admite multipart MIME `multipart/mixed`.
   - OData 4.01 admite JSON Batching (`{"requests": [...]}`).
   - Debido a que cada servicio v4 es un microservicio con su propio endpoint `$batch` (p. ej. `/odatav4/talent/cdp/v1/$batch`), no es posible mezclar peticiones de diferentes servicios v4 dentro del mismo `$batch`.

---

## 3. Análisis de Viabilidad Técnica

### 3.1 Dependencias Externas

1. **Parser EDMX (Metadatos)**:
   - **Situación actual**: `fast-xml-parser` (v5.0.0) se utiliza en `src/metadata.ts`.
   - **Impacto**: `fast-xml-parser` puede procesar XML CSDL 4.0 sin requerir dependencias adicionales de npm.
   - **Cambios necesarios**: Se requiere una reescritura sustancial de la lógica de transformación en `src/metadata.ts`:
     * En CSDL 4.0, las etiquetas `<Association>` y `<AssociationSet>` **no existen**.
     * Las propiedades de navegación se declaran directamente en el `<EntityType>`:
       `<NavigationProperty Name="Manager" Type="EmpJob" Partner="..." />`
       o para colecciones:
       `<NavigationProperty Name="DirectReports" Type="Collection(EmpJob)" />`
     * La cardinalidad (`0..1`, `1`, `*`) debe deducirse inspeccionando si el atributo `Type` está envuelto en `Collection(...)` y el atributo `Nullable`.
     * Los enlaces a los EntitySets destino se deben resolver parseando `<NavigationPropertyBinding Path="..." Target="..." />` dentro de cada `<EntitySet>` en el `<EntityContainer>`.

2. **Librería `$batch`**:
   - **Situación actual**: `ssff-mcp` utiliza `odata-batch` (v2.1.0, mantenida por `chiptime`).
   - **Impacto**: `odata-batch` está diseñada **exclusivamente para OData v2**. Sus constructores de peticiones generan cabeceras rígidas v2 y su parser está optimizado para multipart v2.
   - **Alternativas**:
     - *Opción 1*: Extender `odata-batch` a v3.0.0 para soportar OData v4 (multipart y JSON batching).
     - *Opción 2*: Implementar un serializador y deserializador nativo y ligero de JSON Batching dentro de `ssff-mcp` (GET-only, sin changesets).
     - *Opción 3*: Limitar el soporte v4 inicial a consultas individuales `query_entity` y dejar `batch_get` exclusivo para v2.

---

### 3.2 Viabilidad de Desarrollo sin un Tenant Real con V4 Activo
**DIAGNÓSTICO: ALTO RIESGO / NO VIABLE PARA DESPLIEGUE A PRODUCCIÓN.**

La historia del desarrollo de `ssff-mcp` a lo largo de las Fases 1 a 4 demuestra que **SAP SuccessFactors posee peculiaridades y comportamientos no documentados que solo se detectan mediante sondas en vivo contra tenants reales**:
- La respuesta `406 Not Acceptable` cuando se pedía `application/xml` en datos de entidad (forzando el uso estricto de `application/atom+xml`).
- El hecho de que `$batch` de SAP no decodifica percent-encoding (`%24top` se ignora silenciosamente dentro de un lote a menos que se reescriba como `$top`).
- El formato exacto en base64 de `$skiptoken` (`{"startRow":1000,"endRow":2000}`).
- El propio 404 al intentar `/odata/v4/`.

Implementar OData v4 en base a mocks y especificaciones teóricas de OASIS sin validar contra un tenant real de SuccessFactors con servicios V4 aprovisionados conllevará casi con total certeza errores sutiles de serialización, rechazos de cabeceras o fallos en el enrutamiento.

---

## 4. Estimación de Esfuerzo, Riesgos y Criterios Go / No-Go

### 4.1 Desglose de Esfuerzo

| Tarea / Módulo | Descripción | Esfuerzo Estimado |
|---|---|---|
| **T1: Dual CSDL Parser (`metadata.ts`)** | Soporte de EDMX v4 CSDL (detección de versión, parsing de NavigationProperty, NavigationPropertyBinding, enums, tipos complejos y cardinalidad). | 4 días |
| **T2: Enrutamiento Modular (`http.ts` & `config.ts`)** | Soporte de esquemas modulares `/odatav4/<ns>/<srv>/<v>/`, resolución de URLs dinámicas por entidad y mapeo de servicios en configuración. | 3 días |
| **T3: Gramática OData v4 (`odata.ts`)** | `unwrapODataV4`, adaptación de `$count=true` vs `$inlinecount`, sintaxis de `$filter` (`contains`), bloqueo de XML en v4. | 3 días |
| **T4: Cursors Stateless v4 (`cursor.ts` & `tools.ts`)** | Integración de `@odata.nextLink`, discriminador de protocolo en el HMAC del cursor y validación de binding. | 2 días |
| **T5: Batch Transport v4 (`batch.ts`)** | Adaptación de límites a 50 peticiones y soporte de JSON Batching o multipart v4. | 4 días |
| **T6: Testing & Fixtures** | Tests unitarios, fixtures de EDMX v4 reales y suites de regresión sin alterar la suite v2 (238 tests existentes). | 3 días |
| **Total Estimado** | | **19 días hombre (~4 semanas de desarrollo)** |

---

### 4.2 Matriz de Riesgos

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| **Regresión en Contratos v2** | Baja | Crítico | Mantener la suite de tests actual (238/238 green) intacta. El protocolo por defecto se fija siempre en `"v2"`. |
| **Discrepancia de Comportamiento en Producción** | Alta | Alto | No habilitar endpoints v4 en producción sin haber ejecutado sondas previas con éxito. |
| **Incompatibilidad de `$batch`** | Media | Medio | Inicialmente permitir v4 en `query_entity` y mantener `batch_get` en v2 hasta validar la respuesta del gateway SAP. |
| **Complejidad de Configuración para el Usuario** | Media | Medio | El CLI wizard (`ssff-mcp init`, Fase 4) mantendrá la detección automática por defecto en v2. |

---

### 4.3 Criterios de Entrada: Puertas de Decisión (Go / No-Go Gates)

Para que el proyecto inicie formalmente la implementación de esta feature, se deben satisfacer **todos** los siguientes criterios:

1. **Gate 1: Disponibilidad de Tenant Verificado (Bloqueante)**
   - Un usuario o cliente debe proporcionar acceso a un tenant de SuccessFactors donde al menos un servicio OData v4 esté formalmente aprovisionado y responda HTTP 200 a `$metadata` (p. ej. `/odatav4/talent/...`).
2. **Gate 2: Demanda Funcional Específica (Caso de Negocio)**
   - Debe existir un requerimiento de lectura sobre datos que **únicamente** se encuentren expuestos vía OData v4 (p. ej. nuevas capacidades de Talent Intelligence o Audit Logs) y no estén disponibles en OData v2.
3. **Gate 3: Validación Empírica de Batch**
   - Se debe verificar mediante sonda curl/fetch si el servicio v4 del tenant responde a multipart MIME o a JSON Batching y confirmar empíricamente el comportamiento ante errores.

---

### 4.4 Decisión Final y Recomendación

**ESTADO ACTUAL: NO-GO PARA IMPLEMENTACIÓN INMEDIATA.**

**Justificación:**
1. El 100% de los casos de uso actuales del usuario y del ecosistema de testing (incluyendo `clecesa`) se satisfacen mediante OData v2.
2. Invertir ~4 semanas de desarrollo en una feature cuyo endpoint principal devuelve 404 en el entorno de referencia supone un desperdicio de recursos sin retorno inmediato.
3. El diseño de arquitectura detallado en la **Sección 2** de este PRD queda completamente preparado y congelado, listo para ser ejecutado tan pronto como se superen los *Gates* 1 y 2.
