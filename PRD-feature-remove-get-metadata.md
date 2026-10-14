# PRD — ssff-mcp Feature: Retirada de la tool `get_metadata`

| Metadato | Valor |
|---|---|
| **Documento** | PRD-feature-remove-get-metadata.md |
| **Versión** | v0.1 |
| **Estado** | BORRADOR (DRAFT) — pendiente de aprobación; no autoriza implementación |
| **Fecha** | 2026-10-14 |
| **Motivo** | `get_metadata` devuelve el `$metadata` XML crudo (~7,5 MB) al LLM y además **se salta la caché** de metadatos (D-43/D-44). Es el mayor footgun de contexto del servidor y su valor real para un modelo es nulo. |
| **Alineación previa** | `PRD.md` (D-01..D-25), `PRD-phase2.md` (D-26..D-32), `PRD-phase3.md` (D-33..D-44), `PRD-phase4.md` (D-45..D-52), `PRD-feature-picklists.md` (D-53..D-61), `PRD-feature-custom-mdf.md` (D-62..D-70, D-75), `PRD-feature-odata-query-fidelity.md` (D-71..D-74). Este documento arranca en **D-76 / FR-87**. |
| **Naturaleza del cambio** | **RUPTURISTA**: elimina una tool pública existente. Requiere bump de versión y nota de ruptura. |

---

## 1. Resumen Ejecutivo

Se retira la tool `get_metadata` del set expuesto por el MCP. La capacidad de consultar el esquema **no se pierde**: sigue disponible por los recursos `sf://{env}/entities` y `sf://{env}/entities/{entitySet}`, que además respetan la caché de D-43/D-44 y devuelven JSON compacto y filtrable por allowlist. La motivación no es ahorrar código, sino que **el modelo no pueda gastar su ventana de contexto en un documento que no sabe leer**.

---

## 2. Contexto y Problema (evidencia en el propio repositorio)

`get_metadata` acumula dos defectos que ningún otro camino del servidor tiene:

| # | Defecto | Evidencia |
|---|---|---|
| 1 | **Devuelve el XML crudo al LLM.** ~7,5 MB que ningún modelo puede consumir de forma útil; lo que importa del esquema ya se parsea y se expone por entidad. | `src/tools.ts:369-390` (`text: result.body`) |
| 2 | **Se salta la caché de metadatos.** Es el único camino que fuerza una descarga fresca cada vez, ignorando la caché en memoria (10 min) y en disco (24 h) de D-43/D-44. | `src/tools.ts:379` — *"Always fresh from the source; the metadata cache is never used here."*; `src/metadata.ts:9` |

**El propio proyecto ya lo había detectado** y quedó sin cerrar:

- `PRD-phase3.md:59` — *"Si el modelo invoca `get_metadata`, agota la ventana de contexto de los LLMs actuales…"*.
- `PRD-phase3-handoff.md:70` — pendiente sin marcar: *"`get_metadata`/descripciones de tool: apuntar a los resources como vía preferida"*.

**Por qué no basta con desaconsejarla.** Su descripción ya advierte que es enorme y ya pide preferir `query_entity`. El historial demuestra que eso no impide que un modelo la invoque. Mientras la tool exista en la lista, es alcanzable; la única garantía real es que no exista.

**Alternativa descartada: gatearla por configuración.** Mantenerla oculta tras una variable de entorno conserva la válvula de escape para un desarrollador humano, pero el modelo seguiría viendo una tool que, al llamarla, devuelve un error. Eso gasta turnos y contamina la conversación sin aportar nada al caso de uso real.

---

## 3. Objetivos y No-Objetivos

### Objetivos

1. Que el modelo **no pueda** gastar contexto en el XML crudo de esquema.
2. Que **todo** acceso a metadatos del servidor pase por la caché de D-43/D-44 (hoy hay una excepción: esta tool).
3. Mantener completa la capacidad de descubrir el esquema, por la vía de recursos ya existente.

### No-Objetivos

* **MUST NOT** perder capacidad funcional de consulta: el esquema sigue accesible por recursos.
* **MUST NOT** alterar `query_entity`, `batch_get`, `list_environments` ni la allowlist.
* **MUST NOT** introducir un sustituto que devuelva el EDMX crudo por otra puerta (recurso, tool con otro nombre o parámetro oculto). Sería reintroducir el problema con otro envoltorio.
* Fuera de alcance: exponer anotaciones EDMX que `parseMetadata` no extrae hoy. Si hacen falta, se **parsean y se exponen por entidad** (como planea `PRD-feature-picklists.md` con `sap:picklist`), nunca volcando el XML.

---

## 4. Enmiendas a documentos anteriores

Este cambio **contradice un requisito vigente**, y hay que enmendarlo explícitamente en lugar de dejar el corpus incoherente.

| Documento | Elemento | Estado actual | Enmienda |
|---|---|---|---|
| `PRD.md` | **FR-04** | *"El servidor DEBE exponer una herramienta `get_metadata` que recupere el `$metadata`…"* (`PRD.md:469`) | Se **deroga**. FR-04 queda reemplazado por FR-88 de este documento. |
| `PRD.md` | **A-1** (`PRD.md:527`) | Los nombres `get_metadata` y `query_entity` son propuesta, no decisión confirmada | Queda resuelto: `get_metadata` **no** se implementa; `query_entity` se mantiene. |
| `README.md` | §`get_metadata` (`README.md:207`), allowlist (`:113`), resumen (`:272`) | Documenta la tool y su comportamiento | Se retira la sección y las referencias. |
| `PRD-phase3-handoff.md:70` | Pendiente | Sin marcar | Se **cierra** con este documento. |
| `PRD.md` | **FR-28 / D-15** | *"`$metadata` nunca se filtra por la allowlist"* — la regla que eximía a `get_metadata` | Queda **vacua**: al retirar la tool, **todo** acceso a metadatos visible al LLM pasa por recursos que sí aplican allowlist. Se anota la obsolescencia; **no** se reutiliza para eximir nada más. Efecto: refuerza el fail-closed (desaparece el último camino sin filtrar). El test `test/tools.test.ts:800` se elimina con ella. |

---

## 5. Decisiones

| ID | Decisión | Justificación |
|---|---|---|
| **D-76** | **Retirada de la tool `get_metadata`**: deja de registrarse. La consulta de esquema queda cubierta exclusivamente por los recursos `sf://{env}/entities` y `sf://{env}/entities/{entitySet}`, que usan la caché y aplican allowlist. Rechazadas: dejarla con aviso (el modelo la invoca igual) y gatearla por configuración (el modelo la ve y recibe errores, gastando turnos). | XML crudo sin valor para el LLM + bypass de caché, ambos medidos y documentados (`src/tools.ts:379`; `PRD-phase3.md:59`). El esquema útil ya está expuesto por entidad. |
| **D-77** | **Enmienda de FR-04 de `PRD.md`**: se deroga y se sustituye por FR-88. El ledger no se reescribe: se registra la derogación para que un lector futuro no vea dos requisitos contradictorios. | Coherencia del corpus; el proyecto ya usa esta convención de enmienda (p. ej. `PRD-phase3.md` enmienda D-09/D-34). |

---

## 6. Requisitos Funcionales (RFC 2119)

| ID | Requisito |
|---|---|
| **FR-87** (MUST) | El servidor **NO DEBE** registrar la tool `get_metadata`. Su nombre no DEBE aparecer en `tools/list`. |
| **FR-88** (MUST) | El esquema DEBE seguir siendo accesible por los recursos `sf://{env}/entities` y `sf://{env}/entities/{entitySet}`, leyendo de la caché de D-43/D-44 y **sin** provocar una descarga fresca cuando la caché es válida. La allowlist DEBE seguir aplicándose como hoy (`src/tools.ts:839-841`, `:879-884`). |
| **FR-89** (MUST) | Los tests de `get_metadata` (`test/tools.test.ts:70`, `:800`; `test/inline-tools.test.ts:65`) DEBEN eliminarse y sustituirse por un test que verifique que la tool **no** está registrada y que `tools/list` no la incluye. |
| **FR-90** (MUST) | La documentación DEBE actualizarse: se retira la sección del README, se anota la derogación de FR-04 en `PRD.md` y se marca como cerrado el pendiente de `PRD-phase3-handoff.md:70`. |
| **FR-91** (SHOULD) | El cambio DEBE acompañarse de un bump de versión **rupturista** (0.2.0 → 0.3.0) y una nota de changelog que diga explícitamente que la tool se retiró y cuál es la vía sustituta. |

---

## 7. Impacto y consumidores verificados

| Consumidor | Uso de `get_metadata` | Acción |
|---|---|---|
| Skill `clece-sf-search-employees` | **No la usa** (solo `ssff_query_entity` y `ssff_batch_get`, `SKILL.md:9,31,63,108`) | Ninguna |
| `test/tools.test.ts`, `test/inline-tools.test.ts` | 3 tests | Adaptar (FR-89) |
| `README.md` | Sección propia + 2 referencias | Retirar (FR-90) |
| `PRD.md` | FR-04 la define | Enmendar (D-77) |
| `src/metadata.ts:9` | Comentario que la menciona | Actualizar |

**Conclusión de impacto**: no hay consumidor externo conocido que la invoque. La retirada es segura y contenida.

---

## 8. Verificación y Aceptación

| Nivel | Qué | Gate |
|---|---|---|
| **V1 — Tests automáticos** | `tools/list` no incluye `get_metadata`; una llamada a la tool devuelve "tool desconocida"; los recursos de esquema siguen verdes; la allowlist sigue fail-closed en los recursos | CI / pre-commit |
| **V2 — No-regresión de caché** | Con caché de metadatos válida, leer los recursos **no** dispara ninguna petición de red (verificable con un `fetchImpl` instrumentado) | CI |
| **V3 — Humo de uso real** | Ejecutar la skill `clece-sf-search-employees` L1→L3: debe seguir funcionando sin tocar `get_metadata` | Por release |

### Escenarios Gherkin

```gherkin
Scenario: La tool ya no está disponible (FR-87, FR-89) [V1]
  Given el servidor arrancado
  When pido la lista de tools
  Then "get_metadata" no aparece
  And una llamada a "get_metadata" falla con tool desconocida

Scenario: El esquema sigue accesible sin red (FR-88) [V1+V2]
  Given la caché de metadatos válida para el alias
  When leo la lista de tools
  Then "get_metadata" no aparece
  And leer "sf://{env}/entities" devuelve el catálogo sin ninguna petición de red

Scenario: La allowlist sigue fail-closed en los recursos (FR-88) [V1]
  Given una allowlist que excluye la entidad X
  When leo "sf://{env}/entities/X"
  Then la respuesta es ENTITY_NOT_ALLOWED
```

---

## 9. Preguntas abiertas

- **OPEN QUESTION**: ¿bump a **0.3.0** (rupturista en semver 0.x) o directo a **1.0.0**? Recomendación por defecto: 0.3.0.
- **ASSUMPTION**: ningún consumidor externo publicado invoca `get_metadata`. Verificado solo contra la skill local y el propio repositorio; no hay telemetría de uso del paquete npm.
