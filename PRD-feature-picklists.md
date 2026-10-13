# PRD — ssff-mcp: Resolución Automática y Consulta de Picklists (Etiquetas vs. IDs en SAP SuccessFactors OData v2)

| Campo | Valor |
|---|---|
| Estado | **PROPOSED v1.0** — Especificación arquitectónica y funcional completa lista para revisión y desarrollo |
| Fecha | 2026-10-14 |
| Autor | Research & Architecture Team (ssff-mcp) |
| Fuente de decisiones | Requerimiento de usabilidad para agentes LLM en SuccessFactors OData v2; superación de la opacidad de Option IDs numéricos y códigos de selección |
| Idioma | Español neutro profesional; identificadores y términos de código en inglés |
| Relación con PRD anteriores | **Extiende** `PRD.md` (Fase 1), `PRD-phase2.md` (Fase 2), `PRD-phase3.md` (Fase 3) y `PRD-phase4.md` (Fase 4). Incorpora decisiones **D-53..D-61**, requisitos funcionales **FR-56..FR-66** e implicaciones de seguridad/arquitectura **DS-PL-01..DS-PL-06** |
| Palabras clave normativas | **MUST / MUST NOT / SHOULD / MAY** según RFC 2119 |

---

## 0. Registro de Decisiones (Ledger)

| ID | Decisión | Origen / Justificación |
|---|---|---|
| **D-53** | **Enfoque Dual: Tool dedicada `resolve_picklist` y Enriquecimiento Opcional en Lectura**: ssff-mcp implementa dos mecanismos complementarios: (1) una herramienta dedicada `resolve_picklist` para exploración, traducción directa y búsqueda inversa de IDs/códigos para construcción de `$filter`; y (2) un parámetro opcional `resolvePicklists: boolean` (por defecto `false`) en `query_entity` y `batch_get` para enriquecimiento inline de respuestas. | Permite al LLM planificar filtros precisos antes de consultar datos y, a su vez, interpretar datos ya recuperados sin incurrir en llamadas sucesivas adicionales. |
| **D-54** | **Caché Jerárquica L1/L2 con TTL Prolongado (30 días en disco, 24 horas en memoria)**: Dado que las picklists en SuccessFactors constituyen datos maestros de configuración (*System Configuration Data*) que rara vez cambian (< 0.1% semanal), se establece una caché en memoria L1 (en proceso) y una caché persistente en disco L2 por entorno (`~/.cache/ssff-mcp/picklists-<alias>.json`) con TTL de 30 días, invalidable bajo demanda o forzada con `forceRefresh: true`. | Elimina la latencia de red en runtime (0 ms para opciones cacheadas) y previene la saturación de cuotas API de SAP. Coherente con D-43/D-44. |
| **D-55** | **Soporte Unificado de Coexistencia: Legacy Picklists (`PicklistOption`) y MDF Picklists V2 (`PickListValueV2`)**: El motor de resolución soporta de forma transparente tanto el modelo legacy de Employee Central (`PicklistOption` con `optionId` numérico de 64 bits tipo `10283L` y `PicklistLabel`) como el modelo MDF (`PickListValueV2` con `externalCode`, `legacyOptionId` y campos de idioma `label_<locale>`). | En tenants reales coexisten ambos modelos: las entidades estándar de EC Core siguen usando IDs numéricos mientras que los objetos MDF usan códigos alfanuméricos. |
| **D-56** | **Zero-Config Discovery mediante Anotaciones EDMX `sap:picklist` y `*Nav`**: `MetadataService` extrae automáticamente durante el parseo de `$metadata` qué propiedades están vinculadas a picklists analizando el atributo de anotación `sap:picklist` y las propiedades de navegación hacia `PicklistOption` o `PickListValueV2`. | Elimina la necesidad de mapear manualmente campos a picklists en archivos de configuración; el servidor sabe dinámicamente qué campos resolver. |
| **D-57** | **Enriquecimiento No Destructivo con Metadatos Aditivos `_picklistLabels`**: El enriquecimiento automático en `query_entity` y `batch_get` preserva estrictamente el valor y tipo nativo de cada propiedad original (garantizando D-24 y D-32). Añade un subobjeto aditivo `_picklistLabels` por registro con `{ label, externalCode, picklistId, resolved: true/false }`. | Evita romper parsers o pipelines existentes que esperen el ID numérico nativo, proporcionando a la vez el contexto semántico completo al LLM. |
| **D-58** | **Independencia de `entityAllowlist` para Catálogos Internos del Servidor**: Las consultas internas ejecutadas por `PicklistService` para hidratar la caché se consideran operaciones de metadatos de sistema (análogas a `$metadata` según FR-19) y están exentas del filtro de `entityAllowlist`. Si un usuario consulta `query_entity("PicklistOption")` directamente, la allowlist sí se aplica. | Permite que una allowlist orientada a negocio (ej. `["User", "PerPersonal"]`) resuelva etiquetas de género o estado civil sin obligar al usuario a incluir tablas técnicas en su configuración. |
| **D-59** | **Resiliencia Fail-Safe y Ausencia de Errores Destructivos**: Si un ID o código no existe en el catálogo (dato histórico, huérfano o valor obsoleto), o si la resolución de picklist falla temporalmente por conectividad, la consulta principal NUNCA se aborta; se devuelve el registro nativo con `resolved: false` en `_picklistLabels`. | Principio de fail-safe: una falla en una etiqueta descriptiva jamás debe interrumpir el acceso a datos empresariales críticos. |
| **D-60** | **Cadena de Fallback Multilingüe BCP-47**: Prioridad de locale: Parámetro de llamada `locale` > Configuración de entorno `defaultLocale` (`config.json`) > Variable de entorno `SF_DEFAULT_LOCALE` > Fallback global `"en_US"`. Degradación de etiqueta: `locale solicitado` > `en_US` > `defaultValue / label_localized` > `externalCode` > `raw ID`. | Garantiza legibilidad en español, portugués, alemán, etc., con degradación suave a inglés si no hay traducción disponible. |
| **D-61** | **Búsqueda Inversa y Asistencia en Construcción de `$filter`**: `resolve_picklist` permite buscar por texto libre o etiqueta en un idioma para obtener el `optionId` o `externalCode` correspondiente. | Resuelve la incapacidad del LLM de filtrar entidades por campos restringidos (ej. saber que "Casado" equivale a `maritalStatus eq '10119'`). |

### 0.1 Implicaciones Derivadas (Obligatorias)

| ID | Implicación | Derivada de |
|---|---|---|
| **DS-PL-01** | Prohibición absoluta de resolver etiquetas mediante `$expand` ciego o automático en consultas masivas a SuccessFactors; todas las resoluciones en caliente se realizan contra la caché indexada local para evitar cuellos de botella y errores 500 en la base de datos de SAP. | D-53, D-54 |
| **DS-PL-02** | Todas las llamadas internas a SAP para poblar la caché de picklists deben usar exclusivamente el método HTTP `GET` mediante la función `dispatchGet`, respetando las validaciones de host, protocolo HTTPS y límite de saltos de redirección existentes. | D-55, D-58 |
| **DS-PL-03** | El archivo de caché L2 en disco debe residir en el subdirectorio de caché estándar del sistema operativo con permisos POSIX `0700` para el directorio y `0600` para el archivo. En Windows se emite advertencia de permisos no bloqueante de acuerdo con D-37/D-41. | D-54, D-44 |
| **DS-PL-04** | La caché de picklists contendrá exclusivamente metadatos de configuración de opciones (IDs, códigos, etiquetas). Queda terminantemente prohibido almacenar datos transaccionales, identificadores de empleados (User IDs) o información confidencial de negocio en dicha caché. | D-54, DS-04 |
| **DS-PL-05** | La estructura de índice en memoria L1 debe limitar el número máximo de entradas cacheadas a 50.000 opciones por entorno para proteger el heap de Node.js contra fugas de memoria en entornos de ejecución restringidos. | D-54, NFR-02 |
| **DS-PL-06** | Los errores arrojados por llamadas internas a picklists no deben exponer URLs completas, credenciales ni información de topología en los mensajes devueltos al cliente o en logs de stderr. | D-59, FR-14 |

---

## 1. Contexto, Problema y Necesidad de Negocio

### 1.1 El Problema de los Identificadores Opacos en SuccessFactors
SAP SuccessFactors utiliza de forma extensiva campos de selección restringida (*picklists*) para normalizar la información de recursos humanos (género, estado civil, tipo de contrato, motivo de baja, nivel de estudios, países, etc.).

Sin embargo, en la API OData v2, estos campos exhiben una fuerte opacidad:
1. **Option IDs numéricos no semánticos**:
   En entidades centrales como `PerPersonal` o `EmpJob`, una consulta devuelve:
   ```json
   {
     "userId": "cgranados",
     "gender": "10283",
     "maritalStatus": "10119",
     "employeeClass": "10452"
   }
   ```
   Para un modelo de lenguaje (LLM), los valores `"10283"` o `"10119"` son completamente opacos. El modelo no puede responder a preguntas tan básicas como *"¿Cuál es el género del empleado?"* o *"¿Cuántos empleados están casados?"* sin adivinar o alucinar.
2. **Incapacidad para construir consultas `$filter`**:
   Si el usuario pide al agente: *"Busca a todos los empleados con contrato temporal"*, el LLM genera intuitivamente:
   `$filter=contractType eq 'Temporary'` o `$filter=contractType eq 'TEMPORARY'`.
   SuccessFactors rechaza esta consulta con un error HTTP 400 (`Invalid filter query`) o devuelve 0 resultados, ya que la base de datos espera el ID numérico interno (ej. `contractType eq '15892'`).
3. **Disparidad entre Entornos (Dev vs. Test vs. Prod)**:
   Los `optionId` de las picklists legacy son generados secuencialmente por la base de datos de cada instancia. Por lo tanto, el ID de "Masculino" en el tenant de Pruebas puede ser `10283`, mientras que en Producción es `25491`. Un LLM no puede memorizar estos IDs entre sesiones sin consultar el catálogo dinámicamente.
4. **Inviabilidad de `$expand` en Producción**:
   La solución teórica estándar en OData v2 es incluir `$expand=genderNav/picklistLabels,maritalStatusNav/picklistLabels`. No obstante, en tenants reales de SuccessFactors esto presenta graves problemas:
   - Penalización severa de rendimiento: SAP debe realizar múltiples joins en la base de datos relacional para cada fila.
   - Timeout en consultas masivas: una consulta de 500 registros con 4 expands anidados suele agotar el timeout de 30 segundos.
   - Límites de profundidad de navegación de SuccessFactors: SAP bloquea expands con más de 2 niveles de anidación.
   - Inflado innecesario del payload en un 400% a 800%, agotando el contexto del LLM.

### 1.2 La Solución de ssff-mcp
Implementar un **Subsistema de Resolución y Consulta de Picklists** en el servidor MCP que:
1. Detecte automáticamente qué campos son picklists mediante los metadatos EDMX.
2. Mantenga una caché local bidireccional ultrarrápida (en memoria y disco).
3. Permita al LLM buscar opciones y códigos mediante la tool `resolve_picklist`.
4. Permita enriquecer opcionalmente los datos devueltos por `query_entity` y `batch_get` con etiquetas legibles sin modificar los valores nativos.

---

## 2. Arquitectura de Picklists en SAP SuccessFactors (Deep Dive)

### 2.1 Legacy Picklists (`Picklist`, `PicklistOption`, `PicklistLabel`)
El modelo Legacy proviene de la arquitectura original de SuccessFactors previa a MDF:
* **`Picklist`**: Cabecera de la lista. Identificada por un código de texto (ej. `gender`, `salutation`, `marital_status`).
* **`PicklistOption`**: Elemento o valor individual.
  * Clave primaria: `id` (entero de 64 bits auto-incrementado en base de datos, en OData representado como `10283L` o `"10283"`).
  * `externalCode`: Código alfanumérico opcional (ej. `"M"` o `"F"`).
  * `status`: Estado del valor (`"ACTIVE"`, `"INACTIVE"`).
  * `sortOrder`: Orden de visualización en la interfaz web.
  * `picklist`: Navegación a la cabecera `Picklist`.
  * `picklistLabels`: Navegación a la entidad hija de traducciones.
* **`PicklistLabel`**: Traducción de texto para un idioma/locale.
  * Clave compuesta OData: `(optionId=10283L, locale='en_US')`.
  * Campos: `optionId`, `locale` (ej. `en_US`, `es_ES`, `de_DE`), `label` (ej. `"Male"`, `"Masculino"`).

### 2.2 MDF Picklists V2 (`PickListV2`, `PickListValueV2`)
El modelo MDF (Metadata Framework) es el estándar contemporáneo de SuccessFactors:
* **`PickListV2`**: Catálogo de la lista.
  * Clave: `id` (ej. `YesNo`, `custom_contract_type`), `effectiveStartDate` (datetime con soporte de vigencia temporal).
  * `status`: Estado de la picklist (`"A"` activo, `"I"` inactivo).
* **`PickListValueV2`**: Valor de la picklist.
  * Clave compuesta: `(PickListV2_effectiveStartDate=datetime'...', PickListV2_id='...', externalCode='...')`.
  * `externalCode`: Clave de negocio alfanumérica única dentro de la picklist (ej. `"FULL_TIME"`, `"PART_TIME"`). Es consistente y transportable entre entornos (Dev -> Prod).
  * `legacyOptionId`: Propiedad que contiene el antiguo `optionId` numérico cuando una picklist legacy fue migrada a MDF.
  * Almacenamiento multilenguaje: Las etiquetas traducidas residen directamente como propiedades en la entidad: `label_en_US`, `label_es_ES`, `label_localized` (resuelto por el servidor según la sesión).

### 2.3 Coexistencia en Tenants Reales
En prácticamente el 100% de los clientes empresariales de SAP SuccessFactors existe un **entorno híbrido de coexistencia**:
* Las entidades tradicionales del módulo Employee Central Core (`User`, `PerPersonal`, `EmpJob`, `PerAddress`) continúan exponiendo IDs numéricos legacy (`10283`) en sus propiedades directas y sus propiedades de navegación apuntan a `PicklistOption`.
* Las entidades basadas en MDF (como `Position`, objetos de Reclutamiento y entidades personalizadas `cust_*`) almacenan el `externalCode` en sus propiedades y sus navegaciones apuntan a `PickListValueV2`.
* Durante la migración "Picklist to MDF Migration", SuccessFactors sincroniza ambas tablas internamente. `PickListValueV2` conserva el `legacyOptionId`, y las llamadas a `PicklistOption(10283L)` continúan respondiendo mediante vistas de compatibilidad.

#### Matriz de Coexistencia en OData v2:
| Característica | Legacy Picklists | MDF Picklists V2 |
|---|---|---|
| **Entidad Cabecera** | `Picklist` | `PickListV2` |
| **Entidad Valor/Opción** | `PicklistOption` | `PickListValueV2` |
| **Entidad de Traducciones** | `PicklistLabel` (entidad hija) | Propiedades en línea (`label_<locale>`) |
| **Identificador Principal** | `optionId` (numérico, dependiente de instancia) | `externalCode` (cadena de negocio portable) |
| **Vigencia Temporal** | No (valores estáticos con status) | Sí (`effectiveStartDate` / effective dating) |
| **Puente de Compatibilidad** | N/A | Atributo `legacyOptionId` |
| **Presencia Típica en API** | `PerPersonal`, `EmpJob`, `User` | `Position`, `cust_*`, MDF Talent |

---

## 3. Estrategia de Caching, Indexación y Rendimiento

### 3.1 Volatilidad y Política de Retención
Las picklists corporativas representan configuraciones del sistema cuya modificación requiere intervención de consultores de RRHH o administradores en el *Picklist Center*.
* **Tasa de cambio**: Menor al 0.1% semanal en producción.
* **TTL en Memoria (L1)**: **24 horas** o hasta reinicio del servidor MCP.
* **TTL en Disco (L2)**: **30 días** (`PICKLIST_DISK_TTL_MS = 30 * 24 * 60 * 60 * 1000`).
* **Invalidación**:
  * Expiración natural de TTL.
  * Invocación explícita de `resolve_picklist(forceRefresh: true)`.
  * Comando CLI o eliminación del directorio de caché.

### 3.2 Dimensionamiento y Huella de Recursos
En un tenant empresarial estándar:
* **Número de Picklists**: 150 a 400 catálogos.
* **Número de Opciones Totales**: 6.000 a 25.000 registros.
* **Tamaño en Disco**: Entre 2.5 MB y 6 MB de JSON estructurado por entorno.
* **Consumo de Memoria RAM (Heap)**: ~15 MB a 25 MB tras la indexación completa.
* **Impacto en Rendimiento**: Resolución en memoria en **< 1 ms**; lectura de caché en frío desde disco en **< 40 ms**.

### 3.3 Estructura de Datos e Índices en Memoria (O(1))
El servicio `PicklistService` mantiene para cada entorno una estructura indexada bidireccionalmente:

```typescript
export interface CachedPicklistOption {
  optionId: string;              // "10283" (Legacy ID o legacyOptionId)
  picklistId: string;            // "gender", "contract_type"
  externalCode: string;          // "M", "FT"
  status: "ACTIVE" | "INACTIVE";
  sortOrder?: number;
  labels: Record<string, string>;// { "en_US": "Male", "es_ES": "Masculino", "defaultValue": "Male" }
}

export interface EnvironmentPicklistCache {
  fetchedAt: number;
  version: number;
  options: CachedPicklistOption[];
  // Índices O(1) construidos en memoria:
  byOptionId: Map<string, CachedPicklistOption>;
  byExternalCode: Map<string, CachedPicklistOption>; // Clave: `${picklistId}:${externalCode}`
  byPicklistId: Map<string, CachedPicklistOption[]>;  // Clave: `${picklistId}`
  byLabel: Map<string, CachedPicklistOption>;         // Clave: `${picklistId}:${locale}:${normalizedText}`
}
```

### 3.4 Estrategia de Hidratación (Hydration Strategy)
Para evitar bloqueos durante el arranque y optimizar las peticiones a SAP:
1. **Paso 1 (Caché L2 en Disco)**:
   Al inicializar el servicio para un entorno, se comprueba si existe `~/.cache/ssff-mcp/picklists-<alias>.json`. Si existe y tiene menos de 30 días, se carga e indexa de forma síncrona/inmediata (< 50 ms).
2. **Paso 2 (Carga bajo demanda agrupada - Lazy Batching)**:
   Si una picklist no se encuentra en la caché (o la caché de disco no existe aún):
   * En lugar de descargar todo el tenant (30 páginas OData), se lanza una consulta específica y acotada para la picklist solicitada:
     - Legacy: `GET /odata/v2/PicklistOption?$filter=picklist/id eq '<id>'&$expand=picklistLabels`
     - MDF: `GET /odata/v2/PickListValueV2?$filter=PickListV2_id eq '<id>'`
   * Las opciones obtenidas se indexan en L1 y se persisten incrementalmente en L2.
3. **Paso 3 (Precalentamiento opcional en background o CLI)**:
   Durante la ejecución del wizard interactivo `ssff-mcp init` (FR-54) o mediante una tarea en background opcional, se puede realizar un precalentamiento completo recorriendo la paginación de `PicklistOption` y `PickListValueV2` sin bloquear las herramientas.

---

## 4. Diseño de la API de ssff-mcp

### 4.1 Herramienta Dedicada: `resolve_picklist`
Permite al LLM consultar el catálogo, resolver identificadores específicos o realizar búsquedas inversas para construir filtros OData.

#### 4.1.1 Esquema de Entrada (Zod)
```typescript
const resolvePicklistSchema = z
  .object({
    environment: z.string().optional().describe("Alias del entorno configurado."),
    picklistId: z.string().optional().describe("Identificador de la picklist (ej. 'gender', 'maritalStatus')."),
    optionId: z.union([z.string(), z.number()]).optional().describe("Option ID numérico de SAP (ej. '10283' o 10283)."),
    externalCode: z.string().optional().describe("Código externo de negocio (ej. 'M', 'FULL_TIME')."),
    query: z.string().optional().describe("Texto libre o etiqueta a buscar para traducción inversa (ej. 'Casado', 'Masculino')."),
    locale: z.string().optional().describe("Código de idioma (ej. 'es_ES', 'en_US'). Por defecto usa el configurado en el entorno."),
    forceRefresh: z.boolean().optional().describe("Si es true, ignora la caché local y consulta directamente a SAP."),
  })
  .strict()
  .refine(
    (data) => data.picklistId !== undefined || data.optionId !== undefined || data.externalCode !== undefined || data.query !== undefined,
    { message: "Al menos uno de picklistId, optionId, externalCode o query debe ser proporcionado." }
  );
```

#### 4.1.2 Casos de Uso y Respuestas de `resolve_picklist`

**Caso A: Búsqueda Inversa para Construcción de `$filter`**
* **Pregunta del usuario**: *"Filtra empleados casados"*
* **Llamada del LLM**:
  ```json
  {
    "picklistId": "maritalStatus",
    "query": "Casado",
    "locale": "es_ES"
  }
  ```
* **Respuesta Estructurada**:
  ```json
  {
    "picklistId": "maritalStatus",
    "matches": [
      {
        "optionId": "10119",
        "externalCode": "M",
        "label": "Casado/a",
        "locale": "es_ES",
        "status": "ACTIVE",
        "suggestedFilter": "maritalStatus eq '10119'"
      }
    ]
  }
  ```
* **Acción posterior del LLM**: Ejecuta `query_entity(entityPath="EmpJob", filter="maritalStatus eq '10119'")` con 100% de éxito.

**Caso B: Resolución Directa de un Option ID**
* **Llamada del LLM**:
  ```json
  {
    "optionId": "10283",
    "locale": "es_ES"
  }
  ```
* **Respuesta Estructurada**:
  ```json
  {
    "found": true,
    "option": {
      "optionId": "10283",
      "picklistId": "gender",
      "externalCode": "M",
      "label": "Masculino",
      "locale": "es_ES",
      "status": "ACTIVE"
    }
  }
  ```

**Caso C: Exploración de Opciones de un Catálogo**
* **Llamada del LLM**:
  ```json
  {
    "picklistId": "salutation",
    "locale": "es_ES"
  }
  ```
* **Respuesta Estructurada**: Lista completa de opciones activas con sus correspondientes `optionId`, `externalCode` y `label`.

---

### 4.2 Enriquecimiento en `query_entity` y `batch_get`

#### 4.2.1 Modificaciones a los Esquemas de Entrada
Se añaden dos campos opcionales a `queryEntitySchema` y a cada elemento de `batchGetSchema`:
* `resolvePicklists`: `z.boolean().optional().default(false)`
  * Describe: *"Cuando es true, enriquece automáticamente los campos asociados a picklists añadiendo las etiquetas legibles en la propiedad _picklistLabels sin modificar los valores nativos."*
* `locale`: `z.string().optional()`
  * Describe: *"Idioma preferido para las etiquetas (ej. 'es_ES', 'en_US'). Si se omite, utiliza el locale configurado en el entorno."*

#### 4.2.2 Formato de Respuesta Enriquecida (JSON)
Dado un registro original devuelto por SAP:
```json
{
  "userId": "cgranados",
  "gender": "10283",
  "maritalStatus": "10119",
  "department": "DEP_IT_01"
}
```
Con `resolvePicklists: true` y `locale: "es_ES"`, el MCP devuelve el registro preservando los valores nativos y adjuntando el bloque `_picklistLabels`:
```json
{
  "userId": "cgranados",
  "gender": "10283",
  "maritalStatus": "10119",
  "department": "DEP_IT_01",
  "_picklistLabels": {
    "gender": {
      "label": "Masculino",
      "externalCode": "M",
      "picklistId": "gender",
      "resolved": true
    },
    "maritalStatus": {
      "label": "Casado/a",
      "externalCode": "M",
      "picklistId": "maritalStatus",
      "resolved": true
    }
  }
}
```

#### 4.2.3 Manejo de Casos en XML
Si el cliente solicita `output: "xml"` (D-32), el cuerpo XML Atom se devuelve **inalterado** para preservar la firma y estructura estricta del documento XML de SAP. Las banderas de resolución se limitan a los metadatos de `structuredContent`.

---

### 4.3 Manejo de Locales e Internacionalización
1. **Estándar**: Códigos BCP-47 con formato SAP (`en_US`, `es_ES`, `de_DE`, `fr_FR`, `pt_BR`, `zh_CN`, `ja_JP`).
2. **Jerarquía de Configuración**:
   - Nivel 1: Parámetro explícito `locale` en la llamada a la herramienta MCP.
   - Nivel 2: Propiedad `"defaultLocale"` en `config.json` dentro del bloque del entorno correspondiente.
   - Nivel 3: Variable de entorno del proceso `SF_DEFAULT_LOCALE`.
   - Nivel 4: Valor predeterminado global del sistema: `"en_US"`.
3. **Cadena de Fallback Lingüístico**:
   Si una opción de picklist carece de traducción en el locale solicitado:
   `Locale solicitado` ➔ `"en_US"` (idioma base internacional de SAP) ➔ `defaultValue / label_localized` ➔ `externalCode` ➔ `ID numérico crudo`.

---

### 4.4 Política de Tolerancia a Fallos (Fail-Safe)
* **IDs huérfanos o inexistentes**: Si un registro de empleado contiene un ID que ya no existe en el catálogo de picklists (por ejemplo, `gender: "99999"`):
  - La consulta principal tiene éxito sin errores.
  - En `_picklistLabels`, se emite:
    ```json
    "_picklistLabels": {
      "gender": {
        "resolved": false,
        "rawValue": "99999",
        "reason": "OPTION_NOT_FOUND"
      }
    }
    ```
* **Fallo de conectividad al resolver picklist**: Si una llamada de sistema para consultar una picklist falla (timeout, error 503):
  - El servidor registra una advertencia en stderr mediante el logger estructurado.
  - La consulta principal devuelve los datos nativos intactos con `_picklistLabels` vacío o marcado como `resolved: false`.
  - La llamada MCP **NUNCA devuelve un error `isError: true`** debido exclusivamente a un fallo de resolución de picklists.

---

## 5. Diseño Técnico en el Codebase de ssff-mcp

### 5.1 Estructura de Archivos
* **`src/picklists.ts`** *(Nuevo módulo)*:
  * Contiene la clase `PicklistService`.
  * Gestiona las cachés L1 (memoria) y L2 (disco persistente).
  * Implementa las funciones de indexación bidireccional y búsqueda inversa.
  * Implementa `enrichRecords(records, entitySchema, locale)`.
* **`src/metadata.ts`** *(Extensión menor)*:
  * El parser EDMX extrae el atributo `@_picklist` o `@_sap:picklist` en los nodos `<Property>`.
  * Extiende la interfaz `EntityProperty` para incluir `picklistId?: string`.
  * Asocia propiedades de navegación que apunten a `PicklistOption` o `PickListValueV2`.
* **`src/config.ts`** *(Extensión menor)*:
  * El esquema Zod de `EnvironmentConfig` admite el campo opcional `defaultLocale: z.string().optional()`.
  * Admite la variable de entorno `SF_DEFAULT_LOCALE`.
* **`src/tools.ts`** *(Integración)*:
  * Registra la herramienta `resolve_picklist`.
  * Inyecta `picklistService` en `ServerDeps`.
  * Conecta el enriquecimiento en los manejadores de `query_entity` y `batch_get`.

### 5.2 Manejo de `entityAllowlist` (Aislamiento de Sistema)
* **Problema**: Si el usuario define `entityAllowlist: ["User", "PerPersonal"]`, una comprobación estricta de allowlist impediría consultar `PicklistOption` o `PickListValueV2`.
* **Solución Arquitectónica (D-58)**:
  * Las llamadas generadas por `PicklistService` son consultas internas de metadatos del servidor.
  * Se despachan directamente a través de `dispatchGet` **sin invocar `isEntityAllowed()`**.
  * Si el LLM o usuario intenta llamar directamente a `query_entity({ entityPath: "PicklistOption" })`, esa llamada **SÍ** se evalúa contra la allowlist y es bloqueada si no está explícitamente permitida.
  * Esto preserva el principio de mínimo privilegio en el acceso directo a tablas, mientras permite al servidor realizar el enriquecimiento de metadatos de las entidades explícitamente autorizadas.

---

## 6. Requisitos Funcionales (FR-56..FR-66)

* **FR-56 (Detección de Picklists en Metadatos)**: `parseMetadata()` DEBE (MUST) extraer las anotaciones `sap:picklist` presentes en las propiedades del esquema EDMX y exponer el nombre de la picklist asociada en `EntityProperty.picklistId`.
* **FR-57 (Caché L1 en Memoria)**: `PicklistService` DEBE (MUST) mantener un índice en memoria con tiempo de acceso O(1) indexado por `optionId`, por `${picklistId}:${externalCode}`, por `picklistId` y por `${picklistId}:${locale}:${normalizedText}`.
* **FR-58 (Persistencia L2 en Disco)**: `PicklistService` DEBE (MUST) persistir el catálogo de opciones por entorno en el directorio de caché del sistema operativo (`~/.cache/ssff-mcp` en Linux, `~/Library/Caches/ssff-mcp` en macOS, `%LOCALAPPDATA%\ssff-mcp\cache` en Windows) con un TTL configurable por defecto de 30 días (`PICKLIST_DISK_TTL_MS`).
* **FR-59 (Herramienta `resolve_picklist`)**: El servidor MCP DEBE (MUST) registrar la herramienta `resolve_picklist` con soporte para resolver por `optionId`, `externalCode`, o listar por `picklistId`.
* **FR-60 (Búsqueda Inversa por Etiqueta)**: `resolve_picklist` DEBE (MUST) admitir el parámetro `query` para buscar coincidencias de texto libre contra las etiquetas localizadas y devolver el `optionId` y `externalCode` correspondiente para permitir al cliente construir cláusulas `$filter`.
* **FR-61 (Flag de Enriquecimiento en `query_entity`)**: `query_entity` DEBE (MUST) admitir el parámetro booleano `resolvePicklists` (por defecto `false`). Cuando sea `true` y la salida sea JSON, DEBE (MUST) adjuntar el subobjeto `_picklistLabels` a cada registro devuelto.
* **FR-62 (Enriquecimiento en `batch_get`)**: Cada elemento del array `requests` de `batch_get` DEBE (MUST) admitir el parámetro `resolvePicklists: boolean`.
* **FR-63 (Preservación de Esquema Nativo)**: El enriquecimiento de picklists NUNCA DEBE (MUST NOT) sobrescribir ni modificar el tipo o valor de los campos nativos devueltos por SuccessFactors.
* **FR-64 (Degradación Multilingüe)**: Si la etiqueta de una opción no existe en el idioma especificado, el servidor DEBE (MUST) intentar resolverla en `en_US`, luego en el valor por defecto (`defaultValue`), y si no existe ninguna, reflejar el `externalCode` o ID numérico crudo.
* **FR-65 (Comportamiento Fail-Safe)**: Un fallo en la resolución de una picklist o la presencia de un ID huérfano NUNCA DEBE (MUST NOT) provocar que la consulta principal falle; el resultado debe devolverse con `resolved: false`.
* **FR-66 (Exención de Allowlist para Consultas de Sistema)**: Las peticiones internas emitidas por `PicklistService` para hidratar la caché de picklists NO DEBEN (MUST NOT) ser bloqueadas por la `entityAllowlist`.

---

## 7. Requisitos No Funcionales (NFR)

* **NFR-01 (Latencia de Resolución en Memoria)**: La resolución y enriquecimiento de un lote de 1.000 registros cacheados en memoria DEBE completarse en menos de **5 milisegundos**.
* **NFR-02 (Huella de Memoria)**: La caché L1 en memoria NO DEBE exceder los **35 MB de RAM** por entorno activo bajo condiciones normales de catálogo.
* **NFR-03 (Permisos de Disco)**: En entornos POSIX, el archivo de caché L2 DEBE crearse con permisos `0600` y el directorio con permisos `0700`.
* **NFR-04 (Concurrencia y Deduplicación de Consultas de Carga)**: Si múltiples llamadas simultáneas requieren la misma picklist no cacheada, el servidor DEBE deduplicar las peticiones a SAP mediante una promesa compartida (*in-flight request deduplication*), evitando peticiones duplicadas hacia el tenant.
* **NFR-05 (Compatibilidad Multiplataforma)**: El subsistema de picklists DEBE funcionar idénticamente en Linux, macOS y Windows, respetando finales de línea y rutas agnósticas.

---

## 8. Análisis de Riesgos y Mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación Arquitectónica |
|---|---|---|---|
| **R1: Degradación de rendimiento por N+1 queries** | Media | Alto | Deduplicación de peticiones en vuelo, indexación O(1) en memoria, caché persistente L2 de 30 días y carga agrupada por catálogo (*lazy batching*). |
| **R2: Inconsistencia entre instancias (Dev vs Prod)** | Alta | Crítico | La herramienta `resolve_picklist` permite al LLM descubrir dinámicamente los Option IDs vigentes en el entorno de la sesión antes de construir filtros, evitando el uso de IDs hardcodeados. |
| **R3: Restricción de permisos RBP sobre `PicklistOption` o `PickListValueV2`** | Baja | Medio | Comportamiento fail-safe: si el usuario técnico carece de permisos de lectura sobre las tablas de metadatos de picklists, el enriquecimiento se desactiva silenciosamente emitiendo un log de aviso en stderr sin interrumpir las consultas de negocio. |
| **R4: Modificaciones administrativas de picklists en SAP durante la vigencia de la caché** | Baja | Bajo | Soporte del parámetro `forceRefresh: true` en `resolve_picklist`, comando CLI `ssff-mcp cache clear` e invalidación automática por TTL. |
| **R5: Colisiones de nombres en campos con el mismo nombre y diferentes picklists** | Media | Medio | El índice califica las opciones por el par `${picklistId}:${externalCode}` y mapea las propiedades según el esquema exacto de la entidad resuelta por `MetadataService`. |

---

## 9. Estimación de Esfuerzo, Complejidad y Plan de Implementación

### 9.1 Estimación por Componente

| Tarea / Componente | Complejidad | Días Estimados | Story Points |
|---|---|---|---|
| **T1: Extensión de `MetadataService`** (extracción de `sap:picklist` en `src/metadata.ts`, tests unitarios) | Baja | 1.0 día | 2 SP |
| **T2: Módulo `PicklistService`** (L1 memory cache, L2 disk cache, indexación O(1), `src/picklists.ts`) | Media | 2.5 días | 5 SP |
| **T3: Conectores OData para Legacy y MDF** (despacho interno a `PicklistOption` y `PickListValueV2`, deduplicación de peticiones) | Media | 1.5 días | 3 SP |
| **T4: Tool `resolve_picklist`** (esquema Zod, búsqueda inversa, sugerencia de `$filter`, registro en `src/tools.ts`) | Media | 1.5 días | 3 SP |
| **T5: Enriquecimiento en `query_entity` y `batch_get`** (flags `resolvePicklists`/`locale`, adjunción de `_picklistLabels`) | Media | 1.5 días | 3 SP |
| **T6: Suite de Pruebas y Validación E2E** (tests unitarios, fakes HTTP OData, pruebas de degradación multilingüe y permisos) | Media | 2.0 días | 5 SP |
| **TOTAL** | **Media** | **10.0 días** | **21 SP** |

### 9.2 Plan de Fases de Entrega
* **Hito 1 (Fundación y Metadatos)**: T1 + T2 — Extracción de esquemas y motor de caché L1/L2 independiente.
* **Hito 2 (Herramienta MCP Directa)**: T3 + T4 — Implementación y verificación de la herramienta `resolve_picklist`.
* **Hito 3 (Enriquecimiento Transparente)**: T5 — Inyección del enriquecimiento en `query_entity` y `batch_get`.
* **Hito 4 (Hardening y Documentación)**: T6 — Cobertura de pruebas al 100%, actualización de README y validación contra tenants simulados.

---

## 10. Open Questions y Supuestos

### 10.1 Open Questions (Q-PL)
* **Q-PL-1**: ¿Se debe precalentar la caché de picklists durante el comando interactivo `ssff-mcp init` (Fase 4)?
  * *Recomendación*: Añadir un paso opcional en el wizard: *"¿Deseas precalentar la caché local de picklists para consultas instantáneas?"*.
* **Q-PL-2**: ¿Debe soportarse la resolución de picklists en cascada / jerárquicas (*parent-child cascading picklists*)?
  * *Recomendación*: En la v1.0 devolver únicamente la relación plana de la opción; en v1.1 considerar incluir la propiedad `parentOptionId` si está presente.
* **Q-PL-3**: ¿Debe admitirse un recurso URI MCP tipo `sf://{env}/picklists/{picklistId}` para lectura directa?
  * *Recomendación*: Sí, es un complemento natural de los recursos MCP introducidos en Fase 3 (`sf://{env}/entities`).

### 10.2 Supuestos Verificados (A-PL)
* **A-PL-1**: Los usuarios técnicos de integración en SAP SuccessFactors con rol de solo lectura habitualmente tienen acceso a los EntitySets `PicklistOption` y `PickListValueV2` mediante los permisos estándar de OData API.
* **A-PL-2**: El uso de la propiedad aditiva `_picklistLabels` en la respuesta JSON no interfiere con los clientes MCP ni con las aserciones de esquemas estrictos de los tests existentes.
* **A-PL-3**: `fast-xml-parser` con `ignoreAttributes: false` y `removeNSPrefix: true` captura limpiamente el atributo `sap:picklist` como `@_picklist`.

---
*Fin del documento PRD — Resolución Automática y Consulta de Picklists en ssff-mcp (PROPOSED v1.0).*
