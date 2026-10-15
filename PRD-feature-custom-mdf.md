# PRD — ssff-mcp Feature: Auto-Discovery y Mapeo Asistido de Custom MDF (Objetos Personalizados)

| Campo | Valor |
|---|---|
| Estado | **CONFIRMED v2.0** — **implementado** (2026-10-14). Revisión mayor: se eliminó la premisa falsa de asimetría de navegación, se reescribieron las reglas de clasificación y se añadieron D-70/D-75 y FR-75/FR-76/FR-86. |
| Fecha | 2026-10-14 |
| Fuente de decisiones | Requerimiento de integración para consulta de entidades personalizadas de SAP SuccessFactors MDF sobre OData v2 sin desbordar la ventana de contexto del LLM ni alucinar rutas de navegación inexistentes |
| Idioma | Documento en español neutro profesional; identificadores y términos de código en inglés. Los textos de guía dirigidos al LLM (`warnings`) son **multilingües** en tiempo de ejecución (D-70/FR-75) |
| Relación con PRD anteriores | **Extiende** `PRD.md` (MVP), `PRD-phase2.md` (Fase 2), `PRD-phase3.md` (Fase 3) y `PRD-phase4.md` (Fase 4), incorporando los requisitos funcionales **FR-67..FR-76** y **FR-86**, las decisiones **D-62..D-70** y **D-75**, y las implicaciones derivadas **DS-MDF-01..DS-MDF-06**. Reparto del ledger: **D-53..D-61 / FR-56..FR-66** → `PRD-feature-picklists.md`; **D-71..D-74 / FR-77..FR-85** → `PRD-feature-odata-query-fidelity.md`. Este documento arranca en **D-62 / FR-67** |

---

## 0. Registro de Decisiones (Ledger)

### 0.1 Decisiones confirmadas (D-62..D-70 · D-75)

| ID | Decisión | Origen / Justificación |
|---|---|---|
| **D-62** | **Zero-Network Discovery a partir de `$metadata` en caché**: El descubrimiento, catalogación y clasificación de Custom MDF se realiza al 100% en memoria a partir de la estructura `ParsedMetadata` (ya cacheada en memoria por 10 min y en disco por 24h vía D-43/D-44). No se realiza **ninguna** llamada HTTP adicional a SuccessFactors para listar o inspeccionar objetos MDF. | Eficiencia, rendimiento instantáneo (< 2 ms) y cero coste de cuota/red en el tenant. |
| **D-63** | **Identificación canónica de Custom MDF**: Se clasifica como Custom MDF toda entidad cuyo nombre en el EntitySet cumpla la expresión regular `/^[cC]ust_/` (convención estándar de nombrado de SAP SuccessFactors MDF: `cust_*` y `Cust_*`). | Estándar universal del Metadata Framework de SAP SuccessFactors. |
| **D-64** | **Clasificación semántica de vinculación con empleados (`MdfEmployeeLinkType`)**: El servidor analiza claves y `NavigationProperties` — **excluyendo siempre `createdByNav` y `lastModifiedByNav`** — para categorizar en 6 tipos: `DIRECT_USER_KEY` (clave `externalCode` **o `userId`**, y nav a `User`), `DIRECT_EMPLOYMENT_KEY`, `USER_FIELD_NAVIGATION`, `EMPLOYMENT_FIELD_NAVIGATION`, `COMPOSITE_CHILD` (clave `cust_<Padre>_<campo>` con `<Padre>` custom existente), o `UNLINKED_STANDALONE`. **Medido en PROD (2026-10-14): 38/79 realmente vinculadas; sin excluir las navs de auditoría la regla marcaba las 79.** | Resuelve la opacidad de los nombres técnicos para el modelo de IA. |
| **D-65** | **Doble canal de exposición MCP (Recursos y Enriquecimiento)**: Exponer **un solo** recurso nuevo, `sf://{env}/mdf/custom` (catálogo compacto y filtrable de Custom MDF), y enriquecer los recursos existentes: el catálogo general `sf://{env}/entities` con los flags booleanos `isEmployeeLinked` e `isEffectiveDated` (el flag `isCustom` ya existe, `src/tools.ts:848`), y el recurso de detalle `sf://{env}/entities/{entitySet}` con los campos aditivos `isCustom`, `isEffectiveDated`, `employeeLink` y `guidance` cuando la entidad sea Custom MDF. **NO se crea un recurso `sf://{env}/mdf/custom/{entitySet}` paralelo**: duplicaría el detalle ya existente. | Evita proliferar superficie MCP: el detalle ya existe y solo se enriquece de forma aditiva, sin romper consumidores. |
| **D-66** | **Herramienta MCP de introspección asistida (`inspect_custom_mdf`)**: Registrar una herramienta MCP específica (`inspect_custom_mdf`) con argumentos `{ environment?, entitySet?, employeeLinkedOnly? }`. Si `entitySet` está presente, devuelve el esquema y la guía semántica de consulta; si se omite, devuelve el listado compacto de Custom MDF disponibles. | Los clientes LLM en turnos conversacionales exploran más proactivamente vía tools que inspeccionando recursos MCP no pre-cargados. |
| **D-67** | **Generación de `queryGuidance` semántico para el LLM**: Cada objeto Custom MDF expuesto incluye un bloque `queryGuidance` que indica: la plantilla recomendada de `$filter` (una de las **tres formas verificadas en producción**: `externalCode eq`, `userId eq`, o **segmento de navegación** `<navProp>/userId eq`), el campo de enlace, si requiere ordenamiento por fecha (`$orderby=effectiveStartDate desc` + `$top=1`, con ventana `$fromDate=1970-01-12&toDate=9999-12-31` para el histórico), advertencias sobre que la navegación inversa desde `User` **existe y es expandible pero devuelve la colección hija completa sin poder acotarse** (medido: 224 registros / 1,75 MB; OData v2 no admite `$select` ni `$top` anidados en `$expand`, y el tope de FR-86 la rechazaría), y un ejemplo listo para ejecutar con `query_entity`. | Protege la ventana de contexto (DS-MDF-05) y evita las consultas singleton sin clave compuesta. La forma por segmento de navegación se añadió tras cotejar con el backend de producción (`recruiting-backend`), que la usa para `cust_Prendas` y `cust_UbicacionFisica`. |
| **D-68** | **Cumplimiento estricto fail-closed de `entityAllowlist`**: Toda entidad `cust_*` excluida por `entityAllowlist` (o si esta es vacía `[]`) es filtrada en los listados y genera un error sanitizado `ENTITY_NOT_ALLOWED` en `inspect_custom_mdf`, en `sf://{env}/mdf/custom` y en el recurso de detalle `sf://{env}/entities/{entitySet}` (que ya lo hace hoy, `src/tools.ts:879-884`). | Principio inmutable de seguridad fail-closed (D-15, D-30, D-35). |
| **D-69** | **Mapeo explícito de objetos dependientes de fecha (Effective Dating)**: Si la clave primaria contiene `effectiveStartDate` **o `mdfSystemEffectiveStartDate`**, el sistema lo marca como `isEffectiveDated: true`, documenta la necesidad de clave compuesta en singleton y recomienda consultar la colección con `$filter` y `$orderby` en lugar de una ruta de clave única. | Evita errores OData 400/404 al intentar acceder a registros sin fecha efectiva. La segunda variante de campo se detectó empíricamente (2026-10-14). |
| **D-70** | **`queryGuidance` multilingüe**: el texto de `warnings` (y cualquier prosa de guía) se resuelve en **un único idioma activo**, nunca en todos a la vez. **Manda la elección del usuario**, resuelta por esta precedencia: (1) parámetro `locale` de `inspect_custom_mdf`, que refleja el idioma en que el usuario está hablando; (2) `defaultLocale` de `config.json`, la preferencia declarada por el usuario (FR-76); (3) variable `SF_DEFAULT_LOCALE`; (4) `"en_US"`. El locale efectivo se expone en `guidance.locale`. Las plantillas de `$filter`, el `exampleQuery` y los identificadores OData **no** se traducen. Los recursos MCP, al no admitir parámetros de consulta, usan solo los niveles 2-4. | Alineado con el criterio de localización de `PRD-feature-picklists.md` (D-60). Emitir todos los idiomas a la vez violaría DS-MDF-05 (< 5 KB por entidad). |
| **D-75** | **Tope de tamaño de respuesta (guard de contexto)**: el tope aplica **únicamente a lo que se devuelve al cliente LLM**. Los usos internos del servidor —metadata para clasificación, caché en disco, hidratación interna— quedan **exentos**: no son contexto del modelo. Alcance: en `query_entity`, de forma agregada sobre la respuesta; en `batch_get`, **por cada petición interna**, nunca sobre el conjunto del batch. Superarlo produce un error **saneado y accionable** —que indique cómo acotar con `$select`/`$top`/`$filter`— y nunca una respuesta gigante. El tope NO DEBE basarse en una lista de entidades conocidas. **Excepción explícita**: la tool `get_metadata` queda **exenta** aunque su salida sí va al LLM, porque un XML de esquema es legítimamente grande. En compensación, su uso NUNCA DEBE recomendarse: la guía debe dirigir siempre a la exploración entidad a entidad. | Origen: los sondeos de A-MDF-04 midieron **1,75 MB en una sola respuesta** (`User?$expand=cust_GerenteOfcust_centroNav`). Verificado además que `operational-centers` **no tiene ningún guard equivalente** (Axios sin `maxContentLength`). Protege la ventana de contexto del LLM, que es el único consumidor al que aplica. |

> **Reparto del ledger**: los IDs **D-71..D-74 / FR-77..FR-85** pertenecen a `PRD-feature-odata-query-fidelity.md` (encoding `%20`, gramática de key predicates, paridad, `$fromDate`/`$toDate`). Este documento no los reutiliza.

---

### 0.2 Implicaciones Derivadas (DS-MDF-01..DS-MDF-06)

| ID | Implicación | Derivada de |
|---|---|---|
| **DS-MDF-01** | La clasificación de entidades Custom MDF debe ser determinista y pura: una función TypeScript que reciba `EntitySchema` y el diccionario global de esquemas, calculándose bajo demanda o memoizándose en memoria en `ParsedMetadata`. | D-62, D-64 |
| **DS-MDF-02** | Ninguna llamada a `inspect_custom_mdf` ni lectura de `sf://{env}/mdf/*` ejecuta peticiones de red hacia endpoints de datos de SuccessFactors; interactúan únicamente con `MetadataService`. | D-62 |
| **DS-MDF-03** | `User` **sí** expone navegación a `cust_*` (45 / 48 / 52 navs) y **es expandible** — la premisa original de asimetría era falsa. Pero es un **footgun medido**: `GET User('1100954')?$expand=cust_GerenteOfcust_centroNav` devolvió **224 registros / 1,75 MB** en una sola respuesta, y OData v2 **no admite `$select` ni `$top` anidados** dentro de `$expand`, así que la colección hija no se puede acotar ni proyectar. `queryGuidance` DEBE recomendar la consulta a la entidad custom como raíz, con `$filter`, `$select` y `$top`. Exponer la nav como vía alternativa queda **descartado** por coste de contexto (DS-MDF-05). | Corregido por validación empírica; enmienda D-67 |
| **DS-MDF-04** | En modo inline (D-49), el parámetro `environment` en `inspect_custom_mdf` es opcional si solo existe un entorno sintetizado. | D-49, D-66 |
| **DS-MDF-05** | Las respuestas de `inspect_custom_mdf` y los recursos asociados deben formatearse en JSON compacto legible por el LLM (< 5 KB por entidad), preservando la ventana de contexto. | D-33, D-66 |
| **DS-MDF-06** | La feature no debe requerir ninguna librería externa adicional en `package.json`: utiliza exclusivamente `@modelcontextprotocol/sdk`, `zod` y `fast-xml-parser` ya instalados. | D-11, D-62 |

---

### 0.3 Supuestos Técnicos (A-MDF-01..A-MDF-05)

> Verificadas empíricamente el 2026-10-14 contra los `$metadata` cacheados de PROD, DEV y TEST
> (79 / 87 / 91 entidades custom). El detalle medido está en §3.4 y §4.2.

* **A-MDF-01** — ✅ **VERIFICADA**: 79/79 (PROD), 87/87 (DEV) y 91/91 (TEST) usan el prefijo `cust_`. **Cero** entidades con `Cust_` en los tres tenants: la alternativa `[cC]` de D-63 se mantiene pero está inactiva.
* **A-MDF-02** — ⚠️ **PARCIALMENTE FALSA**: `externalCodeNav` **no** es universal; existe en 22/79 (PROD), 24/87 (DEV) y 26/91 (TEST). Además, **toda** entidad custom tiene `createdByNav` y `lastModifiedByNav` apuntando a `User`, que no son vínculo de negocio. La heurística no puede basarse en el nombre `externalCodeNav`.
* **A-MDF-03** — ✅ **VERIFICADA**: el patrón `cust_<Padre>_<campo>` se cumple, con el padre como entidad custom existente. 15 (PROD), 18 (DEV) y 19 (TEST) hijos compuestos.
* **A-MDF-04** — ✅ **VERIFICADA en DEV**: los sondeos del 2026-10-14 consultaron datos reales (`cust_centro` y `User`) con la cuenta de API y devolvieron registros, lo que prueba que el usuario dispone de permisos RBP de lectura sobre entidades custom. **Efecto colateral medido**: una sola respuesta alcanzó **1,75 MB**, de donde nace D-75/FR-86 (tope de tamaño de respuesta). Pendiente confirmar los permisos en PROD, donde la allowlist y los roles pueden diferir.
* **A-MDF-05** — ✅ **VERIFICADA**: 658 / 665 / 671 entidades totales, con 12,0% / 13,1% / 13,6% de `cust_*`. Dentro del rango estimado.

---

## 1. Contexto y Problema

SAP SuccessFactors cuenta con el **Metadata Framework (MDF)**, un motor extensible que permite a las organizaciones crear tablas y modelos de datos completamente personalizados (objetos `cust_*`). Ejemplos comunes en empresas reales:
* `cust_EmployeeEquipment`: Asignación de portátiles, teléfonos y tarjetas de acceso a empleados.
* `cust_Certifications`: Registro de certificaciones profesionales o cursos de prevención de riesgos.
* `cust_CompanyCarFleet`: Vehículos de empresa asignados a directivos o comerciales.
* `cust_UnionAffiliation` o `cust_SpecialCompensation`: Datos locales específicos de convenios colectivos.

### Las 4 barreras para los Modelos de Lenguaje (LLMs):

1. **El problema de la invisibilidad**:
   Cuando un usuario pide a un asistente de IA: *"¿Qué equipo informático tiene asignado el empleado 1042?"*, el LLM consulta la entidad estándar `User` o `EmpJob` con `$select`. Al no encontrar los campos, asume que la información no existe o intenta descargar los 7.5 MB de `$metadata` XML completo, colapsando el contexto.
2. **Navegación inversa `User` → Custom MDF (premisa corregida y acotada)**:
   La afirmación original de que las entidades estándar **NO** incorporan navegación hacia los objetos Custom MDF es **falsa**: `User` sí expone navs generadas con el patrón `<campo>Of<entidad>Nav` y **son expandibles** (verificado el 2026-10-14 contra DEV). Pero es una ruta **inutilizable en la práctica**: `GET User('1100954')?$expand=cust_GerenteOfcust_centroNav` devolvió **224 registros / 1,75 MB** en una sola respuesta, y OData v2 no admite `$select` ni `$top` anidados dentro de `$expand`, así que la colección hija no se puede acotar. Además, un `$select` en el padre **descarta silenciosamente el `$expand`** salvo que se nombre también la nav dentro del `$select`. Conclusión: la ruta segura es consultar la entidad custom como raíz con `$filter` y `$top`.
3. **El obstáculo de las claves compuestas y Effective Dating**:
   Muchos objetos MDF son dependientes de fecha (*Effective Dated*). Su clave primaria OData no es únicamente `externalCode`, sino el par `(externalCode, effectiveStartDate)`. Un LLM que intente `query_entity(entityPath="cust_EmployeeEquipment('1042')")` recibirá un error de sintaxis de clave. Debe formularse una consulta de colección con `$filter="externalCode eq '1042'"` y ordenar por `$orderby="effectiveStartDate desc"`.
4. **Falta de orientación semántica**:
   Entre 80 entidades `cust_*`, el LLM no puede discernir cuáles representan datos de personas y cuáles son catálogos estáticos (ej. extensiones de centros de coste o tipos de moneda), a menos que el servidor MCP le brinde una clasificación asistida.

---

## 2. Objetivos y Non-Objetivos

### 2.1 Objetivos

1. **Auto-Discovery instantáneo sin sobrecarga de red**: Clasificar y exponer todos los Custom MDF del tenant a partir del `$metadata` ya parseado y cacheado.
2. **Detección inteligente del vínculo con empleados**: Categorizar automáticamente si un Custom MDF está asociado a un empleado, mediante qué campo (`externalCode`, `userId`, etc.) y qué entidad objetivo (`User` o `EmpEmployment`).
3. **Mapeo asistido con `queryGuidance`**: Proporcionar al LLM las instrucciones exactas de cómo formular consultas sobre el objeto custom mediante `query_entity`, incluyendo plantillas de `$filter` y advertencias sobre que la navegación inversa desde `User` devuelve una colección hija inacotable. Las advertencias son **multilingües** (D-70/FR-75).
4. **Respeto total de `entityAllowlist`**: Mantener la seguridad fail-closed sin fugas de metadatos no permitidos.
5. **Doble modalidad de consumo**: Disponible vía Recursos MCP (`sf://{env}/mdf/custom` para el catálogo y el detalle enriquecido de `sf://{env}/entities/{entitySet}`) y vía Herramienta MCP interactiva (`inspect_custom_mdf`).

### 2.2 Non-Objetivos (RFC 2119)

* **MUST NOT** realizar llamadas de red adicionales para el descubrimiento de metadatos.
* **MUST NOT** permitir operaciones de escritura, creación o actualización de registros Custom MDF.
* **MUST NOT** alterar el comportamiento, validaciones o gramática de la herramienta existente `query_entity`.
* **MUST NOT** consultar directamente datos de empleados durante la fase de inspección de metadatos.

---

## 3. Naturaleza de los Objetos Custom MDF en SuccessFactors

### 3.1 Convenciones de Nomenclatura
* Toda entidad MDF personalizada se registra con un código que comienza por `cust_`. D-63 mantiene además la alternativa `Cust_`, pero **no se ha observado ni una sola en los tres tenants medidos** (79 / 87 / 91 entidades): en la práctica es una rama inactiva que se conserva por coste cero.
* En el documento OData `$metadata` (`EDMX`), el `EntityType` y el `EntitySet` reflejan este nombre (ej. `<EntitySet Name="cust_EmployeeEquipment" EntityType="SFOData.cust_EmployeeEquipment"/>`).

### 3.2 Anatomía de Claves y Campos del Sistema
Un objeto MDF típico generado por SuccessFactors contiene campos estandarizados del framework:
* **`externalCode`** (`Edm.String`): Clave primaria obligatoria.
  * *Modo User*: Si en *Configure Object Definitions* el campo tiene Data Type `User`, almacena directamente el `userId` del empleado.
  * *Modo Auto-Number / String*: Almacena un identificador alfanumérico único del registro.
* **`effectiveStartDate`** (`Edm.DateTime`): Presente en objetos con *Effective Dating*. Forma una clave primaria compuesta junto con `externalCode`. **Variante medida**: hay entidades que usan `mdfSystemEffectiveStartDate` como campo de fecha efectiva en la clave (p. ej. `cust_AccionSocial`); ambas variantes cuentan para `isEffectiveDated` (D-69).
* **`mdfSystemStatus`** (`Edm.String`): Estado del registro ('A' = Activo, 'I' = Inactivo).
* **`mdfSystemRecordStatus`** (`Edm.String`): Utilizado en objetos con *Multiple Changes Per Day*.
* **`lastModifiedDateTime`** (`Edm.DateTimeOffset`): Timestamp de auditoría.

### 3.3 Tipos de Effective Dating en MDF
1. **None**: La clave primaria es únicamente `externalCode`.
2. **Basic**: La clave primaria es compuesta: `(externalCode, effectiveStartDate)`. SuccessFactors por defecto en consultas de colección devuelve los registros vigentes, o permite navegar el histórico.
3. **Multiple Changes Per Day**: Clave compuesta: `(externalCode, effectiveStartDate, mdfSystemRecordStatus)` o secuencia de transacción. **No ejercitado**: `mdfSystemRecordStatus` no aparece en la clave de ninguna entidad de los tres tenants medidos.
4. **From Parent**: La entidad es un hijo compuesto (*Composite Association*) y hereda la temporalidad de su padre.

### 3.4 Relación con Empleados y Navegación en OData v2

> **Corregido tras validación empírica (2026-10-14; tenants PROD, DEV y TEST).** La afirmación
> original de que `User` no expone navegación hacia los objetos `cust_*` es **FALSA** en tenants
> reales: `User` incluye navs generadas con el patrón `<campo>Of<entidad>Nav` y multiplicidad
> `*` hacia entidades custom (medido: 45 en PROD, 48 en DEV, 52 en TEST). **Son expandibles,
> pero la expansión devuelve la colección hija completa e inacotable** (medido: 224 registros /
> 1,75 MB en una respuesta; OData v2 no admite `$select` ni `$top` anidados en `$expand`). Por
> eso `queryGuidance` recomienda la entidad custom como raíz con `$filter` y `$top` (ver D-67).

La vinculación entre un Custom MDF y los empleados puede ocurrir en estas variantes:

1. **`externalCode` de tipo `User`**: el `externalCode` contiene el `userId` y existe una nav
   `externalCodeNav` hacia `User`. **Medido: presente en 22/79 entidades en PROD**, no en todas.
2. **Campo personalizado de tipo `User`**: el `externalCode` es un código propio del registro y
   una nav apunta a `User`. Los nombres reales son heterogéneos: `cust_UsuarioNav`, `userIdNav`,
   `cust_workerIdNav`, `cust_workerIDNav`, `cust_userIdNav`, `cust_GerenteNav`,
   `cust_Jefe_ServicioNav`, `cust_CalificadoPorNav`, `cust_ID_Contacto_InternoNav`, etc.
   **La señal fiable es `targetEntitySet === "User"`, NO el sufijo del nombre.**
3. **`userId` como clave**: algunas entidades usan `userId` en su clave primaria en lugar de
   `externalCode` (medido: 3 en PROD, 4 en DEV, 4 en TEST).
4. **Objeto Hijo Compuesto (Composite Child)**: claves con el patrón `cust_<Padre>_<campo>`
   donde `<Padre>` es una entidad custom existente (p. ej. `cust_ASOC_EPIS_Detalles` ←
   `cust_ASOC_EPIS`). **Medido: 15 en PROD, 18 en DEV, 19 en TEST.**
5. **Objetos Independientes (Unlinked)**: tablas maestras o catálogos sin vínculo a empleado.

**Navs de auditoría — excluir siempre del análisis:** `createdByNav` y `lastModifiedByNav`
apuntan a `User` y existen en **el 100%** de las entidades custom (79/79 en PROD). No son
vínculo de negocio y son la causa principal de falsos positivos si no se excluyen.

---

## 4. Arquitectura de Descubrimiento y Clasificación en `MetadataService`

### 4.1 Principio Zero-Network
`MetadataService` ya implementa `getParsedMetadata(env, alias)`. La función `parseMetadata(xml)` ya construye `entitySchemas: Record<string, EntitySchema>`. Toda la información requerida (nombres de entidades, claves primarias, propiedades y propiedades de navegación) ya se encuentra residente en memoria.

### 4.2 Algoritmo de Clasificación

> **Corregido tras validación empírica (2026-10-14; PROD/DEV/TEST).** Las reglas originales
> producían falsos positivos masivos: `createdByNav`/`lastModifiedByNav` (navs a `User`
> presentes en el 100% de las entidades) inflaban `DIRECT_USER_KEY` hasta marcar 41 de 79
> entidades como vinculadas sin serlo, y el test «nav a otro `cust_*`» marcaba como
> `COMPOSITE_CHILD` a 70 entidades cuando los hijos reales (por patrón de clave) son 15.

Para cada entidad en `entitySets`:

0. **Exclusión de navs de auditoría (paso previo obligatorio)**: al analizar navs hacia `User`,
   descartar `createdByNav` y `lastModifiedByNav`. Sin este paso las Reglas 1 y 3 disparan
   sobre entidades no vinculadas.
1. **Filtro de prefijo**: `isCustomMdfEntity(name)` (D-63). Si es falso, se descarta.
2. **Análisis de Allowlist**: Si existe `entityAllowlist`, verificar
   `isEntityAllowed(entityAllowlist, name)`. Si no está permitida, se ignora (D-68/FR-74).
3. **Detección de Effective Dating**: `isEffectiveDated = true` si alguna clave es
   `effectiveStartDate` **o** `mdfSystemEffectiveStartDate` (medido: la segunda variante
   aparece como clave, p. ej. `cust_AccionSocial` en TEST).
4. **Detección de Vinculación de Empleado (`MdfEmployeeLink`)**, evaluada en este orden:
   * **Regla 1 (`DIRECT_USER_KEY`)**: alguna clave es `externalCode` **o `userId`**, y existe
     una nav **no-auditoría** a `User`. Preferir `externalCodeNav`/`userIdNav` si existen.
   * **Regla 2 (`DIRECT_EMPLOYMENT_KEY`)**: igual que la 1 con destino `EmpEmployment`.
     **No dispara en los tres tenants medidos (0 navs a `EmpEmployment`).**
   * **Regla 3 (`USER_FIELD_NAVIGATION`)**: existe una nav **no-auditoría** a `User` y el campo
     de vínculo no es una de las claves. El campo base se deriva del nombre de la nav.
   * **Regla 4 (`EMPLOYMENT_FIELD_NAVIGATION`)**: igual que la 3 con `EmpEmployment`.
     **Sin casos medidos en los tres tenants.**
   * **Regla 5 (`COMPOSITE_CHILD`)**: alguna clave casa
     `^cust_([A-Za-z0-9_]+?)_(externalCode|effectiveStartDate|userId)$` **y** el grupo 1 es una
     entidad custom existente. La sola existencia de una nav hacia otro `cust_*` **no basta**
     (70 falsos positivos frente a 15 hijos reales).
   * **Regla 6 (`UNLINKED_STANDALONE`)**: ninguna de las anteriores.
5. **Generación de `MdfQueryGuidance`**:
   * Plantilla de `$filter` según el tipo de vínculo. Las tres formas están **verificadas en
     producción** (`recruiting-backend` de operational-centers):
     * `DIRECT_USER_KEY` con clave `externalCode`: `$filter="externalCode eq '<userId>'"`.
     * `DIRECT_USER_KEY` con clave `userId`: `$filter="userId eq '<userId>'"`.
     * `USER_FIELD_NAVIGATION` **por segmento de navegación**: `$filter="<navProp>/userId eq '<userId>'"`.
       Es la forma que producción usa para entidades como `cust_Prendas`
       (`$filter=externalCodeNav/userId eq '<id>'`) y `cust_UbicacionFisica`
       (`$filter=cust_centro/externalCode eq '<id>'`). Filtrar por el nombre del campo escalar
       puede fallar si la propiedad no existe suelta; el segmento de navegación sí funciona.
   * Si `isEffectiveDated`: recomendar `$orderby="effectiveStartDate desc"` **más `$top=1`** para
     obtener el registro vigente, y `$fromDate=1970-01-12&toDate=9999-12-31` para el histórico.
     Es la forma exacta medida en producción; nótese que `toDate` va **sin** `$`.
   * La advertencia sobre `$expand` en `User` se redacta según el resultado verificado de §3.4:
     la navegación existe y es expandible, pero devuelve la colección hija completa e inacotable
     (224 registros / 1,75 MB medidos), y el tope de FR-86 la rechazaría.
   * El texto de las advertencias se resuelve en el **idioma activo** (D-70/FR-75). Las plantillas
     de `$filter`, el `exampleQuery` y los identificadores OData **no** se traducen.

---

## 5. Exposición en `ssff-mcp`

### 5.1 Enriquecimiento de Recursos MCP

#### 1. Enriquecimiento del catálogo general `sf://{env}/entities`
Se añaden dos flags a los elementos devueltos por la URI `sf://{environment}/entities`. `isCustom` ya existía (`src/tools.ts:848`); lo nuevo es `isEmployeeLinked` e `isEffectiveDated`:
```json
{
  "name": "cust_EmployeeEquipment",
  "entityType": "SFOData.cust_EmployeeEquipment",
  "isCustom": true,
  "isEmployeeLinked": true,
  "isEffectiveDated": true,
  "keyProperties": ["externalCode", "effectiveStartDate"]
}
```

#### 2. Recurso MCP dedicado: `sf://{env}/mdf/custom`
Devuelve el listado filtrado y categorizado de todos los Custom MDF permitidos:
```json
{
  "environment": "prod",
  "totalCount": 12,
  "employeeLinkedCount": 8,
  "entities": [
    {
      "name": "cust_EmployeeEquipment",
      "isEffectiveDated": true,
      "linkType": "DIRECT_USER_KEY",
      "targetEntity": "User",
      "matchField": "externalCode"
    }
  ]
}
```

#### 3. Detalle (reutiliza el recurso existente): `sf://{env}/entities/{entitySet}`
Devuelve el esquema completo, propiedades y el bloque de guía semántica:
```json
{
  "entitySet": "cust_EmployeeEquipment",
  "isCustom": true,
  "isEffectiveDated": true,
  "keys": ["externalCode", "effectiveStartDate"],
  "employeeLink": {
    "type": "DIRECT_USER_KEY",
    "targetEntitySet": "User",
    "matchingField": "externalCode",
    "navigationProperty": "externalCodeNav"
  },
  "guidance": {
    "locale": "es_ES",
    "suggestedFilter": "externalCode eq '<userId>'",
    "recommendedOrderBy": "effectiveStartDate desc",
    "warnings": [
      "La navegación inversa desde User existe y es expandible, pero devuelve la colección hija completa sin poder acotarse (medido: 224 registros / 1,75 MB); consulta cust_EmployeeEquipment como raíz con $filter y $top.",
      "La entidad está fechada efectivamente. Para obtener el registro vigente, filtra por externalCode y ordena por effectiveStartDate desc."
    ],
    "exampleQuery": {
      "tool": "query_entity",
      "entityPath": "cust_EmployeeEquipment",
      "filter": "externalCode eq '1042'",
      "orderby": "effectiveStartDate desc",
      "top": 1
    }
  },
  "properties": [...],
  "navigationProperties": [...]
}
```

---

### 5.2 Herramienta MCP: `inspect_custom_mdf`

```typescript
const inspectCustomMdfSchema = z.object({
  environment: z.string().optional().describe("Environment alias. May be omitted in inline mode."),
  entitySet: z.string().optional().describe("Specific Custom MDF entity set name (e.g. 'cust_EmployeeEquipment'). If omitted, lists all Custom MDF entities."),
  employeeLinkedOnly: z.boolean().optional().describe("When listing entities, filter only those linked to User or EmpEmployment. Default: false."),
  locale: z.string().optional().describe("BCP-47 locale for guidance text, normally the user's own language (e.g. 'es_ES'). It takes precedence over config defaultLocale, SF_DEFAULT_LOCALE and the 'en_US' fallback."),
}).strict();
```

---

## 6. Diseño Técnico en el Codebase

### 6.1 Modificaciones en `src/metadata.ts`

```typescript
export type MdfEmployeeLinkType =
  | "DIRECT_USER_KEY"
  | "DIRECT_EMPLOYMENT_KEY"
  | "USER_FIELD_NAVIGATION"
  | "EMPLOYMENT_FIELD_NAVIGATION"
  | "COMPOSITE_CHILD"
  | "UNLINKED_STANDALONE";

/** Bloque de guía semántica (§5.1.3). */
export interface MdfQueryGuidance {
  /** Locale BCP-47 con el que se resolvieron los `warnings` (D-70). */
  locale: string;
  /** Plantilla de `$filter`. Opcional: `UNLINKED_STANDALONE` no tiene campo de enlace. */
  suggestedFilter?: string;
  recommendedOrderBy?: string;
  /** Textos en el idioma activo; nunca en varios idiomas a la vez (D-70). */
  warnings: string[];
  exampleQuery: {
    tool: "query_entity";
    entityPath: string;
    filter?: string;
    orderby?: string;
    top?: number;
  };
}

/** Ítem del listado `sf://{env}/mdf/custom` — plano y compacto (§5.1.2). */
export interface CustomMdfSummary {
  name: string;
  isEffectiveDated: boolean;
  linkType: MdfEmployeeLinkType;
  targetEntity?: string;
  matchField?: string;
}

/** Vínculo de empleado en el detalle (§5.1.3), anidado. */
export interface MdfEmployeeLink {
  type: MdfEmployeeLinkType;
  targetEntitySet?: string;
  matchingField?: string;
  navigationProperty?: string;
  parentEntitySet?: string;
}

/**
 * Payload de `sf://{env}/entities/{entitySet}` para entidades custom (§5.1.3).
 * NO extiende `CustomMdfSummary`: el detalle usa `entitySet`/`keys` (forma
 * `EntitySchema`) y `employeeLink` anidado, mientras el listado es plano.
 */
export interface CustomMdfDetails {
  entitySet: string;
  isCustom: boolean;
  isEffectiveDated: boolean;
  keys: string[];
  employeeLink: MdfEmployeeLink;
  guidance: MdfQueryGuidance;
  properties: EntityProperty[];
  navigationProperties: NavigationProperty[];
}
```

#### Métodos y helpers añadidos a `MetadataService`:
* `isCustomMdfEntity(name: string): boolean` — helper canónico de D-63; **única** definición de «entidad Custom MDF» (sustituye la comprobación inline de `src/tools.ts:848`).
* `classifyEntity(schema: EntitySchema, allSchemas: Record<string, EntitySchema>): CustomMdfDetails`
* `listCustomMdf(env: EnvTarget, alias: string, allowlist?: AllowlistEntry[], employeeOnly?: boolean): Promise<CustomMdfSummary[]>`
* `getCustomMdfDetails(env: EnvTarget, alias: string, entitySet: string, allowlist?: AllowlistEntry[]): Promise<CustomMdfDetails | undefined>`

### 6.2 Modificaciones en `src/tools.ts`
1. Registro de la herramienta `inspect_custom_mdf`.
2. Registro del recurso nuevo `sf://{environment}/mdf/custom` y enriquecimiento **aditivo** del recurso de detalle existente `sf://{environment}/entities/{entitySet}` (sin crear un árbol `mdf/` paralelo).
3. Enriquecimiento de `sf://{environment}/entities` con `isEmployeeLinked` y `isEffectiveDated`.
4. Sustituir la comprobación inline `name.startsWith("cust_") || name.startsWith("Cust_")` de `src/tools.ts:848` por el helper canónico `isCustomMdfEntity` (D-63), para que exista una única definición de «entidad Custom MDF».

### 6.3 Modificaciones en `src/config.ts`

`configSchema` es `.strict()` (`src/config.ts:159-167`): una clave desconocida hace fallar la validación. Por tanto, referenciar `defaultLocale` **exige añadirlo al esquema** antes de que la cadena de D-70/FR-75 pueda funcionar. Sin este cambio, cualquier `config.json` que use el campo será rechazado.

```typescript
defaultLocale: z.string().regex(/^[A-Za-z]{2}(-[A-Za-z]{2})?$/).optional(),
```

* **Opcional y sin valor por defecto en el esquema**: su ausencia no es error; activa el siguiente nivel de la cadena (`SF_DEFAULT_LOCALE`, luego `en_US`).
* **Formato BCP-47 laxo** (`es`, `es_ES`). El validador comprueba el formato, **no** que el idioma exista en el catálogo: un locale sin traducciones cae a `en_US`.
* **Catálogo de mensajes en el repositorio** (`.ts`, sin dependencias externas — DS-MDF-06). Cobertura inicial: `en_US` y `es_ES`.
* **Dependencia cruzada**: el mismo campo lo necesita `PRD-feature-picklists.md` (su D-60). Implementarlo una sola vez en `src/config.ts` sirve a ambos; hacerlo por separado es el camino a la divergencia.

---

## 7. Requisitos Funcionales (FR-67..FR-76 · FR-86)

* **FR-67 (Detección Automática de Custom MDF)**: El sistema DEBE clasificar automáticamente como Custom MDF cualquier entidad cuyo nombre coincida con el patrón `/^[cC]ust_/`.
* **FR-68 (Clasificación de Vinculación de Empleado)**: El sistema DEBE analizar las claves y `NavigationProperties` de cada entidad Custom MDF para asignar uno de los 6 tipos de `MdfEmployeeLinkType`.
* **FR-69 (Generación de `queryGuidance`)**: Para cada Custom MDF clasificado, el sistema DEBE generar un bloque semántico con instrucciones de consulta seguras, identificando el campo sobre el cual aplicar `$filter` y advirtiendo de que la navegación inversa desde `User` devuelve la colección hija completa e inacotable.
* **FR-70 (Herramienta `inspect_custom_mdf`)**: El servidor MCP DEBE exponer la herramienta `inspect_custom_mdf` permitiendo tanto el listado general como la inspección profunda de un Custom MDF específico.
* **FR-71 (Recurso `sf://{env}/mdf/custom`)**: El servidor MCP DEBE exponer un recurso URI que enumere las entidades Custom MDF del entorno especificado.
* **FR-72 (Detalle sin superficie nueva)**: El servidor MCP **NO DEBE** crear un recurso `sf://{env}/mdf/custom/{entitySet}`. El recurso existente `sf://{env}/entities/{entitySet}` DEBE devolver, para entidades Custom MDF, los campos aditivos `isCustom`, `isEffectiveDated`, `employeeLink` y `guidance`, preservando su contrato actual.
* **FR-73 (Catálogo Base mínimo)**: **[Reescrito el 2026-10-14 por decisión del usuario]** El recurso `sf://{env}/entities` DEBE devolver **solo el nombre** de cada entidad. Motivo medido: con `entityType`, `isCustom`, `isEmployeeLinked`, `isEffectiveDated` y `keyProperties` el catálogo pesa **142 KB** contra las 658 entidades de PROD; solo con nombres, **~19 KB**. Los flags de vínculo y de fecha efectiva viven en `sf://{env}/mdf/custom` y en el detalle `sf://{env}/entities/{entitySet}`. Esta redacción **sustituye** al requisito anterior de enriquecer cada elemento del catálogo.
* **FR-74 (Aislamiento de Allowlist)**: Si `entityAllowlist` está configurada, ninguna entidad excluida DEBE ser listada ni inspeccionada a través de las nuevas herramientas o recursos, respondiendo con `ENTITY_NOT_ALLOWED`.
* **FR-75 (Guía multilingüe)**: El texto de `warnings` DEBE resolverse en **un único idioma activo**, dando prioridad a la elección del usuario, mediante la precedencia `locale` (tool) > `defaultLocale` (`config.json`) > `SF_DEFAULT_LOCALE` > `"en_US"`, exponiendo el locale resuelto en `guidance.locale`. El sistema **NUNCA DEBE** emitir simultáneamente los textos de todos los idiomas. Las plantillas de `$filter`, el `exampleQuery` y los identificadores OData NO se traducen.
* **FR-76 (Campo `defaultLocale` en la configuración)**: `configSchema` DEBE admitir la clave opcional `defaultLocale` en formato BCP-47 laxo. Sin ella, la validación `.strict()` rechazaría cualquier configuración que la use. Su ausencia DEBE hacer caer la resolución al nivel siguiente de la cadena de FR-75.
* **FR-86 (Tope de tamaño de respuesta al LLM)**: El tope DEBE aplicarse **únicamente a lo que se devuelve al cliente LLM**. Los usos internos —metadata para clasificación, caché en disco, hidratación— DEBEN quedar **exentos**. En `batch_get` el tope DEBE evaluarse **por cada petición interna**, no sobre el conjunto del batch. Al superarlo, el tool DEBE devolver un error **saneado** que indique cómo acotar la consulta (`$select`, `$top`, `$filter`). El tope NO DEBE basarse en una lista de entidades conocidas. **La tool `get_metadata` queda exenta** del tope, pero su uso NUNCA DEBE recomendarse: la guía DEBE dirigir a la exploración entidad a entidad.

---

## 8. Evaluación de Esfuerzo, Complejidad, Riesgos y Dependencias

### 8.1 Estimación de Esfuerzo

| Componente / Tarea | Días Estimados | Complejidad |
|---|---|---|
| **T1: Heurística y tipos en `src/metadata.ts`** | 1.5 - 2 días | Media |
| **T2: Exposición de Recursos MCP en `src/tools.ts`** | 1.0 día | Baja |
| **T3: Registro de herramienta `inspect_custom_mdf`** | 1.0 día | Baja |
| **T4: Suite de pruebas y validación** | 1.5 días | Media |
| **T5: `defaultLocale` en `src/config.ts` y catálogo de mensajes i18n** | 0.5 día | Baja |
| **Total estimado** | **5.5 - 6.5 días laborables** | **Media** |

### 8.2 Matriz de Riesgos y Mitigaciones

| Riesgo Identificado | Severidad | Mitigación Técnica |
|---|---|---|
| Variabilidad de nombres de campo de usuario | Media | Señal fiable: `targetEntitySet === "User"` **excluyendo las navs de auditoría** `createdByNav`/`lastModifiedByNav`. Los sufijos de nombre **no** sirven: medidos `cust_GerenteNav`, `cust_Jefe_ServicioNav`, `cust_workerIdNav`, `cust_ID_Contacto_InternoNav`. Corregido tras validación empírica (2026-10-14). |
| Degradación de latencia en EDMX de 7.5 MB | Baja | Análisis puramente en memoria, impacto en CPU < 5 ms. |
| Falsos positivos por RBP en SuccessFactors | Media | Advertencia explícita en `queryGuidance` sobre permisos requeridos en SAP (*Miscellaneous Permissions*). |
| Regresiones de `entityAllowlist` | Alta | Pruebas automatizadas fail-closed. |

### 8.3 Dependencias de Terceros
* Cero dependencias nuevas. Reutiliza el stack actual.

---

## 9. Estado de implementación y decisiones resueltas (2026-10-14)

Implementado en `src/mdf.ts`, `src/i18n.ts`, `src/size-guard.ts` y `src/tools.ts`; suite en verde (317 tests).

Estas son las decisiones que §4 y §5.1 dejaban abiertas y que **la implementación resolvió**. Se registran aquí porque hasta ahora solo existían en la conversación:

| Decisión abierta | Resuelto como | Dónde |
|---|---|---|
| ¿`employeeLinkedOnly` incluye `COMPOSITE_CHILD`? | **No**: un hijo compuesto es vínculo indirecto. | `isEmployeeLinkedType` (`src/mdf.ts:93`) |
| Tipos 2 y 4 (`EmpEmployment`), sin casos medidos | **Se mantienen** en el enum y las reglas. | `src/mdf.ts:15-21` |
| Memoización: ¿bajo demanda o cacheada en `ParsedMetadata`? | **Bajo demanda**. `ParsedMetadata` y `CacheEntry` no cambian ⇒ **el formato de la caché en disco no migra**. | `src/metadata.ts:69,75` |
| Ubicación del catálogo i18n | **`src/i18n.ts`**, en código y sin dependencias. | `src/i18n.ts` |
| Cobertura i18n | `en_US` + `es_ES`, con `DEFAULT_LOCALE` y `resolveLocale`. | `src/i18n.ts:12-17,60` |
| ¿`entityType` en el detalle? | **Sí**, incluido. | `CustomMdfDetails` (`src/mdf.ts:64-74`) |
| Filtrado del recurso de listado | **Asimetría aceptada**: `employeeLinkedOnly` vive en el tool, no en el recurso. | `inspectCustomMdfSchema` |
| Dependencia cruzada de `defaultLocale` | **Global** en `configSchema`, como pedía FR-76. | `src/config.ts:161-178` |

### 9.1 Desviaciones conocidas

| Requisito | Estado real |
|---|---|
| **FR-86** pedía un tope de bytes **configurable** | Hoy se ajusta con la variable de entorno **`SF_MAX_RESPONSE_BYTES`** (por defecto 256 KiB); un valor ausente, no numérico o no positivo cae al defecto. **No** es campo de `config.json`: exponerlo ahí exige pasar el valor por los tres call sites de `src/tools.ts`. Pendiente decidir si se quiere en la configuración. |
| La Regla 1 decía "preferir `externalCodeNav`/`userIdNav` si existen" | La implementación es **más estricta, y mejor**: la Regla 1 solo dispara si la nav es la **propia de la clave** (`${key}Nav`). Lo justifica `src/mdf.ts:108-113`: aceptar cualquier navegación a `User` absorbería toda entidad vinculada y dejaría las reglas 3-4 inalcanzables. |
| Ejemplo ilustrativo de §5.1.3 | El documento no se actualizó, aunque la spec (§4.2/D-67) sí. La implementación usa la forma verificada en producción: `<navProp>/userId`. |
| Fallback i18n por idioma base (`es_MX` → `es_ES`) | **Sin verificar** si `resolveLocale` lo soporta o solo hace coincidencia exacta. |
