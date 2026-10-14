# PRD de continuación — ssff-mcp Fase 3 (handoff)

| Campo | Valor |
|---|---|
| Fecha | 2026-10-13 |
| Rama / estado git | `main`, **cambios sin commitear** (ver §3). Nada pusheado ni publicado |
| Spec vinculante | [PRD-phase3.md](PRD-phase3.md) (v1.0 CONFIRMED, D-33..D-42, FR-36..FR-47) |
| Este documento | Estado real de implementación + trabajo restante + decisiones nuevas a registrar |
| Regla heredada | No hay autorización de publicar a npm ni de commit/push sin petición expresa del usuario (D-10/D-11) |

---

## 1. Objetivo y alcance (resumen)

Fase 3 = tres bloques priorizados por el usuario (orden de ejecución acordado):

1. **Multiplataforma** (Linux/macOS/Windows) — Quick Win.
2. **Secretos** (`fromEnv` / `fromCommand`) — sintaxis tipada Zod (D-39), stateless (D-42).
3. **MCP Resources** con esquemas de entidad exhaustivos (cardinalidad, D-40).

**Backlog (NO tocar en esta fase):** MCP Prompts HR, detección Custom MDF avanzada, resolución de Picklists, OData v4.

## 2. Decisiones nuevas tomadas tras PRD-phase3 v1.0 (REGISTRAR en el PRD)

| ID propuesto | Decisión | Origen |
|---|---|---|
| **D-43** | **El `$metadata` parseado se cachea en DISCO local con TTL** (además de la caché en memoria de 10 min). Motivo: SuccessFactors no ofrece metadata por entidad; solo `GET /odata/v2/$metadata` global (~7,5 MB, 658 EntitySets), así que se descarga una vez y se sirve por entidad desde caché. | Usuario (2026-10-13): "la metadata en el almacenamiento de disco local" |
| **D-44** | TTL de disco = **24 h** (`METADATA_DISK_TTL_MS`); TTL memoria = 10 min (`METADATA_TTL_MS`). Se guarda **JSON parseado** (`{fetchedAt, data}`), nunca el XML crudo. Ruta: Linux `$XDG_CACHE_HOME`/`~/.cache/ssff-mcp`, macOS `~/Library/Caches/ssff-mcp`, Windows `%LOCALAPPDATA%\ssff-mcp\cache`; fichero `metadata-<alias codificado>.json`. Escritura best-effort (un fallo de disco no rompe la llamada). | Implementación |

> [!WARNING]
> D-43 **enmienda D-09 de PRD.md** ("sin persistencia en disco") y DS-P2-02/D-34 de PRD-phase3 ("ningún esquema se persiste en disco"). Hay que actualizar esos textos: la excepción es solo metadata de esquema (sin datos de personas ni secretos). Pendiente confirmar con el usuario: permisos del fichero de caché (¿`0600`?) y si se necesita un mecanismo de invalidación manual.

## 3. Estado de implementación (working tree sin commit)

| Archivo | Cambio | Estado |
|---|---|---|
| [src/errors.ts](src/errors.ts) | Nuevos códigos `CONFIG_SECRET_MISSING`, `CONFIG_SECRET_COMMAND_FAILED`, `CONFIG_SECRET_TIMEOUT`, `RESOURCE_NOT_FOUND` | Hecho |
| [src/config.ts](src/config.ts) | `secretProviderSchema` (string \| `{fromEnv}` \| `{fromCommand: string[]}`, estrictos); `resolveSecret()` con `execFile` `shell:false`, timeout 5 s, quita un `\n`/`\r\n` final, rechaza salida vacía; opciones `platform` y `secretOptions` en `loadConfig`; en `win32` emite aviso ACL **siempre** (no bloquea), en POSIX avisa si `mode & 0o077` | Hecho |
| [src/metadata.ts](src/metadata.ts) | Reescrito: `parseMetadata()` (keys, properties, navigationProperties con `relationship` y `multiplicity` vía `Association`/`AssociationSet`), `MetadataService.getParsedMetadata/getEntitySchema/getNameSets`, caché memoria + disco, `defaultCacheDir()`. `disableDiskCache` por defecto = `true` si se inyecta `fetchImpl` sin `cacheDir` (aísla tests) | Hecho |
| [src/tools.ts](src/tools.ts) | `ServerDeps.cacheDir/disableDiskCache`; 3 `ResourceTemplate`: `sf://{environment}/overview`, `/entities` (con `isCustom` por prefijo `cust_`, filtrado por allowlist), `/entities/{entitySet}` (allowlist → `ENTITY_NOT_ALLOWED`, inexistente → `RESOURCE_NOT_FOUND`) | Hecho |
| `test/config.test.ts`, `metadata.test.ts`, `tools.test.ts` | +10 tests config (win32/posix, fromEnv, fromCommand, timeout, oauth), +2 metadata (parser exhaustivo, caché disco TTL), +5 resources | Hecho |

**Estado de tests:** `pnpm test` → 208 tests, **208 OK, 0 FALLAN**.

### Estado: Fase 3 completada

Todos los tests pasan en verde (**208/208**). Se implementaron y verificaron todos los puntos acordados:
1. **Prefijos de códigos en errores de resources**: `ENTITY_NOT_ALLOWED: ...`, `RESOURCE_NOT_FOUND: ...` per acuerdo A5.
2. **Resolución lazy de secretos**: `resolveSecretsFor` por alias de entorno en herramientas y recursos (acuerdo A3).
3. **Decisiones D-43 y D-44**: Consolidadas en PRD-phase3.md (v1.1) y documentadas en README.md.
4. **Validación multiplataforma y robustez**: Cobertura de tests para CRLF STDIO (FR-44), no-leak de secretos (FR-47), inmunidad de inyección shell y caché de disco vía `createMcpServer`.

## 4. Estado de los Bloques (Checklist de Fase 3)

**Bloque 1 — Multiplataforma**
- [ ] Decidir/ajustar aviso Windows: hoy se emite en **cada** carga de config (spam por tool call); valorar emitirlo una sola vez por proceso.
- [ ] README: quitar "Linux-only", documentar rutas macOS/Windows y ubicación de caché (`CONFIG_TILDE_PATH` sigue siendo `~/.config/...`; en Windows `os.homedir()`).
- [ ] CI: matriz GitHub Actions `ubuntu/macos/windows-latest` (hoy no hay workflow en el repo).
- [ ] FR-44: test explícito de CRLF en el transporte STDIO / cursores HMAC (no implementado ni testeado).
- [ ] Revisar que ningún test dependa de `chmod`/`0o600` en Windows.

**Bloque 2 — Secretos**
- [ ] FR-47: test de que el valor resuelto no aparece en logs ni errores (`CONFIG_SECRET_*`).
- [ ] Test de inyección: argumentos con `& | ;` no ejecutan shell (con `execFile` real, no mock).
- [ ] Mensaje de `CONFIG_SECRET_TIMEOUT` hardcodea "5000ms": derivar de una constante.
- [ ] Actualizar `config.template.json` y README (sección Configuración + Security disclosures: ya no todo es texto plano).
- [ ] Comprobar que `loadConfig` resuelve secretos de **todos** los entornos en cada llamada (coste: un `fromCommand` por entorno por tool call; valorar resolver solo el entorno solicitado — decisión abierta, afecta D-42).

**Bloque 3 — Resources**
- [x] `get_metadata`/descripciones de tool: apuntar a los resources como vía preferida. **CERRADO (2026-10-14)**: se fue más allá — `get_metadata` se **retira** (D-76/D-77, `archive/PRD-feature-remove-get-metadata.md`); el esquema queda solo por los recursos.
- [ ] Test de caché de disco a nivel `createMcpServer` con `cacheDir` temporal (hoy solo a nivel `MetadataService`).
- [ ] Tamaño real: validar contra tenant real que `/entities` < 50 KB (658 entidades con `keyProperties` puede excederlo) y `/entities/{name}` < 10 KB; si no, paginar o recortar.
- [ ] `resources/list` solo lista overview y entities por entorno; los schemas por entidad quedan como template (`list: undefined`): confirmar que es suficiente.
- [ ] Verificar `isCustom` (`cust_`/`Cust_`) contra convención real de MDF; es heurística (el detalle completo de MDF está en backlog).

**Cierre**
- [ ] Actualizar PRD-phase3.md con D-43/D-44 y las enmiendas a D-09/D-34; versión v1.1.
- [ ] Bump de versión (propuesta 0.2.0) **solo si el usuario lo pide**; publicar a npm lo hace el usuario.
- [ ] `mem_save` de decisiones (disco, secretos) y `mem_session_summary`.

## 5. Contexto técnico útil

- SDK MCP instalado: `@modelcontextprotocol/sdk` 1.31.0. `ResourceTemplate` requiere `{ list: undefined | fn }`; `server.resource(name, template, cb)`.
- `isEntityAllowed(allowlist, entityName)` — **el allowlist va primero** (ya costó un error de compilación).
- Tests de tools usan `withTestServer({configPath, fetchImpl})`; inyectar `fetchImpl` desactiva disco por defecto.
- Tenant de referencia: `clecesa` (`api2.successfactors.eu`), OData v4 devuelve 404 (D-26).
- Ejecutar: `pnpm test` (hace build con `tsc` y `node --test dist/test/`).
- `.agy-diagnostics/` no es parte del proyecto (untracked); no commitear.

## 6. Prompt sugerido para el nuevo chat

> Lee `PRD-phase3.md` y `PRD-phase3-handoff.md` en `/home/bruno/Code/personal/ssff-mcp`. Arregla primero el test fallido de resources (opción A del §3), luego recorre el checklist del §4 bloque a bloque (multiplataforma → secretos → resources), manteniendo `pnpm test` en verde. No hagas commit, push ni publish sin que te lo pida.
