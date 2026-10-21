# PRD — Fase 3: identidad IAS y roles del MCP

> **Estado: DRAFT.** Consolida decisiones confirmadas; no autoriza implementación,
> acceso a IAS, despliegue, commit ni publicación.
> Alcance: acceso hospedado por usuario. Primer cliente de validación: **OpenCode**.

## 1. Contexto y problema

El modo hospedado ya permite conectar mediante claves API que resuelven tenant y
entornos. Falta distinguir a los usuarios individuales y aplicarles permisos por rol.
Cada cliente tendrá su propio SAP IAS; SSFF seguirá recibiendo consultas mediante
la cuenta técnica configurada para su tenant y entorno.

**Son dos planos independientes:** IAS identifica al usuario ante el MCP; el MCP
autoriza sus operaciones; la credencial técnica existente autentica la conexión a SSFF.
No se propaga la identidad del usuario a SuccessFactors.

### Evidencia del punto de partida

| Hecho verificado | Evidencia local |
|---|---|
| Una clave resuelve tenant y entornos, no un rol | `src/tenancy.ts:30-34,51-86` |
| Claves ausentes, desconocidas o ambiguas no resuelven un tenant | `src/tenancy.ts:54-58,75-82` |
| La denylist prevalece sobre la allowlist | `src/allowlist.ts:78-87` |
| Allowlist ausente o vacía no acota | `src/allowlist.ts:60-68` |
| `fields` ausente o vacío no acota campos | `src/allowlist.ts:98-114` |
| Las claves de las entidades siguen siendo legibles y XML se degrada cuando hay restricciones de campos | `ROADMAP.md`, Fase 1.5; contrato existente, no una regla nueva de esta fase |

El documento archivado `archive/PRD-phase3.md` describe otra numeración histórica
(recursos, caché y secretos). **No es la especificación de esta fase de identidad.**

## 2. Objetivos y fuera de alcance

### Objetivos

- Identidad individual mediante el IAS de cada cliente.
- Un rol efectivo por usuario, propio del tenant, con asignación manual o por grupos.
- Reutilizar allowlist/denylist y `fields`, sin inventar otra política de permisos.
- Mantener las claves API y la cuenta técnica de SSFF con su funcionamiento actual.
- Validar primero el recorrido real de autenticación desde OpenCode.

### Fuera de alcance

- Principal propagation, destinations y ejecución en SSFF como el usuario final.
- Gestión propia de contraseñas, usuarios IAS o altas/bajas en el IdP.
- Interfaz administrativa y servicio externo de asignaciones.
- Roles compartidos entre tenants, múltiples roles acumulativos o rol universal automático.
- Añadir roles a las claves API, alterar STDIO o cambiar permisos RBP de SSFF.
- Implementación, migración o release como consecuencia de aprobar este borrador.

## 3. Decisiones confirmadas y trazabilidad

Las fuentes son las respuestas de esta conversación; las correcciones posteriores
prevalecen sobre opciones anteriores.

| ID | Decisión final | Fuente de confirmación |
|---|---|---|
| D1 | Identidad por persona, mediante SAP IAS propio por cliente | Elección `1` en las tres preguntas correspondientes |
| D2 | Un único rol; varios roles definitivos derivados de grupos implican rechazo por ambigüedad | Elección `1` sobre multiplicidad |
| D3 | Sin asignación manual ni rol reconocido por grupos, acceso denegado | Elección `1` sobre usuario sin rol |
| D4 | Mapeo de grupos IAS a roles en el archivo de configuración de cada tenant | Elección `1` sobre origen del rol y ubicación del mapeo |
| D5 | Rol técnico normal, limitado, asignado manualmente a usuarios concretos | «digamos que es un rol tecnico que asignaremos manualmente mientras se configura la asignacion de los roles Mediante grupos de IAS» y elecciones posteriores `1` |
| D6 | La asignación manual prevalece hasta retirarla y vive en configuración | Elección `2` sobre precedencia; `1` sobre archivo de configuración |
| D7 | Roles por tenant; restringen entornos, entidades y campos sin ampliar el techo del entorno | Elecciones `2`, `1` y `1` en alcance, techo y ubicación |
| D8 | Cada rol reutiliza las listas y la semántica existentes | «debe tirar de la allowlist/denylist, los roles tendran la suya propia y ya» |
| D9 | IAS controla el acceso al MCP; SSFF mantiene la cuenta técnica | Elección `1` tras separar explícitamente los dos planos |
| D10 | Claves API independientes, sin roles IAS/MCP nuevos ni cambios de comportamiento | Elección `1` tras la aclaración de D9; sustituye las respuestas previas sobre roles para claves |
| D11 | OpenCode primero; IAS disponible pero requiere permiso antes de acceder | Elección `1` y «tendria que pedir permiso [...] dejemoslo en si» |
| D12 | Asignación manual a rol inexistente deniega sin recurrir a grupos | Elección `1` sobre referencia manual inválida |
| D13 | Configuración efectiva en la siguiente petición; grupos renovados con token actualizado | Elección `1` sobre aplicación de cambios |
| D14 | Token caducado rechaza peticiones hasta recibir uno válido | Elección `1` sobre caducidad durante sesión |
| D15 | Logs con tenant, identificador técnico IAS, rol y operación; sin nombres, correos ni contenido de registros | Elección `1` sobre auditoría |

**Correcciones importantes:** no hay grupo de prueba obligatorio, ni rol técnico
automático para todo usuario autenticado. No se exige declarar campos ni se
convierte una lista ausente en deny-all: D8 sustituyó esas propuestas.

## 4. Arquitectura y límites de confianza

### Recorrido de usuario IAS

```text
OpenCode → autenticación mediante IAS del cliente
         → MCP valida el token y su pertenencia al tenant
         → asignación manual válida, si existe
           o un único rol derivado de grupos
         → restricción de entornos + política del entorno ∩ política del rol
         → SSFF mediante la cuenta técnica existente
```

Este recorrido expresa responsabilidades, **no prescribe endpoints ni una librería**.
Discovery, registro del cliente, tipo de token y mecanismo de validación deben
contrastarse con el IAS autorizado y la versión de OpenCode antes de implementar.

### Recorrido de clave API

```text
Clave API → resolución actual de tenant y entornos
          → políticas actuales del tenant/entorno → cuenta técnica → SSFF
```

Rechazar una identidad IAS no debe convertir su petición en acceso técnico ni
asignarla a un tenant por defecto. Las sesiones tampoco deben permitir cambiar
de usuario, tenant o método de autenticación para aprovechar permisos anteriores.
Son invariantes de seguridad derivadas de D1, D3, D9 y D10.

### Resolución del rol

| Situación tras validar identidad y tenant | Resultado |
|---|---|
| Existe asignación manual a rol declarado | Usar ese rol; no combinarlo con grupos |
| Existe asignación manual a rol inexistente | Denegar; no recurrir a grupos |
| No existe asignación manual; grupos corresponden a un único rol distinto | Usar ese rol |
| No existe asignación manual; varios grupos corresponden al mismo rol | Un único rol efectivo, no una unión de roles |
| No existe asignación manual; grupos corresponden a varios roles distintos | Denegar por ambigüedad |
| No existe asignación manual ni rol reconocido por grupos | Denegar |

El rol técnico no es una excepción en este algoritmo. Al retirar su asignación
manual, vuelve a aplicarse el mapeo de grupos en la siguiente petición.

## 5. Modelo de configuración y estado

El archivo de cada tenant contendrá la confianza IAS, sus roles, el mapeo de
grupos y las asignaciones manuales. Los roles contienen alcance de entornos y sus
propias `entityAllowlist`/`entityDenylist`, usando las entradas existentes con `fields`.

**Contrato conceptual, no esquema JSON aprobado:** los nombres finales de claves,
la representación de usuarios y la asociación entre endpoint, issuer y tenant
quedan pendientes del diseño técnico. No se introducen placeholders operativos.

La identidad manual necesita un identificador estable, no un nombre visible o
correo. **Propuesta técnica pendiente de validar:** identidad compuesta por el
issuer configurado y el subject validado del token, vinculada al tenant.

### Composición de permisos

1. Resolver las políticas actuales de tenant/entorno sin cambiar su semántica de override.
2. Comprobar que el rol permite el entorno solicitado.
3. Permitir una entidad solo si las políticas de entorno **y** rol la permiten;
   una denylist de cualquiera de las dos capas deniega.
4. Para campos, aplicar ambas restricciones: una propiedad debe estar permitida
   por las dos capas. Conservar las claves siempre legibles y la redacción/degradación
   XML del contrato existente.

Una allowlist vacía/ausente o `fields` vacío/ausente **no acota en esa capa**;
no elimina restricciones de la otra. No se debe representar una intersección
vacía como `[]` y pasarla a un helper que interpreta `[]` como acceso sin acotar.
Este es un riesgo de implementación, no una nueva semántica para el operador.

### Estado de sesión

La sesión no congela permisos ni prolonga la autenticación. Cada petición necesita
identidad válida y política actual. Los cambios locales se aplican en la siguiente
petición; los grupos del IdP se actualizan cuando se presenta un token actualizado.
No se promete revocación instantánea de grupos ni se fija una estrategia de refresh.

## 6. Requisitos funcionales

`MUST`, `MUST NOT`, `SHOULD` y `MAY` se interpretan según RFC 2119.
La numeración FR es local a este PRD.

| ID | Requisito | Fuente |
|---|---|---|
| FR-01 | El modo hospedado MUST admitir identidad individual mediante el IAS propio del tenant; MUST vincular identidad validada y tenant sin tenant por defecto. | D1, D3 |
| FR-02 | Los roles MUST ser propios del tenant y permitir restringir entornos, entidades y campos. | D7 |
| FR-03 | El MCP MUST resolver grupos IAS a un único rol distinto mediante el mapeo en configuración; cero roles MUST denegar y varios distintos MUST rechazar por ambigüedad. | D2–D4 |
| FR-04 | El archivo de configuración MUST permitir asignar manualmente un rol a usuarios concretos; esa asignación MUST prevalecer sobre grupos hasta su retirada. | D5, D6 |
| FR-05 | Una asignación manual a un rol inexistente MUST denegar; MUST NOT recurrir a grupos para autorizar esa petición. | D12 |
| FR-06 | El rol técnico MUST ser un rol normal con permisos configurados, sin acceso automático para usuarios no asignados. | D3, D5, D8 |
| FR-07 | Los roles MUST reutilizar la semántica actual de `entityAllowlist`, `entityDenylist` y `fields`; MUST NOT introducir deny-all implícito por listas ausentes o vacías. | D8 |
| FR-08 | El permiso efectivo MUST respetar ambas políticas (entorno y rol); una denegación MUST prevalecer y ningún rol MUST ampliar el techo de entidades o campos del entorno. | D7, D8 |
| FR-09 | Las restricciones efectivas MUST aplicarse a las superficies existentes de consulta y descubrimiento, incluidas navegación, expand, batch, esquemas, redacción y XML, sin nuevos caminos que eludan la política. | D7, D8; reutilización del contrato existente |
| FR-10 | Las peticiones a SSFF MUST mantener las credenciales técnicas actuales; MUST NOT propagar la identidad IAS del usuario. | D9 |
| FR-11 | Las claves API MUST conservar resolución, scope y políticas actuales, sin exigir rol; STDIO MUST conservar su comportamiento. | D9, D10 |
| FR-12 | Cambios de roles, permisos y asignaciones manuales MUST aplicarse en la siguiente petición; al retirar una asignación MUST evaluarse de nuevo el mapeo de grupos. | D6, D13 |
| FR-13 | Una petición con token caducado MUST rechazarse aunque tenga sesión abierta, hasta presentar un token válido; los grupos MUST proceder de identidad validada, no de datos arbitrarios de la petición. | D1, D14 |
| FR-14 | Los cambios de grupos MUST reflejarse al presentar un token actualizado; MUST NOT prometerse actualización inmediata de grupos en tokens existentes. | D13 |
| FR-15 | Los logs de operaciones IAS MUST incluir tenant, identificador técnico de usuario, rol efectivo y operación; MUST NOT registrar nombres, correos, tokens ni contenido de registros. En rechazos sin rol MUST NOT inventarse uno. | D15; protección de credenciales |
| FR-16 | OpenCode MUST ser el primer cliente de aceptación real. El acceso al IAS existente MUST esperar autorización explícita; tenerlo disponible MUST NOT interpretarse como permiso. | D11 |

## 7. Seguridad y amenazas

| Amenaza | Invariante / verificación |
|---|---|
| Token de otro issuer o tenant, inválido o caducado | Validación antes de autorizar; rechazo sin consultas de negocio a SSFF (FR-01, FR-13) |
| Grupos no confiables o roles ambiguos | Claims validados y un rol efectivo, sin elección arbitraria (FR-03) |
| Asignación manual obsoleta abre acceso por fallback | Referencia inválida deniega (FR-05) |
| Un rol amplía los permisos base o una intersección vacía abre acceso | Evaluar ambas capas y probar denegación efectiva (FR-08, FR-09) |
| Caché, cursor o sesión reutilizados entre identidades | No reutilizar resultados autorizados de otro usuario/tenant ni eludir la política actual (FR-01, FR-09, FR-12) |
| Configuración inválida se interpreta como acceso sin restricciones | Rechazar la operación afectada; nunca degradar silenciosamente la política (FR-03, FR-05, FR-08) |
| Logs revelan credenciales o datos personales | Inspección de logs con tokens y datos sintéticos (FR-15) |
| Se elimina la restricción de un grupo, pero queda un token válido anterior | Límite conocido de frescura; sin promesa de revocación inmediata (FR-14) |

Validar issuer, destinatario del token y autenticidad es necesario para FR-01.
**Pendiente técnico:** confirmar audience/resource, formato de access token y si
corresponde validación JWT/JWKS o introspección. No se acepta un ID token como
access token por conveniencia; la integración debe demostrar el contrato correcto.

## 8. Verificación y aceptación

Esta sección define pruebas futuras; **ninguna se ha ejecutado para Fase 3**.

### Niveles y activadores

| Nivel | Prueba | Activador y condición de aceptación |
|---|---|---|
| V1 | Tests deterministas de configuración, selección de rol, composición y HTTP con IdP/SSFF simulados | Cada cambio en identidad, políticas, sesiones, logs o configuración; suite y pruebas focalizadas verdes |
| V2 | Smoke versionado en entorno limpio, HOME y config temporales fuera del repositorio, dos IAS simulados y SSFF simulado | Cada cambio de integración o recorrido documentado; ejecutar pasos publicados sin secretos ni estado heredado; salida y datos observables comprobados |
| V3 | UAT de una persona con OpenCode e IAS real autorizado | Antes de declarar entregada la integración y cuando cambie el login documentado; registrar versiones, resultados, duración y fricciones sin tokens |

V2 no accede a IAS corporativo ni SAP real. V3 requiere autorización para destino,
operación y cuenta/sesión; si no existe, queda **pendiente**, no aprobado por un mock.
No hay un presupuesto de latencia confirmado: se mide la duración, no se inventa un SLA.

### Escenarios de aceptación

```gherkin
Scenario: A — Login individual desde OpenCode [V2+V3]
  Given un tenant con IAS configurado y un usuario con un único rol reconocido
  When el usuario conecta OpenCode siguiendo únicamente la guía publicada
  Then puede consultar solo los entornos, entidades y campos efectivos de ese rol
  And SSFF recibe la autenticación de la cuenta técnica, no la identidad del usuario

Scenario: B — Selección inequívoca de rol [V1+V2]
  Given usuarios sin rol, con un rol y con dos roles distintos derivados de grupos
  When realizan una consulta autenticada
  Then solo el usuario con un rol tiene acceso
  And dos grupos que mapean al mismo rol producen un solo rol efectivo
  And los rechazos no envían consultas de negocio a SSFF

Scenario: C — Asignación manual técnica [V1+V2+V3]
  Given un usuario con rol técnico manual y otro rol derivado de grupos
  When consulta datos
  Then solo se aplica el rol manual
  When se retira la asignación manual
  Then la siguiente petición evalúa el rol de grupos
  When existe una asignación manual a un rol eliminado
  Then se deniega sin fallback a grupos

Scenario: D — Techo de permisos y listas existentes [V1+V2]
  Given políticas de entorno y rol con entidades y campos distintos
  When se consultan datos y esquemas por las superficies existentes
  Then ninguna capa amplía lo permitido por la otra
  And las denylists prevalecen y una intersección vacía no abre acceso
  And listas o fields ausentes o vacíos conservan su semántica de no acotar esa capa
  And claves legibles, redacción y degradación XML conservan el contrato existente

Scenario: E — Configuración viva, caducidad y grupos [V1+V2+V3]
  Given una sesión de usuario abierta
  When cambia su política local
  Then la siguiente petición usa la nueva política
  When caduca su access token
  Then la siguiente petición se rechaza hasta presentar un token válido
  When presenta un token actualizado con grupos diferentes
  Then se vuelve a resolver su rol respetando la precedencia manual

Scenario: F — Aislamiento y credenciales inválidas [V1+V2]
  Given dos tenants con IAS y sujetos sintéticos que pueden compartir nombres de rol
  When se presentan credenciales inválidas o se intenta reutilizar una sesión de otra identidad
  Then no se obtiene acceso a datos o políticas del otro tenant o usuario
  And una identidad IAS rechazada no obtiene acceso técnico por fallback

Scenario: G — Compatibilidad de acceso técnico [V1+V2]
  Given las configuraciones de claves API y STDIO que funcionan antes del cambio
  When se ejecutan las mismas operaciones documentadas
  Then conservan sus resultados, alcance de entornos y permisos sin exigir roles

Scenario: H — Auditoría sin contenido sensible [V1+V2+V3]
  Given operaciones IAS permitidas y rechazadas con datos sintéticos reconocibles
  When se inspeccionan los logs emitidos
  Then las operaciones atribuibles incluyen tenant, identificador técnico, rol efectivo y operación
  And no aparecen tokens, nombres, correos ni contenido de registros
  And no se inventa un rol en los rechazos que no han resuelto ninguno
```

### Matriz FR → verificación

| FR | V1 | V2 | V3 | Escenarios |
|---|---|---|---|---|
| FR-01 | ✓ | ✓ | ✓ | A, F |
| FR-02 | ✓ | ✓ | ✓ | A, D |
| FR-03 | ✓ | ✓ | — | B |
| FR-04 | ✓ | ✓ | ✓ | C |
| FR-05 | ✓ | ✓ | — | C |
| FR-06 | ✓ | ✓ | ✓ | B, C |
| FR-07 | ✓ | ✓ | — | D |
| FR-08 | ✓ | ✓ | — | D |
| FR-09 | ✓ | ✓ | — | D, F |
| FR-10 | ✓ | ✓ | ✓ | A, G |
| FR-11 | ✓ | ✓ | — | G |
| FR-12 | ✓ | ✓ | ✓ | C, E |
| FR-13 | ✓ | ✓ | ✓ | E, F |
| FR-14 | ✓ | ✓ | ✓ | E |
| FR-15 | ✓ | ✓ | ✓ | H |
| FR-16 | — | ✓ | ✓ | A; permiso explícito previo a V3 |

### Métricas de éxito

- Un login real desde OpenCode seguido de una lectura permitida y una denegada.
- Cero consultas de negocio tras rechazo de identidad o autorización en los escenarios negativos.
- Cero ampliaciones de permisos respecto al techo del entorno.
- Cero regresiones observables en los recorridos existentes de claves API y STDIO.
- V1 y V2 reproducibles; V3 documentado antes de declarar la integración entregada.

## 9. Validaciones pendientes y siguiente paso

Las decisiones de producto anteriores están confirmadas. Lo siguiente es evidencia
técnica pendiente, no permiso para investigar remotamente:

| ID | Pendiente | Consecuencia |
|---|---|---|
| P1 | Permiso para usar el IAS disponible: destino, operaciones y cuenta/sesión | Bloquea cualquier acceso real, incluido discovery |
| P2 | Metadata de autorización, PKCE, registro del cliente, redirects y soporte de OpenCode | Determina el recorrido de login; no se asume CIMD/DCR ni que haga falta un proxy |
| P3 | Formato de access token, issuer, audience/resource, validación y disponibilidad del claim de grupos | Bloquea el diseño final del validador y del mapeo |
| P4 | Vinculación tenant/issuer, identificación estable para asignaciones y separación segura entre claves API y tokens IAS | Bloquea el contrato final de configuración y autenticación |
| P5 | Esquema JSON, errores públicos y compatibilidad del flujo MCP con IAS | Requiere diseño técnico respaldado por P2–P4, sin rellenar huecos con endpoints supuestos |

No se da por verificada la afirmación histórica del roadmap sobre versiones de
MCP, deprecación de DCR o compatibilidad de IAS con CIMD. Debe contrastarse con
documentación vigente y con el tenant autorizado antes de elegir la solución.

**Siguiente paso:** revisar este DRAFT; después autorizar por separado la validación
técnica o la implementación. No desplegar ni modificar IAS para completar el documento.
