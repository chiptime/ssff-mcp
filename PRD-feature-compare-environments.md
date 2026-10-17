# PRD: Drift y Comparación Cruzada entre Instancias (`compare_environments`)

| Metadato | Valor |
|---|---|
| **Documento** | PRD-feature-compare-environments.md |
| **Versión** | v1.0.0 |
| **Estado** | PROPUESTO / LISTO PARA REVISIÓN (Ready for Review) |
| **Fecha** | 2026-10-15 |
| **Componente** | `ssff-mcp` (Herramientas MCP, Comparación de Metadatos, QA & Compliance) |
| **Autor / Arquitectura** | AI Engineering & SAP Solutions Architecture Team |
| **Alineación previa** | `PRD.md` (D-01..D-25), `PRD-phase2.md` (D-26..D-32), `PRD-phase3.md` (D-33..D-44), `PRD-phase4.md` (D-45..D-52), `archive/PRD-feature-custom-mdf.md` (D-62..D-70), `archive/PRD-feature-inspect-entity.md` (D-80..D-81), `PRD-feature-datacenter-catalog.md` (D-82..D-88). Este documento arranca en **D-89 / FR-116**. |

---

## 1. Resumen Ejecutivo y Objetivos

### 1.1 Visión General
En cualquier arquitectura empresarial de SAP SuccessFactors, las organizaciones mantienen un ciclo de vida con múltiples instancias o *tenants*: habitualmente **Development**, **Test / Staging** y **Production**. Durante los despliegues de proyectos, la implementación de extensiones (Custom MDF Objects `cust_*`) y los dos grandes *Releases* semestrales de SAP (1H y 2H), uno de los mayores desafíos para los equipos de consultoría, QA y auditoría es detectar el **desfase de configuración (*configuration drift*)** entre entornos.

Actualmente en `ssff-mcp`, para comparar si una entidad o un conjunto de campos existe en `staging` y en `prod`, un agente LLM o un usuario humano debe:
1. Invocar `inspect_entity` (D-80) sobre el entorno A.
2. Invocar `inspect_entity` sobre el entorno B.
3. Cargar ambos esquemas masivos en la ventana de contexto del LLM y solicitarle que calcule el diff mentalmente, consumiendo decenas de miles de tokens de contexto y corriendo el riesgo de alucinaciones u omisiones en esquemas con cientos de campos.

La feature de **Drift y Comparación Cruzada entre Instancias (`compare_environments`)** dota al servidor de un motor determinista, estructurado y de alto rendimiento para calcular diferencias de metadatos entre dos entornos configurados. La herramienta procesa el diff en el motor Node.js utilizando los documentos `$metadata` locales ya cacheados por `MetadataService`, devolviendo al LLM exclusivamente las discrepancias estructuradas (*added, removed, modified, types, associations*) con consumo mínimo de tokens.

### 1.2 Objetivos Clave (OKRs)
* **Detección Determinista de Drift**: Identificar con 100% de exactitud matemática entidades faltantes, campos añadidos/eliminados, cambios de tipos EDM, discrepancias de nulabilidad y asociaciones rotas entre dos entornos.
* **Cero Sobrecarga de Red**: Ejecutar la comparación en memoria a partir de los archivos de metadatos locales ya cacheados en disco (`~/.cache/ssff-mcp/metadata-<alias>.json`, D-43).
* **Seguridad Estricta e Intersección Fail-Closed**: Si alguno de los dos entornos tiene una `entityAllowlist` restrictiva, la comparación solo se realiza sobre la intersección de entidades permitidas en ambos entornos (`allowlist(A) ∩ allowlist(B)`).
* **Eficiencia de Contexto LLM**: Proporcionar respuestas compactas en formato JSON estructurado (< 20 KB), evitando saturar el contexto del modelo con propiedades idénticas no modificadas.
* **Soporte Especializado para Custom MDF**: Resaltar de manera prioritaria objetos personalizados (`cust_*`) y extensiones creadas por el cliente que con frecuencia se olvidan de transportar entre tenants.

---

## 2. Registro de Decisiones de Arquitectura (Ledger)

| ID | Decisión | Origen / Justificación |
|---|---|---|
| **D-89** | **Herramienta Dedicada `compare_environments`**: Se registra la herramienta MCP `compare_environments` con argumentos `{ sourceEnvironment, targetEnvironment, entitySet?, customOnly?, category? }` validados mediante Zod estricto ante claves desconocidas. | Proporciona una interfaz unívoca y predecible para el LLM y el usuario, sin sobrecargar las herramientas de consulta atómica (`query_entity`, `inspect_entity`). |
| **D-90** | **Ejecución Local Zero-Network sobre Metadatos Cacheados**: La comparación no lanza peticiones HTTP en tiempo de ejecución si ambos entornos ya tienen su `$metadata` en la caché persistente L2 (D-43). Si la caché de algún entorno está ausente o caducada, se hidrata mediante el flujo seguro habitual de `MetadataService`. | Garantiza respuestas instantáneas (< 50 ms) y no consume cuota de API de SAP. |
| **D-91** | **Intersección Fail-Closed de `entityAllowlist`**: Una entidad solo es elegible para comparación si está autorizada en **ambos** entornos: `Allowed = Allowlist(source) ∩ Allowlist(target)`. Si un entorno tiene allowlist y el otro no, se aplica la más restrictiva. Las entidades no autorizadas se omiten silenciosamente del diff. | Previene la filtración inadvertida de la existencia de entidades confidenciales configuradas en un entorno pero restringidas en otro (D-19, D-30). |
| **D-92** | **Formato de Diff Semántico Estructurado**: La salida agrupa las diferencias en categorías claras: `missingInTarget` (entidades o campos en source pero no en target), `missingInSource` (en target pero no en source), y `modified` (discrepancias en tipo EDM, nulabilidad, longitud máxima o multiplicidad). | Permite al LLM generar informes de auditoría ejecutivos de forma inmediata sin post-procesamiento heurístico. |
| **D-93** | **Modo Resumen vs Modo Detalle de Entidad**: Sin el argumento `entitySet`, la herramienta devuelve el diff a nivel de catálogo de entidades (`totalEntitiesSource`, `totalEntitiesTarget`, `entitiesOnlyInSource`, `entitiesOnlyInTarget`, `entitiesInBoth`). Si se especifica `entitySet`, se calcula el diff exhaustivo a nivel de campo y relación para esa entidad. | Optimiza el uso de tokens y previene respuestas masivas cuando existen desfases de cientos de entidades. |
| **D-94** | **Tope de Seguridad de Carga Útil (Payload Clamping)**: Si el resultado de un diff de catálogo excede 200 entidades discrepantes o 100 KB, el motor devuelve un resumen numérico y una lista truncada con los primeros 50 elementos, adjuntando la instrucción clara al LLM de inspeccionar por entidades específicas o usar `customOnly: true`. | Coherente con D-75/FR-86 para garantizar que ningún tool call desborde la ventana de contexto. |
| **D-95** | **Normalización de Nombres Case-Insensitive con Preservación**: La comparación empareja nombres de entidades y campos normalizando a minúsculas para detectar discrepancias de capitalización (ej. `cust_Car` vs `cust_car`), pero preserva los nombres nativos originales en el payload de salida. | Resuelve problemas clásicos de SAP donde un transporte manual modifica la capitalización de identificadores. |
| **D-96** | **Trazabilidad en `stderr` sin Exposición de Credenciales**: La ejecución del diff emite una traza JSON estructurada en `stderr` con duración, número de discrepancias encontradas y entornos involucrados, garantizando estricta censura de credenciales (RFC 5424 / D-08). | Soporte para observabilidad y auditoría de uso del servidor MCP. |

---

## 3. Especificación de la Herramienta MCP `compare_environments`

### 3.1 Esquema de Entrada (Zod Schema)

```typescript
export const CompareEnvironmentsArgsSchema = z.object({
  sourceEnvironment: z.string().trim().min(1, "sourceEnvironment es obligatorio (ej. 'staging' o 'dev')"),
  targetEnvironment: z.string().trim().min(1, "targetEnvironment es obligatorio (ej. 'prod')"),
  entitySet: z.string().trim().optional(),
  customOnly: z.boolean().optional().default(false),
  category: z.enum(['all', 'properties', 'navigation', 'mdf']).optional().default('all'),
}).strict();
```

### 3.2 Esquema de Salida: Comparación a Nivel de Catálogo (`entitySet` no especificado)

```json
{
  "comparisonType": "catalog",
  "sourceEnvironment": "staging",
  "targetEnvironment": "prod",
  "summary": {
    "totalInSource": 658,
    "totalInTarget": 652,
    "identicalCount": 650,
    "discrepanciesCount": 8
  },
  "missingInTarget": [
    {
      "name": "cust_TalentPoolExtended",
      "isCustom": true,
      "employeeLinked": true
    },
    {
      "name": "cust_SafetyAuditRecord",
      "isCustom": true,
      "employeeLinked": false
    }
  ],
  "missingInSource": [],
  "modifiedEntities": [
    {
      "name": "User",
      "isCustom": false,
      "propertyCountDiff": { "source": 142, "target": 140 }
    }
  ],
  "guidance": "Se han detectado 2 objetos Custom MDF presentes en staging que no existen en prod. Utilice compare_environments con entitySet='User' para ver las discrepancias de campos de la entidad User."
}
```

### 3.3 Esquema de Salida: Comparación a Nivel de Entidad (`entitySet: "User"`)

```json
{
  "comparisonType": "entity",
  "entitySet": "User",
  "sourceEnvironment": "staging",
  "targetEnvironment": "prod",
  "summary": {
    "propertiesInSource": 142,
    "propertiesInTarget": 140,
    "navigationInSource": 28,
    "navigationInTarget": 28,
    "hasDrift": true
  },
  "propertyDrift": {
    "missingInTarget": [
      { "name": "customString15", "type": "Edm.String", "nullable": true }
    ],
    "missingInSource": [],
    "typeMismatches": [
      {
        "name": "customLong1",
        "sourceType": "Edm.Int64",
        "targetType": "Edm.Int32"
      }
    ],
    "nullabilityMismatches": []
  },
  "navigationDrift": {
    "missingInTarget": [],
    "missingInSource": [],
    "multiplicityMismatches": []
  },
  "mdfDrift": null
}
```

---

## 4. Requisitos Funcionales (FR)

* **FR-116 (MUST)**: El servidor DEBE registrar la herramienta `compare_environments` en `tools/list` con el esquema estricto especificado en §3.1.
* **FR-117 (MUST)**: Si `sourceEnvironment` o `targetEnvironment` no coinciden con un entorno configurado en `config.json`, la herramienta DEBE responder inmediatamente con error saneado `ENVIRONMENT_NOT_FOUND` sin realizar ninguna operación.
* **FR-118 (MUST)**: Si `sourceEnvironment === targetEnvironment`, la herramienta DEBE responder con error `OPTION_INVALID` informando que no tiene sentido comparar un entorno consigo mismo.
* **FR-119 (MUST)**: La herramienta DEBE obtener los metadatos de ambos entornos utilizando la caché local persistente de `MetadataService`. Solo si la caché no existe en disco, se solicitará a la red respetando las políticas de timeouts y certificados existentes.
* **FR-120 (MUST)**: En presencia de `entityAllowlist` en `sourceEnvironment` o `targetEnvironment`, la herramienta DEBE excluir de la comparación toda entidad que no esté explícitamente permitida en **ambos** entornos (intersección fail-closed).
* **FR-121 (MUST)**: Cuando se omite `entitySet`, la herramienta DEBE comparar el conjunto completo de `entitySets`, clasificando entidades en: idénticas, faltantes en target, faltantes en source, y entidades con número desigual de propiedades.
* **FR-122 (MUST)**: Cuando se especifica `customOnly: true` a nivel de catálogo, el análisis DEBE limitarse estrictamente a entidades cuyos nombres comiencen por `cust_` o `Cust_`.
* **FR-123 (MUST)**: Cuando se especifica `entitySet`, la herramienta DEBE verificar si dicha entidad existe en ambos entornos. Si falta en uno de ellos, DEBE devolver el informe indicando su ausencia completa en lugar de fallar. Si existe en ambos, DEBE contrastar:
  1. Propiedades escalares (existencia, tipo EDM, nulabilidad y longitud máxima).
  2. Propiedades de navegación (nombre, `targetEntitySet` y `multiplicity`).
  3. Para entidades Custom MDF: discrepancias en `mdfLinkType` y `effectiveDated`.
* **FR-124 (MUST)**: El payload de salida DEBE incluir una sección `guidance` con prosa analítica en lenguaje natural orientada a que el LLM comprenda la gravedad del drift y los pasos de mitigación recomendados.
* **FR-125 (SHOULD)**: La salida no debe exceder en ningún caso 256 KB. De sobrepasarse, DEBE truncar la lista de entidades o propiedades discrepantes añadiendo la propiedad `truncated: true` e indicando cómo filtrar por entidad específica.
* **FR-126 (MUST)**: La operación DEBE ser 100% de solo lectura y no provocar mutaciones de estado ni en los tenants remotos de SAP ni en la configuración local de `ssff-mcp`.

---

## 5. Diseño Técnico e Implementación

### 5.1 Ubicación de Código
* **`src/drift.ts`**: Módulo del motor de comparación (función `diffEntityCatalogs`, `diffEntitySchemas`, cálculo de intersección de allowlists).
* **`src/tools.ts`**: Registro del tool handler `compare_environments` en el servidor MCP y derivación hacia `src/drift.ts`.
* **`test/drift.test.ts`**: Suite exhaustiva de pruebas unitarias y de integración del motor de drift.

### 5.2 Algoritmo Central de Comparación de Entidad

```typescript
export function diffEntityDefinitions(
  source: ParsedEntityDetail,
  target: ParsedEntityDetail
): EntityDriftReport {
  const sourcePropMap = new Map(source.properties.map(p => [p.name.toLowerCase(), p]));
  const targetPropMap = new Map(target.properties.map(p => [p.name.toLowerCase(), p]));

  const missingInTarget = source.properties.filter(p => !targetPropMap.has(p.name.toLowerCase()));
  const missingInSource = target.properties.filter(p => !sourcePropMap.has(p.name.toLowerCase()));

  const typeMismatches = [];
  const nullabilityMismatches = [];

  for (const sp of source.properties) {
    const tp = targetPropMap.get(sp.name.toLowerCase());
    if (tp) {
      if (sp.type !== tp.type) {
        typeMismatches.push({ name: sp.name, sourceType: sp.type, targetType: tp.type });
      }
      if (sp.nullable !== tp.nullable) {
        nullabilityMismatches.push({ name: sp.name, sourceNullable: sp.nullable, targetNullable: tp.nullable });
      }
    }
  }

  return {
    missingInTarget,
    missingInSource,
    typeMismatches,
    nullabilityMismatches,
    // Idem para navigation properties y MDF metadata
  };
}
```

---

## 6. Seguridad y Gobernanza (DS)

* **DS-DRIFT-01 (Aislamiento de Entornos)**: El motor de drift trata a cada entorno de forma estanca. Las credenciales de un entorno jamás se mezclan ni se comparten en la sesión del otro.
* **DS-DRIFT-02 (Fuga Cero en Allowlists Asimétricas)**: Si `prod` restringe la visibilidad de tablas financieras pero `dev` las tiene abiertas, `compare_environments` NO listará las tablas financieras bajo `missingInTarget` si eso violara la allowlist de `prod`. La regla de intersección previene el descubrimiento forzado de esquemas restringidos.
* **DS-DRIFT-03 (Sin llamadas activas de escritura)**: Garantía estricta de cumplimiento con D-10 y D-11 (servidor de solo lectura).

---

## 7. Plan de Pruebas y Validación

1. **Pruebas de Catálogo (`test/drift-catalog.test.ts`)**:
   - Comparación de entornos con catálogos idénticos -> `discrepanciesCount: 0`.
   - Detección de entidades añadidas solo en `source` o solo en `target`.
   - Filtro `customOnly: true` aislando únicamente objetos `cust_*`.
   - Respeto a `entityAllowlist` asimétrica (intersección fail-closed).
2. **Pruebas de Entidad Exhaustiva (`test/drift-entity.test.ts`)**:
   - Detección de campos faltantes en una tabla estándar (`User`).
   - Detección de cambio de tipo de datos (ej. `Edm.String` a `Edm.Int32`).
   - Detección de cambio de multiplicidad en navegaciones (`1` a `*`).
   - Comparación de objetos Custom MDF con cambio en `effectiveDated`.
3. **Casos Límite y Errores**:
   - Intento de comparar el mismo entorno consigo mismo (`OPTION_INVALID`).
   - Entorno origen o destino inexistente (`ENVIRONMENT_NOT_FOUND`).
   - Manejo elegante de esquemas masivos con clamping de salida.

---

## 8. Estimación de Esfuerzo

* **Complejidad:** Media (lógica de diff de estructuras en memoria, sin dependencias externas).
* **Story Points:** 8 SP.
* **Tiempo Estimado:** 3 a 4 días laborables.
