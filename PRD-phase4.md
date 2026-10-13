# PRD — ssff-mcp Fase 4: Experiencia de Usuario, Onboarding y Configuración Asistida

| Campo | Valor |
|---|---|
| Estado | **CONFIRMED v1.1** — Open Questions (Q-P4-x) y supuestos (A-P4-x) cerrados; implementación aún no autorizada |
| Fecha | 2026-10-13 |
| Fuente de decisiones | Petición del usuario (2026-10-13): simplificación radical de instalación, modo inline en el agente, wizard CLI con descubrimiento en vivo de metadatos OData y generador para Codex, Pi, OpenCode, Claude Desktop y Cursor |
| Idioma | Español neutro profesional; identificadores y términos de código en inglés |
| Relación con PRD anteriores | **Extiende** PRD.md (MVP), PRD-phase2.md (Fase 2) y PRD-phase3.md (Fase 3), incorporando FR-48..FR-55 y decisiones D-45..D-48 |
| Cierre (v1.1) | 2026-10-13 — Q-P4-1..Q-P4-10 cerradas (§6), A-P4-1..A-P4-7 verificadas o corregidas (§7), decisiones D-49..D-52 ratificadas y matriz real de clientes (§6.1) |

---

## 0. Registro de Decisiones (Ledger)

| ID | Decisión | Origen / Justificación |
|---|---|---|
| **D-45** | **Soporte de configuración Inline vía variables de entorno en el cliente MCP**: Si `~/.config/ssff-mcp/config.json` no existe, el servidor puede auto-configurarse a partir de variables de entorno estándar (`SF_BASE_URL`, `SF_USERNAME`, `SF_PASSWORD`, `SF_ENVIRONMENT`, etc.) inyectadas directamente en el bloque del agente (OpenCode, Claude, Cursor, Codex, Pi). | Reducción de fricción: onboarding en 1 solo paso sin tocar archivos en disco. |
| **D-46** | **CLI Wizard interactivo (`ssff-mcp init`)**: Binario ejecutable con submando `init` que guía paso a paso al usuario en terminal, valida datos, crea `config.json` con permisos restrictivos (`0600`/ACL) y muestra el bloque para copiar y pegar en su cliente MCP. | Eliminar edición manual de JSON y errores de sintaxis. |
| **D-47** | **Descubrimiento en vivo de entidades con búsqueda interactiva**: Durante el wizard de configuración de la `entityAllowlist`, el CLI se conecta a SuccessFactors usando las credenciales introducidas, descarga `$metadata`, valida la conexión y ofrece un buscador multiselección en tiempo real entre las ~650+ entidades disponibles. | Evita que el usuario tenga que adivinar o buscar los nombres exactos en la documentación de SAP; además precalienta la caché de disco. |
| **D-48** | **Generador multicliente MCP**: El wizard añade un selector de clientes para formatear el bloque JSON listo para copiar: **Codex**, **Pi**, **OpenCode**, **Claude Desktop**, y **Cursor**. | Compatibilidad directa con los asistentes de IA más populares. |

### 0.1 Decisiones de cierre (v1.1)

| ID | Decisión | Origen / Justificación |
|---|---|---|
| **D-49** | **Alcance del modo inline (enmienda acotada a D-02/FR-02)**: la selección implícita de entorno de FR-49 aplica **exclusivamente** al modo inline (sin `config.json`), donde el servidor sintetiza un único entorno. Con `config.json` presente, D-02/FR-02 se mantienen intactos: un `environment` ausente sigue devolviendo `ENVIRONMENT_REQUIRED`. | Cierra Q-P4-1. Preserva la decisión D-02 del usuario y la no regresión: los tests `test/tools.test.ts:145,156` usan un `config.json`, luego no se ven afectados y los 208 tests siguen verdes. |
| **D-50** | **Secretos en bloques inline: referencia o texto libre**: el generador admite **ambas** formas. La **referencia** (`env_vars` en Codex, `{env:VAR}` en OpenCode v2, `${VAR}` en Pi) es la opción por defecto; el **texto libre** (valor literal incrustado en `env`/`environment`/tabla `env`) es una opción explícita que muestra un aviso de que el secreto quedará en claro en el archivo del cliente. | Ratificado por el usuario (2026-10-13, cierre Q-P4-7). Mitiga A-P4-4 sin prohibir el copia-y-pega rápido. |
| **D-51** | **Robustez del wizard `init`**: una única dependencia `@clack/prompts`; sin TTY ⇒ error y salida 2 sin tocar disco; Ctrl+C ⇒ salida limpia sin escribir; sobrescritura de `config.json` con confirmación y backup `.bak`; escritura atómica (temporal + `rename`) aplicando `0600` antes de mover. | Ratificado por el usuario (2026-10-13, cierre Q-P4-8). Elimina la ventana TOCTOU y la pérdida de la configuración previa. |
| **D-52** | **Semántica de allowlist declinada en el wizard**: si el usuario rechaza restringir, se **omite** la clave `entityAllowlist` (sin restricción); nunca se escribe `[]`, que es deny-all. | Ratificado por el usuario (2026-10-13, cierre Q-P4-9). Coincide con el esquema vigente (`src/config.ts`). |

---

## 1. Contexto y Problema

Hasta la Fase 3, la configuración de `ssff-mcp` dependía exclusivamente de un archivo local en disco (`~/.config/ssff-mcp/config.json`). Aunque esto ofrece un aislamiento empresarial excelente y soporte multi-tenant con gestores de secretos (`fromCommand`), introdujo una barrera de entrada importante:
1. **Fricción de onboarding**: El usuario debía crear carpetas manuales, copiar plantillas, usar `chmod 600` en Mac/Linux o ACLs en Windows y editar JSON a mano.
2. **Dificultad para configurar la Allowlist**: Para limitar qué entidades puede leer el LLM, el usuario debía saberse de memoria nombres exactos de SAP como `PerPersonal`, `EmpJob`, o `cust_CustomTable`.
3. **Desalineación con el estándar MCP de agentes**: La mayoría de MCPs comunitarios se instalan en 30 segundos pegando 5 líneas en el archivo de configuración del propio cliente (OpenCode, Claude Desktop, Cursor, etc.).

La Fase 4 resuelve esta brecha ofreciendo **Dual-Mode** (Inline sin archivos o Asistido interactivo), sin sacrificar la seguridad existente.

---

## 2. Los 3 Niveles de Configuración (Arquitectura UX)

El servidor resuelve la configuración en este orden de precedencia:

1. **Nivel 3 (Prioridad Alta): Archivo local `config.json`**:
   - Si `~/.config/ssff-mcp/config.json` existe, se utiliza de forma prioritaria (soporta multi-tenant, `fromCommand`, certificados OAuth, allowlists complejas).
2. **Nivel 1 (Prioridad Fallback): Variables de entorno del Agente (Inline)**:
   - Si no existe `config.json`, el servidor comprueba si existen las variables `SF_BASE_URL` y (`SF_PASSWORD` o `SF_PRIVATE_KEY`).
   - Sintetiza un entorno en memoria con alias `default` (o el valor de `SF_ENVIRONMENT`).
   - Si un tool call omite `environment`, asume automáticamente el único entorno configurado.
3. **Nivel 2: CLI Interactivo (`npx ssff-mcp init`)**:
   - Asistente de terminal para generar el archivo de Nivel 3 o generar los bloques de Nivel 1.

---

## 3. Especificación del Asistente CLI (`ssff-mcp init`)

### 3.1 Flujo interactivo paso a paso
1. **Detección de argumentos**:
   - `ssff-mcp` (sin args) ➔ Arranca el servidor MCP sobre STDIO (comportamiento normal).
   - `ssff-mcp init` ➔ Inicia el asistente interactivo en terminal (`process.stdin.isTTY`).
2. **Preguntas básicas**:
   - Tipo de autenticación: `Basic Auth` o `OAuth 2.0`.
   - Alias de entorno: por defecto `prod`.
   - URL Base del tenant: validación de formato `https://...` sin trailing slash.
   - Usuario y contraseña / clave privada (soporte opcional para variable o comando).
3. **Paso crítico: Allowlist con descubrimiento en vivo**:
   - Pregunta: *¿Deseas restringir el acceso con una lista blanca (allowlist)?*
   - Si responde `Sí`:
     1. Muestra un spinner: `Conectando con SuccessFactors y recuperando catálogo de entidades...`
     2. Realiza la llamada a `$metadata` mediante `MetadataService`.
     3. Si falla: informa del error (ej. credenciales inválidas o IP no autorizada) y ofrece reintentar.
     4. Si tiene éxito: muestra un prompt interactivo de multiselección con filtro de texto libre entre las entidades encontradas (`User`, `PerPersonal`, `cust_...`, etc.).
     5. Guarda las entidades seleccionadas en la allowlist.
4. **Escritura segura**:
   - Guarda el archivo en `~/.config/ssff-mcp/config.json` con permisos `0600` (POSIX) o advertencia ACL en Windows.
5. **Selector de cliente MCP**:
   - Pregunta: *¿Para qué cliente MCP deseas generar el bloque de configuración?*
   - Opciones:
     - **Codex**
     - **Pi**
     - **OpenCode**
     - **Claude Desktop**
     - **Cursor**
     - **Ninguno**
   - Imprime el bloque JSON listo para copiar y pegar.

---

## 4. Requisitos Funcionales (FR-48..FR-55)

* **FR-48 (Configuración Inline)**: `loadConfig()` DEBE evaluar variables de entorno del proceso cuando `config.json` no existe. Si `SF_BASE_URL` está presente junto con credenciales válidas (`SF_PASSWORD` o `SF_PRIVATE_KEY`), DEBE inicializar un entorno sintetizado sin requerir archivos en disco.
* **FR-49 (Entorno Implícito en Modo Inline)**: Si existe exactamente un entorno configurado (vía variables inline), las herramientas `query_entity`, `get_metadata` y `batch_get` DEBEN aceptar la ausencia del argumento `environment` y resolver por defecto dicho alias.
* **FR-50 (Allowlist Inline)**: La variable `SF_ENTITY_ALLOWLIST` DEBE admitir una lista de entidades separadas por comas (ej. `"User,PerPersonal,EmpJob"`) y mapearla a la estructura `entityAllowlist`.
* **FR-51 (Comando `ssff-mcp init`)**: El CLI DEBE incorporar un comando `init` que no inicie el servidor MCP y ejecute el wizard interactivo de terminal.
* **FR-52 (Validación Previa en Vivo)**: El wizard DEBE verificar la conectividad y validez de las credenciales llamando al endpoint `$metadata` antes de finalizar la configuración de la allowlist.
* **FR-53 (Buscador de Entidades Interactivo)**: El wizard DEBE permitir la búsqueda en texto libre y multiselección entre todos los EntitySets obtenidos del `$metadata`.
* **FR-54 (Precalentamiento de Caché)**: El fetch realizado durante el wizard DEBE poblar la caché de disco local de metadatos (24h TTL), de modo que la primera ejecución del servidor posterior no requiera re-descargar el XML.
* **FR-55 (Plantillas Multicliente)**: El wizard DEBE formatear el bloque exacto de cada cliente soportado: Codex, Pi, OpenCode, Claude Desktop y Cursor. **Corrección (v1.1)**: NO existe un bloque JSON común — Codex usa **TOML** y los clientes JSON difieren en anidado y en la clave de entorno; el formato por cliente es el de §6.1.

---

## 5. Criterios de Aceptación

1. **Modo Inline**:
   - Ejecutar el servidor con `SF_BASE_URL`, `SF_USERNAME` y `SF_PASSWORD` en un entorno sin `config.json` permite listar recursos y ejecutar queries inmediatamente.
2. **CLI Init**:
   - Ejecutar `npx ssff-mcp init` en terminal interactiva guía al usuario sin errores y genera un `config.json` válido con permisos `0600`.
   - La búsqueda en vivo filtra y selecciona entidades reales de SAP.
   - El bloque de los cinco clientes (Codex, Pi, OpenCode, Claude Desktop y Cursor) se genera con la forma exacta de cada uno (§6.1).
3. **No regresión**:
   - Los 208 tests existentes de la Fase 3 continúan pasando en verde.

---

## 6. Open Questions (Q-P4-x)

*Cerradas en v1.1 (2026-10-13). Convención de fases anteriores: enunciado original tachado + resolución.*

1. **Q-P4-1** — ~~¿La selección implícita de entorno aplica solo a inline o también a un `config.json` con un único entorno?~~ **CERRADA**: solo al modo inline (D-49). Con `config.json` presente, D-02/FR-02 siguen intactos y `environment` continúa siendo obligatorio.
2. **Q-P4-2** — ~~¿Qué variables de entorno definen OAuth inline y cómo se transporta una clave PEM multilínea?~~ **CERRADA**: `SF_CLIENT_ID`, `SF_COMPANY_ID`, `SF_USER_ID`, `SF_TOKEN_URL`, `SF_PRIVATE_KEY` (+ `SF_IDP_URL` opcional). El PEM se admite con `\n` escapados o base64 y se normaliza en `loadConfig`; nunca se imprime ni se vuelca en errores.
3. **Q-P4-3** — ~~¿Qué ocurre con variables inline parciales, con un `config.json` inválido, o con variables junto a un archivo válido?~~ **CERRADA**: (a) inline incompleto (p. ej. solo `SF_BASE_URL`) ⇒ `CONFIG_MISSING` con remediación ampliada; (b) `config.json` presente e inválido ⇒ gana el archivo y se reporta `CONFIG_INVALID` (el inline nunca enmascara un archivo roto); (c) archivo válido + variables `SF_*` ⇒ gana el archivo y se emite aviso por `stderr` de que el modo inline se ignora.
4. **Q-P4-4** — ~~¿`SF_ENTITY_ALLOWLIST` admite `protocols` y cómo trata espacios, vacíos y duplicados?~~ **CERRADA**: genera solo entradas `{ entity }` (sin `protocols`); recorta espacios, descarta entradas vacías y rechaza duplicados con `CONFIG_INVALID` (coherente con el esquema). Los `protocols` quedan fuera del modo inline (Non-Goal).
5. **Q-P4-5** — ~~¿Cómo se cumple FR-54 (prewarm) si la caché de metadatos se indexa por alias?~~ **CERRADA**: el wizard precalienta la caché usando **el mismo alias** que quedará en uso (por defecto `prod`) y el bloque inline debe fijar `SF_ENVIRONMENT` a ese alias para que coincida. `get_metadata` no usa la caché; el prewarm beneficia a los recursos y a la clasificación de la allowlist.
6. **Q-P4-6** — ~~¿Qué bloque genera cada cliente y es realmente el mismo?~~ **CERRADA por evidencia**: ver §6.1 (Codex es TOML, no JSON).
7. **Q-P4-7** — ~~¿El bloque inline incrusta el secreto o lo referencia?~~ **CERRADA (ratificada 2026-10-13)**: el wizard admite las dos formas: **referencia** (`env_vars` en Codex, `{env:VAR}` en OpenCode v2, `${VAR}` en Pi) o **texto libre** (valor literal incrustado en `env`/`environment`/tabla `env`). La referencia es la opción por defecto y elegir texto libre muestra un aviso de que el secreto quedará en claro en el archivo del cliente. Ver D-50.
8. **Q-P4-8** — ~~¿El wizard añade una dependencia de prompts? ¿Qué hace sin TTY, al cancelar y al sobrescribir?~~ **CERRADA (ratificada 2026-10-13)**: una única dependencia, `@clack/prompts` (ESM, cross-platform, con multiselección filtrable); sin TTY ⇒ error claro y salida 2 sin tocar disco; Ctrl+C ⇒ salida limpia sin escribir; si existe `config.json` ⇒ confirmación antes de sobrescribir, con backup `.bak`; escritura atómica (temporal + `rename`) aplicando `0600` antes de mover para evitar la ventana TOCTOU. Ver D-51.
9. **Q-P4-9** — ~~¿Qué escribe el wizard cuando el usuario declina la allowlist?~~ **CERRADA (ratificada 2026-10-13)**: omite la clave `entityAllowlist` (sin restricción); **nunca** escribe `[]`, que en el esquema es deny-all. Ver D-52.
10. **Q-P4-10** — ~~¿Hay que actualizar los contratos de documentación afectados?~~ **CERRADA**: sí, forman parte de FR-49. El `instructions` del servidor (`src/tools.ts:270`) y el README pasan a "`environment` es opcional en modo inline (un único entorno)".

### 6.1 Matriz real de clientes (corrige FR-55)

FR-55 afirmaba un "bloque JSON exacto" común. **No existe**: Codex usa TOML y los cuatro clientes JSON difieren en anidado y en la clave de entorno.

| Cliente | Archivo | Forma | Entorno |
|---|---|---|---|
| Codex | `~/.codex/config.toml` | `[mcp_servers.ssff-mcp]` con `command`, `args` | `env_vars = ["SF_PASSWORD", ...]` o tabla `[mcp_servers.ssff-mcp.env]` |
| OpenCode | `opencode.json` | `mcp.ssff-mcp` (v1) / `mcp.servers.ssff-mcp` (v2), `type: "local"` | `environment` |
| Claude Desktop | `claude_desktop_config.json` | `mcpServers.ssff-mcp` | `env` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers.ssff-mcp` | `env` |
| Pi | `~/.pi/agent/mcp.json` | `mcpServers.ssff-mcp` | `env` |

Evidencia: documentación oficial de Codex (`config.toml`), de OpenCode (`mcp`/`environment`) y de Pi (`mcpServers`).

---

## 7. Assumptions (A-P4-x)

*Verificadas o corregidas en v1.1 (2026-10-13).*

- **A-P4-1** — El conteo "208 tests de Fase 3" es exacto. **VERIFICADA** (conteo real en `test/*.test.ts`).
- **A-P4-2** — FR-48..FR-55 y D-45..D-48 no colisionan con IDs de fases previas. **VERIFICADA**.
- **A-P4-3** — ~~Los cinco clientes comparten un mismo bloque JSON.~~ **FALSA**: corregida en §6.1.
- **A-P4-4** — ~~El modo inline no escribe secretos en disco.~~ **FALSA si se incrusta el valor**: resuelta por D-50 (referencia por defecto; el texto libre es una opción explícita y avisada).
- **A-P4-5** — `ssff-mcp init` exige despachar `argv` en el binario; hoy `src/index.ts` arranca el servidor sin leer argumentos. **VERIFICADA** (código actual).
- **A-P4-6** — El `$metadata` del tenant (~7,5 MB, timeout 60 s; 658 EntitySets medidos en Fase 3) se descarga correctamente durante el wizard. **ACEPTADA** (no re-medida en vivo esta fase).
- **A-P4-7** — Que `$metadata` sea accesible prueba credenciales y conectividad, no autorización por entidad. **VERIFICADA** (FR-52 valida credenciales, no permisos por entidad).

---

*Fin del documento. PRD Fase 4 en estado CONFIRMED v1.1 con Open Questions y supuestos cerrados y decisiones D-49..D-52 ratificadas (2026-10-13). Este documento registra intención y no autoriza implementación.*
