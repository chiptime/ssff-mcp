# Roadmap — Control de acceso de ssff-mcp

> **Documento vivo.** Describe el camino para llevar `ssff-mcp` de servidor local
> (STDIO, un usuario, una máquina) a **servicio hospedado multi-tenant con
> usuarios, roles y acceso por rol**.
>
> Estado: **Fase 1 completada** · **Fase 1.5 completada** · **Fase 2 implementada en
> `main`** (sin publicar) · **Fase 3 con decisiones consolidadas en PRD DRAFT**
> (sin implementar; validación IAS pendiente de permiso).

## Objetivo

Compartir el MCP como servicio: **varios clientes (tenants)**, cada uno con sus
propios entornos (**dev / test / prod**), **varios usuarios por tenant** y
**roles**, donde el acceso a las entidades se define **a partir del rol**
(básicamente, un *allowlist/denylist por rol*).

El destino es que la autorización se resuelva así:

```
entorno = TECHO        → lo que se puede tocar en ese entorno
rol     = SUBCONJUNTO  → lo que puede ver ese usuario
efectivo = INTERSECCIÓN
```

Para usuarios IAS, **la denegación del entorno o del rol siempre gana**.
Las claves API conservan su modelo actual, sin roles nuevos.

## Resumen de fases

| Fase | Alcance | Estado |
|---|---|---|
| **1 · Acceso por entorno** | `entityAllowlist` + `entityDenylist` dentro de cada entorno | ✅ Hecha (0.4.0) |
| **1.5 · Endurecimiento** | Navegación, `$expand`, `$filter`/`$orderby`, granularidad por campo | ✅ Hecha (0.5.0) |
| **2 · Servicio hospedado multi-tenant** | Transporte remoto + tenants | ✅ En `main`, sin publicar |
| **3 · Identidad: usuarios y roles** | IAS por cliente + roles propios del MCP | 🧭 PRD DRAFT, sin implementar |

---

## Fase 1 · Acceso por entorno ✅

El control de acceso por entidad vive **dentro de cada entorno**
(`environments.<alias>.entityAllowlist` y `environments.<alias>.entityDenylist`),
de modo que un entorno puede quedar restringido y otro no. Ambas claves **en la
raíz se rechazan** con `CONFIG_INVALID` (el mensaje indica mover cada lista al
entorno al que aplica).

El modelo es **allowlist + denylist**, con esta precedencia:

```
denylist  >  allowlist  >  permisos de la cuenta API
```

- La **`entityAllowlist` solo ACOTA**: una lista **vacía o ausente se comporta
  igual** — **no acota nada**. Ya **no** deniega todo (`[]` dejó de ser deny-all).
- La denegación explícita se expresa con **`entityDenylist`** (por entorno), que
  **siempre gana** sobre la allowlist.
- Los nueve puntos de enforcement pasan por `isEntityPermitted`; el filtrado es
  **post-caché** (la lista llega como parámetro) → solo cambia la *procedencia*.
- El wizard `init` exige elegir ≥1 entidad: escribir `[]` invertiría en silencio
  una respuesta de "restringir".
- En inline: `SF_ENTITY_ALLOWLIST` y `SF_ENTITY_DENYLIST` pueblan el entorno único.
- `sf://{env}/overview` reporta `denylistConfigured`.
- Integrada en `main` desde `0.4.0`.

---

## Fase 1.5 · Endurecimiento de la frontera ✅

Cerró las vías laterales que la allowlist por entidad dejaba abiertas:

- **Navegación en la ruta** (`User('1')/empInfo`): cada salto se resuelve por metadata a su
  `targetEntitySet` y se comprueba; un salto no resoluble se rechaza, nunca se despacha.
- **`$expand`**: parser propio (subconjunto probado), resolución recursiva desde la entidad
  a la que llega la ruta, `$select` anidado comprobado y `$filter`/`$orderby` anidados
  rechazados. Percent-encoding rechazado.
- **`$filter` / `$orderby` / `$select`**: extracción por identificador (fuera de literales),
  rutas de navegación recorridas salto a salto, asociaciones desnudas resueltas y denegadas.
  El percent-encoding fuera de literal se rechaza con `OPTION_INVALID`, porque el servicio lo
  decodifica antes de evaluar.
- **Granularidad por campo** (`fields` en la entrada de allowlist): referencias no permitidas
  rechazadas, payload redactado (claves siempre legibles), `inspect_entity` y los recursos de
  esquema ocultan lo no permitido, y `output: "xml"` degrada a JSON con `outputDowngraded`.
- **Límite declarado:** el escaneo de expresiones es por identificador, no un parser completo
  de OData v2; una forma no reconocida queda declarada en `docs/security.md`.

---

## Fase 2 · Servicio hospedado multi-tenant ✅ (implementada, sin publicar)

Llevar el MCP a servidor para compartirlo entre varios clientes.

### Estado de implementación

Todo el alcance está en `main` (punta `efb5a8f`), **sin push y sin release**:

- `src/config.ts` — nivel `tenants` + auto-migración de la forma plana (desde `0.5.0`).
- `src/tenancy.ts` — `resolveTenant`: claves sha-256, comparación en tiempo constante,
  fail-closed y alcance por entorno.
- `src/metadata.ts` — caché `metadata-<tenant>-<alias>.json`.
- `src/server-http.ts` + `src/cli/serve.ts` — Streamable HTTP, `/mcp`, `/healthz`, sesiones
  acotadas y drenaje en `SIGTERM`/`SIGINT`.
- `src/cli/key.ts` — `ssff-mcp key hash` por stdin (nunca por argv).
- `Dockerfile` no-root, `.dockerignore`, `config.hosted.template.json` y `docs/hosting.md`.
- `ssff-mcp cache invalidate <alias|--all> --tenant <id>` para configs multi-tenant.

Validado con la suite completa y sondas HTTP contra un mock TLS local; **no** contra SAP real
en modo hospedado ni con clientes de producto salvo OpenCode headless.

### Pendiente para cerrar la Fase 2

1. **Publicación:** el config `tenants` es *breaking* → release **major**; decidir antes si
   se hace push a `origin`.
2. **Despliegue real:** Dokploy + TLS, IP del VPS registrada en las *API login exceptions* de
   cada cliente SAP, y prueba con Claude Desktop, VS Code/Copilot, Codex y Pi.
3. **RDD:** la revisión nativa de la rama quedó incompleta por un defecto de gentle-ai
   (revisores con `finish=length`); no se relanza sin petición.

### Decisiones tomadas

- **Transporte: Streamable HTTP.** Se descarta SSE: `SSEServerTransport` está
  marcado `@deprecated` en `@modelcontextprotocol/sdk`; el sustituto es
  `StreamableHTTPServerTransport` (y su variante web-standard para entornos
  no-Node).
- **Un motor, un paquete, dos entrypoints.** `createMcpServer()`
  (`src/tools.ts`) es el motor; el transporte es lo único que varía.
  `ssff-mcp` → STDIO (por defecto); `ssff-mcp serve` → HTTP. **No** son dos MCPs.
- **Costura: el motor no sabe de tenancy.** Recibe un config **ya resuelto**. El
  borde lo resuelve: en local, un único tenant; en hospedado, el tenant a partir
  de la clave.
- **Auth de conexión:** la clave resuelve el **tenant**. `environment`
  (dev/test/prod) es un **argumento de tool**, no una propiedad de conexión.
- **Config unificada a `tenants`** (base por tenant, **override por entorno**):

  ```json
  {
    "tenants": {
      "acme": {
        "environments": {
          "dev":  { "baseUrl": "https://api4.successfactors.com", "auth": { "...": "..." } },
          "prod": { "baseUrl": "https://api4.successfactors.com", "auth": { "...": "..." } }
        },
        "entityAllowlist": [ { "entity": "User" }, { "entity": "EmpJob" } ],
        "entityDenylist":  [ { "entity": "PerPersonal" } ]
      }
    }
  }
  ```

- **Caché de metadatos por tenant:** `metadata-<tenant>-<alias>.json`. Dos
  clientes con alias `prod` colisionarían en una caché única.
- **Invariantes de aislamiento** (obligatorias):
  1. El tenant se resuelve **una sola vez** en el borde y se pasa como contexto
     explícito; nunca estado global mutable.
  2. Claves de caché (`$metadata` y tokens OAuth) = **tenant + entorno**.
  3. **Fail-closed**: clave o tenant desconocidos → `401`. Nunca un tenant por defecto.
  4. Credenciales, `allowlist`/`denylist` y logs se leen **siempre** del contexto
     del tenant.
  5. `environment` se valida **contra el tenant resuelto**.

### Consecuencias asumidas

- **Cambio de ruptura de config.** Unificar a `tenants` rompe el config plano
  publicado (top-level `environments`) → exige **major version** y ruta de
  migración. Recomendado: **auto-migración al cargar** (detectar la forma plana
  y envolverla como un único tenant).
- **El aislamiento pasa a ser responsabilidad del código.** En servicio
  compartido, un bug en la resolución de tenant, en la clave de caché o en la
  lectura de las listas = **fuga de datos entre clientes**. El proceso sostiene
  además las **credenciales de todos los clientes**, no una por instancia.

---

## Fase 3 · Identidad: usuarios y roles 🧭

**Especificación:** [PRD — Fase 3: identidad IAS y roles del MCP](docs/PRD-phase3-ias-roles.md).
Estado **DRAFT**: consolida decisiones; no autoriza implementación ni acceso a IAS.
No confundir con `archive/PRD-phase3.md`, que describe otra fase histórica.

### Decisiones tomadas

- **Identidad individual:** cada cliente usa su propio SAP IAS. Primer cliente MCP
  de aceptación: **OpenCode**.
- **Dos planos separados:** IAS autentica al usuario y el MCP aplica su rol;
  SSFF mantiene la cuenta técnica existente. Sin principal propagation ni destinations.
- **Roles propios por tenant:** restringen entornos y tienen su propia
  `entityAllowlist`/`entityDenylist`, incluidos `fields`, con la semántica actual.
  Listas o campos vacíos/ausentes no acotan esa capa; no se inventa otro modelo.
- **Techo del entorno:** el permiso efectivo respeta entorno y rol; las restricciones
  de campos se intersectan y las denegaciones prevalecen. Un rol nunca amplía el techo.
- **Un único rol efectivo:** mapeo de grupos IAS en configuración; sin rol, denegación;
  varios roles distintos, rechazo por ambigüedad.
- **Asignaciones manuales por usuario en configuración:** prevalecen sobre grupos hasta
  retirarlas. Si apuntan a un rol inexistente, se deniega sin fallback a grupos.
- **Rol técnico provisional:** un rol normal, con lectura limitada y asignación manual
  a usuarios concretos; no es un rol automático para todo usuario autenticado.
- **Claves API:** siguen independientes, con su scope y políticas actuales, sin roles nuevos.
- **Cambios en la siguiente petición:** roles, permisos y asignaciones se releen;
  los cambios de grupos se reflejan con un token actualizado. Un token caducado no
  autoriza peticiones aunque siga abierta la sesión.
- **Auditoría:** tenant, identificador técnico IAS, rol y operación, sin nombres,
  correos, tokens ni contenido de registros.

### Evidencia pendiente antes de implementar

Existe un IAS disponible, pero **requiere permiso explícito antes de acceder**.
No se ha realizado ninguna prueba real de Fase 3.

1. Autorizar destino, operaciones y cuenta/sesión de IAS.
2. Verificar discovery, PKCE, registro del cliente y compatibilidad de OpenCode.
3. Confirmar access token, issuer, audience/resource y claim de grupos.
4. Cerrar con esa evidencia la vinculación tenant/issuer, el identificador estable
   de usuario y el esquema de configuración.

Las afirmaciones históricas sobre deprecación de DCR, CIMD y necesidad de un cliente
pre-registrado o proxy quedan **pendientes de contraste**, no como solución verificada.

---

## Decisiones abiertas

| # | Decisión | Fase |
|---|---|---|
| 1 | **Resuelta — políticas de rol:** primero se resuelve el entorno con la semántica actual de tenant/entorno; después se aplican también las listas del rol. Ninguna capa amplía a la otra; la denegación gana. Vacío/ausente no acota esa capa. | 3 |
| 2 | ~~**Alcance de la clave**~~ — **resuelta:** `apiKeyHash` existe en el tenant y en cada entorno; una clave de entorno solo alcanza su entorno, la del tenant todos los suyos. | 2 |
| 3 | **Pendiente — validación IAS/OpenCode:** permiso de acceso, login, tokens, claim de grupos y vinculación de tenant. Véase P1–P5 del PRD de Fase 3. | 3 |

> *Resuelta:* la pregunta previa sobre la semántica de la **allowlist vacía/ausente**
> está cerrada — **no acota nada**; la denegación explícita va por `entityDenylist`.

## Referencias

- `PRD-feature-multitenant-hosting.md` — PRD vigente de Fase 2 (sustituye al antiguo
  `PRD-feature-http-sse-transport.md`).
- `PRD-feature-allowlist-vectors.md` — cierre de los vectores de `$expand` y navegación.
- `docs/PRD-phase3-ias-roles.md` — decisiones de identidad/roles, requisitos y aceptación V1–V3.
- `odd/tasks/entity-allowlist-per-environment.md` — trabajo de Fase 1.
- `odd/tasks/field-granularity.md` y `odd/tasks/multitenant-hosting.md` — Fase 1.5 y Fase 2.
- `archive/README.md` — PRDs ya ejecutados.
