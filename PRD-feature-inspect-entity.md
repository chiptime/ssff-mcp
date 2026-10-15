# PRD — ssff-mcp Feature: `inspect_entity`, una sola herramienta para el modelo de datos

| Metadato | Valor |
|---|---|
| **Documento** | PRD-feature-inspect-entity.md |
| **Versión** | v0.1 |
| **Estado** | BORRADOR (DRAFT) — pendiente de aprobación; no autoriza implementación |
| **Fecha** | 2026-10-14 |
| **Motivo** | Tras retirar `get_metadata` (D-76), el modelo **no tiene ninguna herramienta** para consultar el modelo de datos de entidades **estándar**. Solo tiene herramientas para MDF. El esquema está disponible por recursos, pero depende de que el cliente los exponga. |
| **Alineación previa** | `PRD.md` (D-01..D-25), `PRD-phase2.md` (D-26..D-32), `PRD-phase3.md` (D-33..D-44), `PRD-phase4.md` (D-45..D-52), `PRD-feature-picklists.md` (D-53..D-61), `PRD-feature-custom-mdf.md` (D-62..D-70, D-75), `PRD-feature-odata-query-fidelity.md` (D-71..D-74), `PRD-feature-metadata-cache-invalidation.md` (D-78..D-79), `archive/PRD-feature-remove-get-metadata.md` (D-76..D-77). Este documento arranca en **D-80 / FR-99**. |
| **Naturaleza del cambio** | Sustituye una herramienta por otra. **Net: seguimos con 4 tools.** No añade superficie neta ni toca SuccessFactors. |

---

## 1. Resumen Ejecutivo

Se registra una única herramienta **`inspect_entity`** para consultar el modelo de datos, y se **retira `inspect_custom_mdf`**. El modelo pasa a tener **un solo gesto** para preguntar por el esquema, sea la entidad estándar o personalizada; los campos MDF aparecen como **aditamentos** cuando la entidad es custom, igual que ya hace el recurso de detalle.

El resultado es simétrico y neto cero: +1 herramienta para entidades estándar, −1 herramienta MDF, y el mismo total de 4.

---

## 2. Contexto y Problema (evidencia en el repositorio)

Hoy hay **dos canales con cobertura desigual**:

| | **Herramienta** (el modelo la ve siempre) | **Recurso** (depende del cliente) |
|---|---|---|
| Entidades **estándar** | ❌ **ninguna** | ✅ `sf://{env}/entities` + `sf://{env}/entities/{entitySet}` |
| Entidades **MDF** | ✅ `inspect_custom_mdf` | ✅ `sf://{env}/mdf/custom` |

Hechos verificados:

- Las 4 herramientas registradas son `list_environments`, `inspect_custom_mdf`, `query_entity` y `batch_get` (`src/tools.ts:422,441,484,649`). **Ninguna sirve entidades estándar.**
- Los 4 recursos son `overview`, `entities`, `entities/{entitySet}` y `mdf/custom` (`src/tools.ts:891,939,995,1044`).
- El recurso de detalle **sí es legible** (`sf://{env}/entities/User` devuelve el schema completo; hay dos tests que lo prueban). Su `list: undefined` solo significa que **no se enumera**, no que sea inalcanzable.

**Por qué el hueco importa.** Las herramientas aparecen siempre en `tools/list`; los recursos dependen de que el cliente los exponga y de que el modelo decida leerlos. Al retirar `get_metadata` (D-76) desapareció el único camino **universal** al esquema, y quedó sin sustituto para entidades estándar. El mismo razonamiento que justificó `inspect_custom_mdf` (D-66, «los clientes LLM exploran más proactivamente vía tools») se aplica igual a las estándar.

---

## 3. Objetivos y No-Objetivos

### Objetivos

1. Que el modelo pueda consultar el modelo de datos **sin depender de los recursos**.
2. **Un solo gesto** para entidad estándar y personalizada: misma forma de llamada, misma forma de respuesta.
3. Mantener el número de herramientas en **4** (retirar una al añadir otra).
4. No reintroducir el problema de `get_metadata`: payloads **acotados y estructurados**, nunca el EDMX crudo.

### No-Objetivos

* **MUST NOT** devolver el documento `$metadata` crudo ni porciones de XML (D-76).
* **MUST NOT** provocar peticiones de red más allá del `$metadata` ya cacheado (D-62).
* **MUST NOT** alterar `query_entity`, `batch_get` ni `list_environments`.
* Fuera de alcance: unificar el lado de los **recursos**. Se queda como está por una limitación del enrutado de MCP (§4, D-81).

---

## 4. Decisiones

| ID | Decisión | Justificación |
|---|---|---|
| **D-80** | **Una sola herramienta `inspect_entity`; `inspect_custom_mdf` se retira.** El listado clasificado pasa a `customOnly: true` y el detalle MDF pasa a ser **campos aditivos** del detalle normal. | Dos herramientas con formas distintas obligan al modelo a aprender dos flujos para la misma pregunta. El recurso de detalle **ya** usa este patrón —hay un test llamado *«detail of a standard entity is unchanged (no MDF fields)»*—, así que la herramienta solo lo espeja. Además, neto cero en superficie. |
| **D-81** | **El lado de los recursos NO se unifica**: se mantienen `sf://{env}/entities` y `sf://{env}/mdf/custom` separados. | Verificado en el SDK: `mcp.js:379` resuelve primero el recurso **exacto** y luego recorre **plantillas devolviendo la primera que encaje**; `uriTemplate.js:202` compara con una **regex**. Por tanto `sf://<alias>/entities/custom` compite con la plantilla `sf://{environment}/entities/{entitySet}`: o pierde (y devuelve `RESOURCE_NOT_FOUND`), o gana y **le roba el nombre `custom` a cualquier entidad real**. Registrar exactos por alias lo resolvería, a cambio de reservar el nombre. `mdf/custom` no reserva nada. Es una asimetría cosmética y aceptada. |

---

## 5. La herramienta `inspect_entity`

```typescript
const inspectEntitySchema = z.object({
  environment: z.string().optional(),   // omitible en modo inline (D-49)
  entitySet: z.string().min(1).optional(),
  customOnly: z.boolean().optional(),   // por defecto false
  employeeLinkedOnly: z.boolean().optional(), // exige customOnly
  query: z.string().min(1).optional(),  // filtro de texto libre sobre el nombre
  locale: z.string().optional(),        // idioma de la prosa de `guidance` (D-70)
}).strict();
```

### Modos

| Llamada | Devuelve |
|---|---|
| `inspect_entity({})` | Listado: `{ environment, totalCount, entities: [{ name, isCustom }] }` |
| `inspect_entity({ customOnly: true })` | Solo Custom MDF, con los campos del resumen MDF: `{ name, isEffectiveDated, linkType, targetEntity, matchField }` + `employeeLinkedCount` |
| `inspect_entity({ customOnly: true, employeeLinkedOnly: true })` | Igual, pero solo las entidades vinculadas a un empleado |
| `inspect_entity({ query: "emp" })` | Igual que el listado, filtrando por subcadena del nombre (sin distinguir mayúsculas) |
| `inspect_entity({ entitySet: "User" })` | Detalle: el schema (`entitySet`, `entityType`, `keys`, `properties`, `navigationProperties`) con `isCustom: false` |
| `inspect_entity({ entitySet: "cust_Prendas" })` | Detalle **más** los aditamentos MDF: `isCustom: true`, `isEffectiveDated`, `employeeLink`, `guidance` |

### Reglas de forma

- El detalle de una entidad **estándar** conserva **exactamente** el contrato del recurso `sf://{env}/entities/{entitySet}`: sin campos MDF añadidos.
- El detalle de una entidad **custom** devuelve el mismo contrato **más** `isCustom`, `isEffectiveDated`, `employeeLink` y `guidance` — idéntico al payload que ya expone el recurso.
- El listado general marca `isCustom` para que el modelo pueda distinguirlas sin una segunda llamada.
- **Combinaciones inválidas**: `customOnly`, `employeeLinkedOnly` y `query` son exclusivas con `entitySet`, y `employeeLinkedOnly` exige `customOnly: true`. En ambos casos se responde `OPTION_INVALID` en vez de ignorar la opción en silencio — misma política que ya aplicaba `inspect_custom_mdf`.

---

## 6. Enmiendas a documentos anteriores

| Documento | Elemento | Enmienda |
|---|---|---|
| `PRD-feature-custom-mdf.md` | **D-66 / FR-70** (herramienta `inspect_custom_mdf`) | Se **deroga**: la herramienta se retira y su funcionalidad pasa a `inspect_entity`. |
| `PRD-feature-custom-mdf.md` | **FR-72** (no crear recurso de detalle paralelo) | **Sin cambios**: se refiere a recursos, y D-81 mantiene esa decisión. |
| `PRD-feature-custom-mdf.md` | **FR-71** (recurso `sf://{env}/mdf/custom`) | **Sin cambios**: el recurso se conserva (D-81). |

---

## 7. Requisitos Funcionales (RFC 2119)

| ID | Requisito |
|---|---|
| **FR-99** (MUST) | El servidor DEBE registrar la herramienta `inspect_entity` con los argumentos `{ environment?, entitySet?, customOnly?, query? }`, estrictos ante claves desconocidas. |
| **FR-100** (MUST) | Sin `entitySet`, DEBE devolver el listado `{ environment, totalCount, entities: [{ name, isCustom }] }`. Con `customOnly: true` DEBE devolver solo Custom MDF y añadir los campos del resumen MDF más `employeeLinkedCount`. Con `query`, DEBE filtrar por subcadena del nombre sin distinguir mayúsculas. **El listado NO DEBE truncarse ni paginarse:** devuelve todas las entidades que pasen el filtro. `query` es la vía para acotarlo. |
| **FR-101** (MUST) | Con `entitySet`, DEBE devolver el mismo contrato de detalle que `sf://{env}/entities/{entitySet}`, incluyendo los aditamentos MDF **solo** cuando la entidad sea Custom MDF. |
| **FR-102** (MUST) | La herramienta `inspect_custom_mdf` DEBE dejar de registrarse. Su nombre NO DEBE aparecer en `tools/list`. |
| **FR-103** (MUST) | La herramienta NO DEBE realizar ninguna petición de red distinta del `$metadata` ya cacheado (D-62/DS-MDF-02). |
| **FR-104** (MUST) | Con `entityAllowlist` configurada, una entidad excluida DEBE responder `ENTITY_NOT_ALLOWED` y NO DEBE aparecer en ningún listado; una entidad inexistente, `RESOURCE_NOT_FOUND`. |
| **FR-105** (SHOULD) | La salida DEBE respetar el tope de tamaño (D-75/FR-86) y, de superarlo, devolver el error saneado que ya existe, indicando cómo acotar con `query` o `entitySet`. |
| **FR-106** (MUST) | La herramienta DEBE aceptar `locale` opcional y resolver la prosa de `guidance` con la misma precedencia que D-70 (`locale` > `defaultLocale` > `SF_DEFAULT_LOCALE` > `"en_US"`), exponiendo el locale efectivo. Sin esto, retirar `inspect_custom_mdf` **perdería la guía multilingüe**. |
| **FR-107** (MUST) | La herramienta DEBE conservar `employeeLinkedOnly`, válido **solo** junto a `customOnly: true`; combinado con `entitySet` o sin `customOnly` DEBE responder `OPTION_INVALID`. Retirar `inspect_custom_mdf` no debe perder la capacidad de filtrar por vínculo con empleado. |

---

## 8. Verificación y Aceptación

| Nivel | Qué | Gate |
|---|---|---|
| **V1 — Tests automáticos** | `tools/list` incluye `inspect_entity` y **no** `inspect_custom_mdf`; el listado marca `isCustom`; `customOnly` devuelve solo MDF con sus campos; `query` filtra; el detalle estándar **no** gana campos MDF; el detalle custom **sí** los gana y coincide con el recurso; allowlist fail-closed | CI / pre-commit |
| **V2 — Paridad con el recurso** | Para la misma entidad, `inspect_entity({entitySet})` y `sf://{env}/entities/{entitySet}` devuelven el **mismo** objeto | CI |
| **V3 — Cero red** | Con caché de metadatos válida, la herramienta no dispara ninguna petición de red | CI |

### Escenarios Gherkin

```gherkin
Scenario: Mismo gesto para estándar y custom (FR-100, FR-101) [V1]
  Given el servidor con metadatos cacheados
  When llamo a inspect_entity con entitySet "User"
  Then la respuesta trae el schema y isCustom es false
  And no trae employeeLink ni guidance
  When llamo a inspect_entity con entitySet "cust_Prendas"
  Then la respuesta trae el schema, isCustom true, employeeLink y guidance

Scenario: Paridad con el recurso de detalle (FR-101) [V2]
  Given una entidad custom cualquiera
  When comparo inspect_entity({entitySet}) con sf://{env}/entities/{entitySet}
  Then los dos payloads son iguales

Scenario: La herramienta vieja ya no existe (FR-102) [V1]
  Given el servidor arrancado
  Then "inspect_custom_mdf" no aparece en tools/list
```

---

## 9. Preguntas abiertas

- **RESUELTA (2026-10-14): `locale` se conserva.** `inspect_entity` acepta `locale` y la prosa de `guidance` mantiene la precedencia de D-70. Retirar una herramienta no debe borrar una decisión ya tomada. Ver FR-106.
- **RESUELTA (2026-10-14): sin `limit`.** El listado devuelve **todas** las entidades (FR-100). Pesa ~33 KB con 658, muy por debajo del tope de 256 KB, y los tres entornos medidos están en el mismo orden (PROD 658, DEV ~665, TEST ~671). Se **descarta** el truncado silencioso, porque convierte un problema de tamaño en uno de corrección. Único disparador de revisión: que un entorno supere ~1.500 entidades.
- **ASSUMPTION**: los clientes objetivo exponen `tools/list` de forma fiable. Es el supuesto que sostiene todo el PRD; si algún cliente no lo hiciera, el hueco seguiría abierto por otra vía.
