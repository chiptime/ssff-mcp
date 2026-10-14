# PRD — ssff-mcp Feature: Invalidación de la caché de metadatos por entorno

| Metadato | Valor |
|---|---|
| **Documento** | PRD-feature-metadata-cache-invalidation.md |
| **Versión** | v0.1 |
| **Estado** | BORRADOR (DRAFT) — pendiente de aprobación; no autoriza implementación |
| **Fecha** | 2026-10-14 |
| **Motivo** | Hoy no existe **ninguna** forma de invalidar la caché de `$metadata`: solo el TTL (10 min en memoria, 24 h en disco). Cuando el esquema del tenant cambia, no hay manera de forzar la recarga sin esperar. |
| **Alineación previa** | `PRD.md` (D-01..D-25), `PRD-phase2.md` (D-26..D-32), `PRD-phase3.md` (D-33..D-44), `PRD-phase4.md` (D-45..D-52), `PRD-feature-picklists.md` (D-53..D-61), `PRD-feature-custom-mdf.md` (D-62..D-70, D-75), `PRD-feature-odata-query-fidelity.md` (D-71..D-74), `archive/PRD-feature-remove-get-metadata.md` (D-76..D-77). Este documento arranca en **D-78 / FR-92**. |
| **Naturaleza del cambio** | Solo toca caché **local**. No añade superficie al MCP ni amplía el alcance contra SuccessFactors. |

---

## 1. Resumen Ejecutivo

Se añade un **comando de CLI** —`ssff-mcp cache invalidate <alias>`— que borra la caché de metadatos del entorno indicado. No se expone como tool del MCP a propósito: quien decide que el esquema cambió es una persona, y una tool le daría al modelo la capacidad de forzar descargas de ~7,5 MB contra el tenant.

El detalle que decide el diseño es que **el proceso de CLI no puede hablar con el servidor en marcha**. La caché tiene dos niveles (memoria 10 min + disco 24 h) y la de memoria vive dentro del proceso del servidor. Borrar el fichero de disco, por sí solo, no tendría efecto visible: el servidor seguiría sirviendo desde memoria hasta 10 minutos, y el comando parecería roto. Por eso el servidor valida su entrada de memoria contra el fichero de disco antes de fiarse de ella.

---

## 2. Contexto y Problema (evidencia en el repositorio)

| Hecho | Evidencia |
|---|---|
| **No existe ninguna invalidación.** Ni API, ni método `clear`/`invalidate` sobre la caché de metadatos. | Búsqueda sobre `src/` y `src/cli/`: sin coincidencias |
| **Dos niveles de caché con TTL distintos**, y la memoria es *por proceso*. | `src/metadata.ts:20-21` (`METADATA_TTL_MS` 10 min, `METADATA_DISK_TTL_MS` 24 h); `src/metadata.ts:331-332` |
| **La caché en memoria es un `Map` del propio `MetadataService`.** | `src/metadata.ts:319-333`, `this.cache` |
| **El fichero de disco es `metadata-<alias codificado>.json`.** | `src/metadata.ts:373`, `:409` |
| **El CLI corre en otro proceso** y solo despacha `init` / `help` / arranque del servidor. | `src/index.ts:29-40`, `src/cli/` (`init.ts`, `discovery.ts`, `clients.ts`) |
| **Ya existe un precedente de invalidación por alias.** | `invalidateOAuthToken(alias)` — `src/oauth.ts:72` |

**Consecuencia:** sin resolución, un comando que solo borre el disco deja al usuario con datos viejos hasta 10 minutos después de "invalidar". Ese es el fallo de diseño que este PRD evita.

---

## 3. Objetivos y No-Objetivos

### Objetivos

1. Que una persona pueda **forzar la recarga de metadatos de un entorno** sin esperar al TTL.
2. Que el efecto sea **observable de inmediato** en el servidor en marcha, no en 10 minutos.
3. Que la capacidad **no quede al alcance del modelo**.

### No-Objetivos

* **MUST NOT** exponer ninguna tool ni recurso MCP para invalidar. La decisión D-78 lo fija.
* **MUST NOT** devolver el XML de `$metadata` ni el JSON parseado: invalida y ya. Devolver el documento sería reintroducir `get_metadata` bajo otro nombre (D-76).
* **MUST NOT** provocar la descarga por sí mismo: el comando borra; **el siguiente read repuebla**.
* **MUST NOT** tocar SuccessFactors. La operación es exclusivamente sobre caché local (frontera de solo-lectura intacta).
* Fuera de alcance: invalidar la caché de OAuth (ya tiene su propio `invalidateOAuthToken`) y cualquier caché de pickslists, que aún no existe.

---

## 4. Decisiones

| ID | Decisión | Justificación |
|---|---|---|
| **D-78** | **La invalidación se hace por comando de CLI (`ssff-mcp cache invalidate <alias>`), nunca por tool del MCP.** | Quien sabe que el esquema cambió es una persona. Exponerlo al modelo le daría la capacidad de disparar descargas de ~7,5 MB contra el tenant, y volvería a ensuciar la superficie del MCP que acabamos de reducir al retirar `get_metadata` (D-76). |
| **D-79** | **El servidor valida su entrada de memoria contra el fichero de disco (existencia y mtime) antes de servirla.** Si no coincide, la descarta y recarga. | El CLI corre en otro proceso y no puede señalar al servidor. Sin esta validación el comando no tendría efecto visible hasta que expirase el TTL de memoria (10 min). Coste aceptado: un `stat` por lectura de metadatos, y solo cuando ya hay entrada en memoria. |

---

## 5. Requisitos Funcionales (RFC 2119)

| ID | Requisito |
|---|---|
| **FR-92** (MUST) | El CLI DEBE exponer `ssff-mcp cache invalidate <alias>`, que elimina `metadata-<encodeURIComponent(alias)>.json` del directorio de caché activo (`defaultCacheDir()`, o el configurado). |
| **FR-93** (MUST) | El comando DEBE aceptar `--all` para invalidar todos los entornos configurados en una sola invocación. |
| **FR-94** (MUST) | Con un alias **no configurado**, el comando DEBE fallar (fail-closed) **sin borrar nada**, con un mensaje saneado y salida distinta de cero. Con un alias configurado sin fichero en disco, DEBE informarlo y salir **0** (idempotente). |
| **FR-95** (MUST) | `MetadataService` DEBE comprobar, antes de servir una entrada de memoria, que el fichero de disco asociado sigue existiendo y con el mismo `mtime` registrado al poblarla. Si no coincide, DEBE descartar la entrada y recargar. La comprobación DEBE omitirse cuando la caché de disco está desactivada (`disableDiskCache`). |
| **FR-96** (MUST) | La salida del comando DEBE indicar, por alias: el alias, si existía fichero y la ruta del directorio de caché. NO DEBE exponer secretos, ni el contenido de la configuración, ni la URL del tenant. |
| **FR-97** (MUST) | El comando NO DEBE desencadenar ninguna petición de red. La recarga ocurre en el siguiente read del servidor. |
| **FR-98** (SHOULD) | Códigos de salida: `0` éxito, `2` error de uso (alias desconocido, argumentos inválidos). |

---

## 6. Diseño Técnico

### 6.1 `src/index.ts` — despacho de comandos

Ampliar `parseCliArgs` para reconocer `cache invalidate`. Mantener el contrato actual: sin argumentos se arranca el servidor MCP; `init` y `help` no cambian. El texto de `--help` DEBE incorporar el comando nuevo.

### 6.2 `src/cli/cache.ts` (nuevo)

- Resuelve los alias a invalidar desde la configuración (mismo `loadConfig` que el resto del CLI, **sin** resolver secretos: no hacen falta).
- Elimina el fichero por alias, siguiendo el patrón ya existente en `oauth.ts:72` para la invalidación por alias.
- **No** instancia `MetadataService`: no necesita red y no debe abrir conexiones.

### 6.3 `src/metadata.ts` — validación de la entrada en memoria

`CacheEntry` pasa a registrar el `mtime` del fichero de disco con el que se pobló. En `getParsedMetadata`, **cuando ya hay entrada en memoria**, se comprueba primero:

1. Si `disableDiskCache` está activo → servir memoria sin más (comportamiento actual; los tests con `fetchImpl` inyectado no se ven afectados).
2. Si no → `stat` del fichero. Si no existe, o su `mtime` difiere del registrado, descartar la entrada de memoria y continuar por el camino normal (memoria vacía → disco → red).

> **Nota de diseño**: se elige `mtime` y no solo la existencia porque un fichero **reemplazado** (no borrado) debe invalidar igual. La comprobación solo corre cuando hay entrada en memoria, así que en el peor caso añade un `stat` por lectura de metadatos.

---

## 7. Verificación y Aceptación

| Nivel | Qué | Gate |
|---|---|---|
| **V1 — Tests automáticos** | El comando borra el fichero del alias pedido y no toca los demás; alias desconocido → falla sin borrar; alias sin fichero → sale 0; `--all` borra todos; el comando no realiza ninguna petición de red | CI / pre-commit |
| **V2 — Test del efecto real** | Con una entrada en memoria poblada, borrar el fichero del disco **fuera del proceso** y comprobar que la siguiente lectura **no** sirve la entrada vieja y recarga | CI |
| **V3 — Humo manual** | Invalidar un alias con el servidor en marcha, pedir el esquema y comprobar que refleja un cambio del tenant sin reiniciar | Manual, por release |

### Escenarios Gherkin

```gherkin
Scenario: Invalidar un entorno concreto (FR-92, FR-96) [V1]
  Given una caché de disco con fichero para "prod" y para "dev"
  When ejecuto "ssff-mcp cache invalidate prod"
  Then el fichero de "prod" ya no existe
  And el fichero de "dev" sigue intacto
  And la salida nombra "prod" y si existía fichero
  And no se ha hecho ninguna petición de red

Scenario: Alias no configurado no borra nada (FR-94) [V1]
  Given una caché de disco con fichero para "prod"
  When ejecuto "ssff-mcp cache invalidate nope"
  Then la salida es distinta de cero
  And el fichero de "prod" sigue intacto

Scenario: El servidor en marcha deja de servir la entrada vieja (FR-95) [V2]
  Given el servidor ha leído metadatos de "prod" y tiene la entrada en memoria
  When el fichero de disco de "prod" se elimina fuera del proceso
  And pido los metadatos otra vez
  Then la respuesta no procede de la entrada de memoria anterior
  And se ha recargado desde el origen

Scenario: La caché de disco desactivada no se valida (FR-95) [V1]
  Given un MetadataService con disableDiskCache activo
  When leo metadatos dos veces
  Then la segunda lectura se sirve de memoria como antes
  And no se comprueba ningún fichero
```

---

## 8. Preguntas abiertas y supuestos

- **OPEN QUESTION**: ¿el comando debe invalidar también la caché en memoria **del propio proceso** cuando se invoca en el mismo proceso que el servidor? En uso normal no aplica (son procesos distintos), pero conviene decidirlo por claridad.
- **OPEN QUESTION**: ¿conviene un `ssff-mcp cache list` que muestre qué entornos tienen caché y su antigüedad? Útil, pero amplía el alcance; se puede posponer.
- **ASSUMPTION**: el host MCP arranca el servidor como proceso hijo por sesión, de modo que no hay un servidor de larga vida que "se pierda" la invalidación durante horas. Si hubiera un servidor de larga duración, la ventana de la validación por `mtime` seguiría siendo correcta, pero conviene confirmarlo.
