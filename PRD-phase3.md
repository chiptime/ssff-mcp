# PRD — ssff-mcp Fase 3: usabilidad MCP, multiplataforma y gestión de secretos

| Campo | Valor |
|---|---|
| Estado | **CONFIRMED v1.1** — decisiones de disco, lazy secrets y grill-me cerradas; implementación completada y verificada |
| Fecha | 2026-10-13 |
| Fuente de decisiones | Roadmap de debilidades/oportunidades (DAFO 2026-10-12) + mitigación de cuellos de botella de contexto + grill-me de arquitectura (2026-10-13, D-39..D-44) |
| Idioma | Español neutro profesional; identificadores y términos de código en inglés |
| Relación con PRD.md y PRD-phase2.md | **Extiende** PRD.md y PRD-phase2.md incorporando FR-36..FR-47. D-43 y D-44 enmiendan D-09 y D-34 autorizando la caché de esquemas parsed JSON en disco local con TTL de 24h |

| Versión | Notas |
|---|---|
| v0.1 | Especificación inicial de Fase 3: Recursos MCP, multiplataforma y gestión de credenciales. |
| v1.0 | Cierre de grill-me: esquema exhaustivo con cardinalidad para recursos (D-40), tipado estricto Zod para secretos (D-39), validación tolerante en Windows (D-41) y resolución stateless para fromCommand (D-42). |
| v1.1 | Adopción de caché en disco local con TTL 24h (D-43/D-44), resolución lazy de secretos por alias (A3/D-42), permisos de caché 0700/0600 (A1), prefijos de código en errores de recursos (A5). **A4 implementado (2026-10-14)**: el «aviso ACL Windows **una vez por proceso**» se emite una sola vez por proceso (flag `windowsAclWarningEmitted` en `src/config.ts`). La nota anterior afirmaba lo contrario —era cierto entonces— y quedó obsoleta al alinearse el código. |

Este documento consolida las especificaciones y contratos de la Fase 3. Ninguna parte autoriza a escribir código, publicar o cambiar licencia (D-10/D-11 siguen vigentes). **MUST / MUST NOT / SHOULD / MAY** según RFC 2119.

---

## 0. Registro de decisiones (ledger)

### 0.1 Decisiones confirmadas en Fase 3

| ID | Decisión | Fuente |
|---|---|---|
| D-33 | **Exposición de MCP Resources (`resources/list`, `resources/read`)**: el servidor expone catálogo y esquemas ligeros como recursos URI (`sf://{env}/entities`, `sf://{env}/entities/{entitySet}`, `sf://{env}/overview`). Sustituye la necesidad de que el LLM descargue el `$metadata` XML completo de 7.5 MB. | Mitigación cuello de botella DAFO |
| D-34 | **Caché de esquemas en memoria**: los recursos de esquema se generan a partir de la caché transitoria en memoria de `$metadata` (10 min de TTL de proceso). Enmendada por D-43/D-44 para añadir persistencia en disco con TTL de 24h. | Coherencia D-09 / DS-P2-02 (enmendada) |
| D-35 | **Filtrado por `entityAllowlist` en Resources**: `sf://{env}/entities` solo lista las entidades permitidas si la lista blanca está configurada; `sf://{env}/entities/{entitySet}` devuelve error si la entidad solicitada está excluida por la allowlist. | Principio de fail-closed (D-30) |
| D-36 | **Soporte multiplataforma oficial (Linux, macOS, Windows)**: compatibilidad de rutas mediante `os.homedir()` y validación tolerante de permisos de fichero según el sistema operativo subyacente. | Eliminación de barrera de adopción |
| D-37 | **Comprobación de permisos adaptada a la plataforma**: en POSIX (Linux, macOS) se evalúan permisos `0600` (`mode & 0o077 === 0`). En Win32 se comprueba que el fichero exista y sea legible, emitiendo una advertencia no bloqueante en stderr recomendando ACLs. | Limitación estructural NTFS/FAT |
| D-38 | **Resolución segura de credenciales por referencia**: soporte de secretos mediante variables de entorno (`fromEnv`) o comandos CLI seguros sin shell (`fromCommand`), manteniendo retrocompatibilidad total con cadenas en texto plano. | Mitigación riesgo seguridad DAFO |
| D-39 | **Sintaxis de secretos tipada**: se confirma el uso de objetos JSON explícitos (`{ "fromEnv": "VAR" }` y `{ "fromCommand": ["cmd", "arg"] }`) validados con esquemas Zod estrictos, descartando plantillas de cadenas (`${VAR}`) para evitar ambigüedades con el carácter `$`. | Grill-me 2026-10-13 (A1) |
| D-40 | **Esquema exhaustivo con cardinalidad en Resources**: `sf://{env}/entities/{entitySet}` debe proporcionar cardinalidad detallada (`multiplicity`: `"0..1" | "1" | "*"`) y relaciones completas para permitir al LLM razonar con precisión sobre consultas con `$expand`. | Grill-me 2026-10-13 (A2) |
| D-41 | **Aviso preventivo en Windows para permisos**: en `win32` la verificación de permisos es no bloqueante (aviso en `stderr` recomendando ACLs una sola vez por proceso). | Grill-me 2026-10-13 (A3/A4) |
| D-42 | **Resolución lazy y stateless de secretos**: los secretos se resuelven exclusivamente para el alias de entorno solicitado en cada llamada a herramienta (`resolveSecretsFor`), evitando ejecutar comandos de otros entornos configurados. Sin caché de credenciales entre llamadas. | Grill-me 2026-10-13 (A3/A4) |
| D-43 | **Caché de `$metadata` en disco local con TTL**: el `$metadata` parseado se guarda en almacenamiento de disco local para evitar re-descargar los ~7.5 MB en cada arranque del proceso. Enmienda D-09/D-34 exclusivamente para metadatos de esquemas (nunca datos de negocio ni secretos). | Usuario 2026-10-13 |
| D-44 | **Estructura y TTL de la caché en disco**: TTL de 24 horas (`METADATA_DISK_TTL_MS`), guardando JSON parseado `{ fetchedAt, data }`. Ruta: Linux `~/.cache/ssff-mcp`, macOS `~/Library/Caches/ssff-mcp`, Windows `%LOCALAPPDATA%\ssff-mcp\cache`. Permisos POSIX `0700` directorio y `0600` fichero. Escritura defensiva best-effort. | Implementación y acuerdo A1/A2 |

### 0.2 Implicaciones derivadas (obligatorias)

| ID | Implicación | Derivada de |
|---|---|---|
| DS-P3-01 | La resolución de comandos `fromCommand` DEBE usar `execFile` con vector de argumentos explícito; el uso de shells (`sh`, `bash`, `cmd.exe`) está **estrictamente prohibido** para prevenir inyecciones de comandos (CWE-78). | D-38, límites de confianza |
| DS-P3-02 | Los comandos `fromCommand` tienen un timeout duro de **5.000 ms** (`SECRET_COMMAND_TIMEOUT_MS`); una ejecución más lenta rechaza la llamada con `CONFIG_SECRET_TIMEOUT`. | D-38, resiliencia |
| DS-P3-03 | Las salidas y errores de `fromCommand` o `fromEnv` NUNCA deben volcarse en logs ni exponerse al modelo en mensajes de error estructurados. | D-38, sanitización de logs |
| DS-P3-04 | Los MCP Resources son estrictamente de solo lectura; la especificación MCP no contempla mutaciones mediante recursos. | D-07, D-33 |
| DS-P3-05 | La normalización de finales de línea CRLF en Windows no debe alterar las firmas binarias o de HMAC de los cursores de paginación. | D-27, D-36 |
| DS-P3-06 | Los errores arrojados en recursos deben prefijarse con el código sanitizado (`ENTITY_NOT_ALLOWED: ...`, `RESOURCE_NOT_FOUND: ...`) para que los clientes MCP que envuelven el mensaje preserven la identificabilidad del error. | Grill-me 2026-10-13 (A5) |

---

## 1. Context & Problem

Fase 2 resolvió la paginación continua (`cursor`), la agregación `$batch` (`batch_get`) y la autenticación OAuth 2.0. Sin embargo, el uso real y el análisis estratégico revelan tres fricciones fundamentales:

1. **Inundación de contexto por metadatos (7.5 MB)**:
   * En `clecesa`, `GET /odata/v2/$metadata` devuelve 7.506.695 bytes con 658 EntitySets.
   * Si el modelo invoca `get_metadata`, agota la ventana de contexto de los LLMs actuales o consume decenas de miles de tokens de forma ineficiente.
   * Sin metadatos, el modelo debe "adivinar" las propiedades (`userId`, `username`, `defaultFullName`...) de entidades complejas (`User`, `PerPersonal`, `EmpJob`).
2. **Restricción exclusiva a Linux**:
   * Los clientes MCP habituales (Claude Desktop, Cursor, OpenCode) se ejecutan masivamente en macOS y Windows.
   * La verificación rígida de permisos POSIX y la asunción de rutas UNIX impedían el despliegue directo en estos sistemas operativos.
3. **Almacenamiento de secretos en claro en disco**:
   * Contraseñas de Basic Auth y claves privadas RSA residen en texto plano en `~/.config/ssff-mcp/config.json`.
   * Esto choca frontalmente con directivas de seguridad corporativas y bloquea la adopción en organizaciones donde las credenciales deben residir en variables de entorno efímeras o en gestores como 1Password (`op`), HashiCorp Vault o Bitwarden (`bw`).

---

## 2. Objectives & Non-Objectives

### 2.1 Objetivos

1. **Catálogo y esquemas ligeros vía MCP Resources**:
   * Lista de entidades accesibles en < 50 KB.
   * Esquema granular por entidad bajo demanda en < 10 KB.
2. **Soporte nativo y probado en Linux, macOS y Windows**:
   * Resolución agnóstica de rutas de usuario.
   * Tratamiento robusto de permisos según la plataforma.
   * Suite de pruebas automatizada en CI (matriz multi-OS).
3. **Proveedores de secretos plugables y retrocompatibles**:
   * Lectura de variables de entorno (`fromEnv`).
   * Invocación de utilidades CLI locales sin shell (`fromCommand`).
   * Fallback transparente para configuraciones en texto plano existentes.

### 2.2 Non-Goals (explícito)

* **Protocolo OData v4**: se mantiene fuera hasta confirmación de endpoint real en tenant de pruebas (D-26).
* **Escritura o mutaciones**: la frontera estricta de solo lectura (D-07/D-08/DS-P2-04) sigue inmutable.
* **Almacenamiento permanente de esquemas**: ningún esquema transformado se guarda en disco (D-09).
* **Servidor HTTP / SSE**: la comunicación se mantiene exclusivamente local sobre STDIO (D-04).
* **Herramientas de negocio especializadas de HR**: no se empaquetan funciones arbitrarias en código; se mantiene la arquitectura orientada a OData genérico seguro complementada con Recursos.

---

## 3. Architecture & Trust Boundaries

### 3.1 Flujo arquitectónico extendido

```
Host MCP (Claude / OpenCode / Cursor)
      │
      ├── STDIO: Mensaje JSON-RPC 2.0 (LF / CRLF agnóstico)
      │
      ├─▶ [NUEVO] resources/list
      │     └─ Responde URIs: sf://{env}/entities, sf://{env}/overview
      │
      ├─▶ [NUEVO] resources/read (URI: sf://{env}/entities/{name})
      │     ├─ Valida env y entityAllowlist (fail-closed)
      │     └─ Parsea EntityType específico desde caché transitoria $metadata
      │
      ├─▶ [NUEVO] Validador de Configuración con Secret Provider
      │     ├─ Resuelve strings directos, fromEnv o fromCommand (execFile, timeout 5s)
      │     └─ Verifica permisos (0600 en POSIX; relaxed en Win32)
      │
      └─▶ Herramientas existentes (list_environments, get_metadata, query_entity, batch_get)
            └─ Peticiones HTTPS al tenant SAP SuccessFactors
```

### 3.2 Nuevos límites de confianza y defensas

* **T6 (Resolución de comandos locales)**: la ejecución de comandos para obtención de secretos se limita a binarios invocados directamente vía `execFile`, sin paso intermedio por ningún intérprete de comandos (`sh`, `bash`, `cmd`). No se admiten tuberías (`|`), redirecciones ni comodines. Si el ejecutable no se encuentra en el `PATH` o finaliza con código distinto de 0, la carga de configuración falla inmediatamente sin exponer buffers de error.
* **T7 (Recursos y aislamiento de allowlist)**: los recursos MCP respetan rigurosamente la `entityAllowlist`. Un LLM no puede obtener la definición de campos de una entidad que tenga prohibido consultar mediante `query_entity`.

---

## 4. Data Schema & Contracts

### 4.1 Ampliación de `config.json` para Secretos

Las propiedades `password` (Basic Auth) y `privateKey` (OAuth) aceptan ahora:

1. **Cadena simple (comportamiento heredado)**:
   ```json
   "password": "mi-password-en-claro"
   ```
2. **Variable de entorno (`fromEnv`)**:
   ```json
   "password": {
     "fromEnv": "SF_PROD_PASSWORD"
   }
   ```
3. **Comando CLI seguro (`fromCommand`)**:
   ```json
   "privateKey": {
     "fromCommand": ["op", "read", "op://Enterprise/SuccessFactors/privatekey"]
   }
   ```

### 4.2 Esquema de URIs de MCP Resources

| URI | Descripción | Tipo de Contenido | Tamaño aprox. |
|---|---|---|---|
| `sf://{env}/overview` | Metadatos generales del entorno (alias, baseUrl, authType, total de entidades). | `application/json` | < 1 KB |
| `sf://{env}/entities` | Catálogo de todos los EntitySets disponibles (nombre, clave y si está activo en la allowlist). | `application/json` | ~30 KB |
| `sf://{env}/entities/{name}` | Definición estructural de una entidad específica: propiedades, tipos Edm, si es nullable y navigation properties salientes. | `application/json` | 2-8 KB |

Ejemplo de salida de `sf://prod/entities/User`:
```json
{
  "entitySet": "User",
  "entityType": "SFOData.User",
  "keys": ["userId"],
  "properties": [
    { "name": "userId", "type": "Edm.String", "nullable": false },
    { "name": "username", "type": "Edm.String", "nullable": true },
    { "name": "email", "type": "Edm.String", "nullable": true },
    { "name": "status", "type": "Edm.String", "nullable": true }
  ],
  "navigationProperties": [
    {
      "name": "jobInfoNav",
      "targetEntitySet": "EmpJob",
      "relationship": "SFOData.User_jobInfoNav",
      "multiplicity": "*"
    },
    {
      "name": "personalInfoNav",
      "targetEntitySet": "PerPersonal",
      "relationship": "SFOData.User_personalInfoNav",
      "multiplicity": "0..1"
    }
  ]
}
```

---

## 5. Requisitos Funcionales (FR-36..FR-47)

### 5.1 Recursos MCP (Resources)

* **FR-36**: El servidor DEBE implementar el manejador `resources/list` declarando las URIs de los entornos configurados: `sf://{env}/overview` y `sf://{env}/entities`.
* **FR-37**: El recurso `sf://{env}/entities` DEBE listar todos los EntitySets encontrados en el `$metadata` del entorno. Si existe una `entityAllowlist` configurada, solo MUST incluir aquellas entidades que cumplan las reglas de inclusión.
* **FR-38**: El servidor DEBE implementar el manejador `resources/read` para resolver patrones `sf://{env}/entities/{entitySet}`. Si la entidad no existe o está excluida por la `entityAllowlist`, DEBE responder con error de recurso no encontrado.
* **FR-39**: La respuesta de `sf://{env}/entities/{entitySet}` DEBE devolver un JSON estructurado exhaustivo (D-40) con las propiedades escalares (`name`, `type`, `nullable`), claves primarias y relaciones de navegación salientes completas (`name`, `targetEntitySet`, `relationship`, `multiplicity`: `"0..1" | "1" | "*"`), extrayéndolas y deduciéndolas de las etiquetas `<Association>` y `<NavigationProperty>` de la caché en memoria de metadatos.
* **FR-40**: La resolución de recursos MUST NOT realizar peticiones a la red si el `$metadata` del entorno ya reside en la caché en memoria transitoria (TTL 10 minutos).

### 5.2 Compatibilidad Multiplataforma

* **FR-41**: La resolución de la ruta predeterminada de configuración DEBE utilizar `path.join(os.homedir(), '.config', 'ssff-mcp', 'config.json')`.
* **FR-42**: En plataformas compatibles con POSIX (Linux, Darwin), el servidor DEBE rechazar el arranque si los permisos del archivo de configuración no son estrictamente `0600` (`mode & 0o077 === 0`), arrojando `CONFIG_PERMISSIONS_INVALID`.
* **FR-43**: En plataformas Windows (`process.platform === 'win32'`), el servidor DEBE omitir la verificación estricta de bits de permisos POSIX y emitir una advertencia defensiva en `stderr` recomendando la protección de la carpeta con ACLs de Windows (D-41).
* **FR-44**: El servidor DEBE procesar secuencias de salto de línea CRLF (`\r\n`) y LF (`\n`) en el transporte STDIO sin producir errores de deserialización JSON-RPC ni corromper firmas HMAC de cursores.

### 5.3 Gestión Segura de Credenciales

* **FR-45**: El parser de configuración DEBE aceptar objetos con la propiedad `fromEnv: string` para los campos `password` y `privateKey` (D-39). El valor DEBE resolverse en tiempo de ejecución desde `process.env`. Si la variable no está definida o está vacía, el servidor DEBE fallar con `CONFIG_SECRET_MISSING`.
* **FR-46**: El parser de configuración DEBE aceptar objetos con la propiedad `fromCommand: string[]` (donde el primer elemento es el binario y los subsiguientes son argumentos) (D-39). El comando DEBE invocarse mediante `child_process.execFile` con un timeout máximo de 5.000 ms. La resolución es estrictamente stateless en cada llamada a herramienta (D-42); no se almacenan credenciales entre ejecuciones. Si el proceso falla, agota el tiempo o emite salida vacía, DEBE arrojarse `CONFIG_SECRET_COMMAND_FAILED`.
* **FR-47**: Los secretos resueltos vía `fromEnv` o `fromCommand` MUST NOT registrarse en logs de `stderr`, MUST NOT persistirse en disco y MUST NOT incluirse en mensajes de error estructurados o respuestas a clientes.

---

## 6. Verification & Acceptance Criteria

1. **Recursos de Metadatos Ligeros**:
   * Consulta a `sf://prod/entities` tarda menos de 100 ms con metadatos en caché y su payload es < 50 KB.
   * `sf://prod/entities/User` devuelve el listado de propiedades y claves sin requerir descargar los 7.5 MB de XML.
   * Entidad no listada en `entityAllowlist` devuelve denegación de recurso.
2. **Multiplataforma**:
   * La suite de tests unitarios y de integración pasa al 100% en GitHub Actions sobre `ubuntu-latest`, `macos-latest` y `windows-latest`.
   * En Windows, la lectura de `config.json` funciona correctamente sin fallar por verificación de modo octal.
3. **Proveedores de Secretos**:
   * Configuración con `fromEnv` resuelve correctamente el valor desde una variable exportada.
   * Configuración con `fromCommand` ejecutando `echo` o herramienta de prueba resuelve el secreto sin invocar una shell (`shell: false`).
   * Inyección de caracteres especiales (`&`, `|`, `;`) en argumentos de `fromCommand` no produce ejecución de subshell ni errores de seguridad.
   * Un comando que excede los 5 segundos aborta y rechaza la llamada de manera limpia.
