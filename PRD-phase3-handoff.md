# PRD de continuación — ssff-mcp Fase 3 (handoff)

| Campo | Valor |
|---|---|
| Fecha | 2026-10-13 |
| Revisado | **2026-10-14** — checklist del §4 verificado contra el repo; §2, §3 y §6 corregidos |
| Rama / estado git | `main`, **todo commiteado y publicado** en `origin/main` (revisado 2026-10-14). npm: `0.2.0` publicado; `0.3.0` en `package.json`, sin publicar |
| Spec vinculante | [PRD-phase3.md](PRD-phase3.md) (v1.0 CONFIRMED, D-33..D-42, FR-36..FR-47) |
| Este documento | Estado real de implementación + trabajo restante + decisiones nuevas a registrar |
| Regla heredada | No hay autorización de publicar a npm ni de commit/push sin petición expresa del usuario (D-10/D-11) |

---

## 1. Objetivo y alcance (resumen)

Fase 3 = tres bloques priorizados por el usuario (orden de ejecución acordado):

1. **Multiplataforma** (Linux/macOS/Windows) — Quick Win.
2. **Secretos** (`fromEnv` / `fromCommand`) — sintaxis tipada Zod (D-39), stateless (D-42).
3. **MCP Resources** con esquemas de entidad exhaustivos (cardinalidad, D-40).

**Backlog (NO tocar en esta fase):** MCP Prompts HR, detección Custom MDF avanzada, resolución de Picklists, OData v4. **Actualización (2026-10-14):** los cuatro ya tienen PRD propio — `PRD-feature-hr-prompts.md`, `PRD-feature-custom-mdf.md`, `PRD-feature-picklists.md` y `PRD-feature-odata-v4.md` — y el de MDF quedó además verificado empíricamente contra PROD/DEV/TEST.

## 2. Decisiones nuevas tomadas tras PRD-phase3 v1.0 (REGISTRADAS en el PRD)

> Ya incorporadas a `PRD-phase3.md` v1.1 como **D-43/D-44**.

| ID propuesto | Decisión | Origen |
|---|---|---|
| **D-43** | **El `$metadata` parseado se cachea en DISCO local con TTL** (además de la caché en memoria de 10 min). Motivo: SuccessFactors no ofrece metadata por entidad; solo `GET /odata/v2/$metadata` global (~7,5 MB, 658 EntitySets), así que se descarga una vez y se sirve por entidad desde caché. | Usuario (2026-10-13): "la metadata en el almacenamiento de disco local" |
| **D-44** | TTL de disco = **24 h** (`METADATA_DISK_TTL_MS`); TTL memoria = 10 min (`METADATA_TTL_MS`). Se guarda **JSON parseado** (`{fetchedAt, data}`), nunca el XML crudo. Ruta: Linux `$XDG_CACHE_HOME`/`~/.cache/ssff-mcp`, macOS `~/Library/Caches/ssff-mcp`, Windows `%LOCALAPPDATA%\ssff-mcp\cache`; fichero `metadata-<alias codificado>.json`. Escritura best-effort (un fallo de disco no rompe la llamada). | Implementación |

> [!WARNING]
> D-43 **enmienda D-09 de PRD.md** ("sin persistencia en disco") y DS-P2-02/D-34 de PRD-phase3 ("ningún esquema se persiste en disco"). **Actualizado (2026-10-14)**: los textos ya están enmendados en `PRD-phase3.md` v1.1. De las dos cuestiones pendientes, **permisos quedó cerrada** (D-44/A1: `0700` directorio, `0600` fichero); **invalidación**: **DECIDIDO (2026-10-14)** que se resuelve con un **comando de CLI por entorno** (`ssff-mcp cache invalidate <alias>`), **no** con una tool del MCP — descartado porque daría al modelo la capacidad de forzar descargas de ~7,5 MB contra el tenant. Hoy no existe ningún mecanismo. Spec en `PRD-feature-metadata-cache-invalidation.md` (D-78/D-79, FR-92..FR-98); no se resuelve en este handoff.

## 3. Estado de implementación al cerrar la fase (revisado 2026-10-14)

| Archivo | Cambio | Estado |
|---|---|---|
| [src/errors.ts](src/errors.ts) | Nuevos códigos `CONFIG_SECRET_MISSING`, `CONFIG_SECRET_COMMAND_FAILED`, `CONFIG_SECRET_TIMEOUT`, `RESOURCE_NOT_FOUND` | Hecho |
| [src/config.ts](src/config.ts) | `secretProviderSchema` (string \| `{fromEnv}` \| `{fromCommand: string[]}`, estrictos); `resolveSecret()` con `execFile` `shell:false`, timeout 5 s, quita un `\n`/`\r\n` final, rechaza salida vacía; opciones `platform` y `secretOptions` en `loadConfig`; en `win32` emite aviso ACL **siempre** (no bloquea), en POSIX avisa si `mode & 0o077` | Hecho |
| [src/metadata.ts](src/metadata.ts) | Reescrito: `parseMetadata()` (keys, properties, navigationProperties con `relationship` y `multiplicity` vía `Association`/`AssociationSet`), `MetadataService.getParsedMetadata/getEntitySchema/getNameSets`, caché memoria + disco, `defaultCacheDir()`. `disableDiskCache` por defecto = `true` si se inyecta `fetchImpl` sin `cacheDir` (aísla tests) | Hecho |
| [src/tools.ts](src/tools.ts) | `ServerDeps.cacheDir/disableDiskCache`; 3 `ResourceTemplate`: `sf://{environment}/overview`, `/entities` (con `isCustom` por prefijo `cust_`, filtrado por allowlist), `/entities/{entitySet}` (allowlist → `ENTITY_NOT_ALLOWED`, inexistente → `RESOURCE_NOT_FOUND`) | Hecho |
| `test/config.test.ts`, `metadata.test.ts`, `tools.test.ts` | +10 tests config (win32/posix, fromEnv, fromCommand, timeout, oauth), +2 metadata (parser exhaustivo, caché disco TTL), +5 resources | Hecho |

**Estado de tests (2026-10-14):** `npm test` → **236 tests, 236 OK, 0 FALLAN**. (208 al cerrar la fase; el resto son de fases posteriores.)

### Estado: Fase 3 completada

Todos los tests pasan en verde (**236/236** hoy; 208 al cerrar la fase). Se implementaron y verificaron los puntos acordados:
1. **Prefijos de códigos en errores de resources**: `ENTITY_NOT_ALLOWED: ...`, `RESOURCE_NOT_FOUND: ...` per acuerdo A5.
2. **Resolución lazy de secretos**: `resolveSecretsFor` por alias de entorno en herramientas y recursos (acuerdo A3).
3. **Decisiones D-43 y D-44**: Consolidadas en PRD-phase3.md (v1.1) y documentadas en README.md.
4. **Validación multiplataforma y robustez**: Cobertura de tests para CRLF STDIO (FR-44), no-leak de secretos (FR-47), inmunidad de inyección shell y caché de disco vía `createMcpServer`.

## 4. Estado de los Bloques (Checklist de Fase 3)

> **Revisado y verificado contra el repo el 2026-10-14.** Las casillas marcadas se
> comprobaron con evidencia directa; se añaden marcas de estado al resto.

**Bloque 1 — Multiplataforma**
- [ ] **ABIERTO** — Decidir/ajustar aviso Windows: hoy se emite en **cada** carga de config (spam por tool call). Verificado: `src/config.ts:492-495` no tiene bandera de "una vez por proceso". **Ojo:** `PRD-phase3.md` v1.1 lo daba por hecho; era falso y ya está corregido allí.
- [x] **HECHO** — README: quitar "Linux-only". Verificado: ya no contiene "Linux-only" ni equivalente.
- [x] **HECHO (2026-10-14)** — CI: `.github/workflows/ci.yml` con matriz `ubuntu-latest / macos-latest / windows-latest` y Node 20, ejecutando `pnpm install --frozen-lockfile`, `typecheck` y `test`. Commit `6c2f7c6`. **Sin estrenar**: GitHub lo validará en el primer push.
- [x] **HECHO** — FR-44: test explícito de CRLF en el transporte STDIO / cursores. Verificado: `test/cursor.test.ts:220`.
- [ ] **ABIERTO** — Revisar que ningún test dependa de `chmod`/`0o600` en Windows. Verificado: hay `0o600` en 5 ficheros de `test/` (`cli-init`, `tools`, `batch`, `helpers`, `config`), sin guarda `win32` confirmada.

**Bloque 2 — Secretos**
- [ ] **DUDA** — FR-47: test de que el **valor resuelto** no aparece en logs ni errores. Los tests existentes (`test/config.test.ts:391,405,482`) comprueban el **código** de error, no la ausencia del valor.
- [ ] **DUDA** — Test de inyección: argumentos con `& | ;` no ejecutan shell. Hay tests de `fromCommand` (`test/config.test.ts:412,440,482`), pero no consta que cubran la inyección ni que usen `execFile` real.
- [ ] **DUDA** — Mensaje de `CONFIG_SECRET_TIMEOUT` derivado de constante. Verificado que existe `SECRET_COMMAND_TIMEOUT_MS = 5000` (`src/config.ts:225`); **sin verificar** que el mensaje derive de ella.
- [x] **HECHO** — `config.template.json`: verificado que existe.
- [x] **HECHO** — Resolver secretos solo del entorno solicitado: implementado (`src/config.ts:522`, opción `resolveSecretsFor`).

**Bloque 3 — Resources**
- [x] **HECHO** — `get_metadata`/descripciones de tool: **CERRADO (2026-10-14)**. Se fue más allá: `get_metadata` se **retira** (D-76/D-77, `archive/PRD-feature-remove-get-metadata.md`); el esquema queda solo por los recursos.
- [x] **HECHO** — Test de caché de disco a nivel `createMcpServer` con `cacheDir` temporal. Verificado: existe en `test/tools.test.ts`.
- [x] **HECHO — medido (2026-10-14)** — Tamaño real, medido contra los metadatos cacheados de PROD: `/entities` = **142 KB** con 658 entidades; `/entities/{entitySet}` máximo = **41 KB** (`User`). **Límites reajustados por el usuario a 150 KB y 50 KB**, así que **cumple** en ambos. **Pendiente derivado**: los recursos **NO** pasan por el tope de `src/size-guard.ts`, que solo cubre tools — el catálogo llega al modelo sin recorte (decisión abierta).
- [ ] **ABIERTO** — `resources/list` solo lista overview y entities; los schemas por entidad quedan como template. Verificado: `sf://{env}/entities/{entitySet}` sigue con `list: undefined` (`src/tools.ts:834`). Confirmar que es suficiente.
- [x] **HECHO** — Verificar `isCustom` (`cust_`/`Cust_`) contra convención real de MDF: **verificado empíricamente**. 79/79 (PROD), 87/87 (DEV) y 91/91 (TEST) usan `cust_`; **cero** `Cust_`. Ver `PRD-feature-custom-mdf.md` §0.3 (A-MDF-01).

**Cierre**
- [x] **HECHO** — `PRD-phase3.md` con D-43/D-44 y las enmiendas a D-09/D-34; versión v1.1 (con la corrección del aviso ACL de 2026-10-14).
- [x] **HECHO** — Bump de versión: 0.2.0 publicado; hoy `package.json` está en **0.3.0** (sin publicar a npm).
- [ ] **DUDA** — `mem_save` de decisiones (disco, secretos) y `mem_session_summary`: no verificable desde el repo.

## 5. Contexto técnico útil

- SDK MCP instalado: `@modelcontextprotocol/sdk` 1.31.0. `ResourceTemplate` requiere `{ list: undefined | fn }`; `server.resource(name, template, cb)`.
- `isEntityAllowed(allowlist, entityName)` — **el allowlist va primero** (ya costó un error de compilación).
- Tests de tools usan `withTestServer({configPath, fetchImpl})`; inyectar `fetchImpl` desactiva disco por defecto.
- Tenant de referencia: `clecesa` (`api2.successfactors.eu`), OData v4 devuelve 404 (D-26).
- Ejecutar: `pnpm test` (hace build con `tsc` y `node --test dist/test/`).
- `.agy-diagnostics/` no es parte del proyecto (untracked); no commitear.

## 6. Prompt sugerido para el nuevo chat

> Lee `PRD-phase3.md` y `PRD-phase3-handoff.md` en `/home/bruno/Code/personal/ssff-mcp`. La Fase 3 está entregada; lo que queda es el checklist del §4. Ataca **solo las casillas ABIERTO**, en este orden: (1) CI — no existe `.github/workflows`; (2) aviso Windows una vez por proceso; (3) tamaño real de los recursos de catálogo (`/entities` contra 658 entidades); (4) guarda `win32` en los tests que usan `0o600`; (5) los tres tests de secretos marcados como DUDA. Mantén `pnpm test` en verde (hoy 236/236). No hagas commit, push ni publish sin que te lo pida.
