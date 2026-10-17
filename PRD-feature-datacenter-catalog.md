# PRD: Catálogo Precargado de Data Centers de SAP SuccessFactors

| Metadato | Valor |
|---|---|
| **Documento** | PRD-feature-datacenter-catalog.md |
| **Versión** | v1.0.0 |
| **Estado** | PROPUESTO / LISTO PARA REVISIÓN (Ready for Review) |
| **Fecha** | 2026-10-15 |
| **Componente** | `ssff-mcp` (Configuración, Wizard `init`, Validación de Entorno) |
| **Autor / Arquitectura** | AI Engineering & SuccessFactors Architecture Team |
| **Alineación previa** | `PRD.md` (D-01..D-25), `PRD-phase2.md` (D-26..D-32), `PRD-phase3.md` (D-33..D-44), `PRD-phase4.md` (D-45..D-52), `archive/PRD-feature-custom-mdf.md` (D-62..D-70), `archive/PRD-feature-inspect-entity.md` (D-80..D-81). Este documento arranca en **D-82 / FR-108**. |

---

## 1. Resumen Ejecutivo y Objetivos

### 1.1 Visión General
Actualmente, `ssff-mcp` requiere que el usuario introduzca manualmente la URL base completa de su instancia OData (`baseUrl`, ej. `https://api2.successfactors.eu` o `https://api44.sapsf.com`) tanto en el archivo de configuración `~/.config/ssff-mcp/config.json` como durante el asistente interactivo de inicialización `ssff-mcp init` (D-45).

En entornos corporativos reales, los administradores y consultores de SAP SuccessFactors rara vez memorizan las URLs técnicas exactas de los endpoints de API; conocen su **código de Data Center** (ej. `"DC2"`, `"DC4"`, `"DC12"`, `"DC55"`) o su **región geográfica** (ej. *"Europe (Amsterdam) - DC2"* o *"US East (Ashburn) - DC4"*). Esto provoca fricciones recurrentes durante el onboarding:
1. **Confusión entre URL de login web y URL de API**: Usuarios que introducen la URL del portal web (`https://performancemanager.successfactors.eu` o `https://pmsalesdemo8.successfactors.com`) en lugar del endpoint OData (`api2.successfactors.eu`), desencadenando errores HTTP 404/401 difíciles de depurar.
2. **Duplicación en OAuth**: Cuando se configura autenticación OAuth 2.0 (D-27), el usuario debe reescribir la URL del token (`tokenUrl`), que casi siempre es `https://<apiHost>/oauth/token` derivada del mismo Data Center.
3. **Pérdida de tiempo en lookup**: Consultores que deben salir de la terminal o de Claude para buscar tablas de correspondencia de SAP en la documentación oficial.

La feature de **Catálogo Precargado de Data Centers de SAP** introduce un catálogo estático, validado y de cero dependencias con los **21+ Data Centers oficiales de SAP SuccessFactors** (Production y Preview/SalesDemo), soporte para la propiedad `dataCenter` en la configuración, derivación automática de `tokenUrl` para OAuth y asistencia interactiva de autocompletado en el comando `init`.

### 1.2 Objetivos Clave (OKRs)
* **Cero fricción en onboarding**: Permitir configurar un entorno en `init` seleccionando el Data Center en un menú interactivo con búsqueda difusa, reduciendo el tiempo de configuración en >60%.
* **Sintaxis simplificada**: Admitir el atributo `dataCenter: "DC2"` en `config.json`, resolviendo automáticamente `baseUrl` y `tokenUrl` sin intervención manual.
* **Detección preventiva de errores**: Detectar automáticamente si el usuario introduce URLs del portal web de SuccessFactors y sugerir/corregir el Data Center API correspondiente antes de persistir la configuración.
* **Cero coste de red y cero dependencias**: El catálogo es 100% estático y embebido en el bundle, requiriendo 0 llamadas de red para resolver un Data Center.
* **Compatibilidad hacia atrás 100%**: Cualquier configuración existente que declare `baseUrl` explícito sigue funcionando de forma idéntica e inmutable (D-02/D-45).

---

## 2. Registro de Decisiones de Arquitectura (Ledger)

| ID | Decisión | Origen / Justificación |
|---|---|---|
| **D-82** | **Catálogo Estático Embebido (`src/datacenters.ts`)**: Se define una tabla tipada en TypeScript con los 21+ Data Centers oficiales de SAP SuccessFactors, incluyendo código canónico, nombre descriptivo de región, entorno (Production vs Preview), hostname de API OData v2 y URL estándar del endpoint OAuth. | Garantiza resolución instantánea (0 ms), funcionamiento offline e inmunidad a caídas de servicios externos. |
| **D-83** | **Atributo `dataCenter` opcional en Esquema de Entorno**: El esquema Zod de entorno (`EnvironmentConfigSchema`) añade el campo opcional `dataCenter: z.string().optional()`. Si `baseUrl` está ausente pero `dataCenter` está presente, `baseUrl` se hidrata dinámicamente en tiempo de carga con el `apiBaseUrl` del catálogo. | Mantiene `baseUrl` como la propiedad interna canónica, permitiendo configuraciones mucho más concisas y legibles. |
| **D-84** | **Precedencia de `baseUrl` sobre `dataCenter`**: Si un entorno define **ambos** (`baseUrl` y `dataCenter`), `baseUrl` tiene precedencia absoluta. Si `baseUrl` difiere del catálogo para ese `dataCenter`, se emite una advertencia informativa en `stderr` pero no se interrumpe la ejecución. | Permite a clientes empresariales con proxies reversos, firewalls corporativos o API Gateways intermedios usar un hostname personalizado sin perder el metadato del Data Center. |
| **D-85** | **Derivación Automática de `tokenUrl` en OAuth 2.0 (D-27)**: Si la autenticación es `type: "oauth"` y se omite `tokenUrl`, el servidor deriva automáticamente `tokenUrl = "${baseUrl}/oauth/token"` (o la URL específica del catálogo de ese DC). | Elimina la necesidad redundante de escribir `tokenUrl` en el 99% de las configuraciones OAuth corporativas. |
| **D-86** | **Menú Interactivo en Wizard `init` (D-45)**: El paso de solicitud de URL en `ssff-mcp init` ofrece una lista interactiva de Data Centers agrupados por región (EMEA, NA, APJ, etc.) con opción de búsqueda libre, además de la opción `"Introducir URL personalizada / On-Premise Gateway"`. | Experiencia de usuario de primer nivel para usuarios de terminal, alineada con la Fase 4. |
| **D-87** | **Detector Preventivo de URLs de Portal Web**: Si el usuario introduce manualmente un host coincidente con patrones de UI de SuccessFactors (ej. `*.successfactors.eu`, `performancemanager*.successfactors.com`, `pmsalesdemo*.successfactors.com`), el sistema alerta: *"Parece una URL de acceso web, el endpoint de API para este Data Center suele ser apiX.successfactors..."* y ofrece autotransformar la URL. | Resuelve la causa nº 1 de tickets de soporte y fallos de conexión en clientes iniciales. |
| **D-88** | **Soporte en Modo Inline (`--datacenter` / `--dc`)**: El modo inline (D-45, D-52) incorpora los flags `--datacenter <code\>` y `--dc <code\>` como alternativa directa a `--inline-url`. | Permite lanzar el servidor en terminal con comandos limpios como: `ssff-mcp --dc DC2 --inline-auth basic:user:pass`. |

---

## 3. Especificación del Catálogo de Data Centers

### 3.1 Estructura de Datos (`DataCenterDefinition`)

```typescript
export interface DataCenterDefinition {
  /** Código unívoco canónico del Data Center (ej. "DC2", "DC4", "DC12", "DC55") */
  code: string;
  /** Nombre descriptivo de la ubicación y región */
  name: string;
  /** Región macro (EMEA, NA, APJ, LatAm, Public Cloud) */
  region: 'EMEA' | 'NA' | 'APJ' | 'LATAM' | 'GOV';
  /** Tipo de entorno: producción o preview/staging */
  environmentType: 'production' | 'preview';
  /** Hostname canónico del endpoint API OData (ej. "api2.successfactors.eu") */
  apiHost: string;
  /** URL base OData v2 completa (ej. "https://api2.successfactors.eu") */
  apiBaseUrl: string;
  /** Endpoint canónico de obtención de tokens OAuth 2.0 SAML Assertion */
  oauthTokenUrl: string;
  /** Dominios web típicos asociados a este DC (para detección heurística) */
  webPortalDomains: string[];
}
```

### 3.2 Tabla Canónica de Data Centers de SAP SuccessFactors

| Código | Región / Ubicación | Tipo | Hostname API | Web Portal Patterns |
|---|---|---|---|---|
| `DC2` | Europe (Amsterdam, Países Bajos) | Production | `api2.successfactors.eu` | `performancemanager.successfactors.eu` |
| `DC4` | US East (Ashburn, VA, EE.UU.) | Production | `api4.successfactors.com` | `performancemanager4.successfactors.com` |
| `DC8` | US East (Ashburn - Staging/Preview) | Preview | `api8.successfactors.com` | `performancemanager8.successfactors.com` |
| `DC10` | US West (Sydney / Australia) | Production | `api10.successfactors.com` | `performancemanager10.successfactors.com` |
| `DC12` | Europe (Frankfurt, Alemania) | Production | `api12.successfactors.eu` | `performancemanager12.successfactors.eu` |
| `DC15` | China (Shanghai) | Production | `api15.sapsf.cn` | `performancemanager15.sapsf.cn` |
| `DC17` | Canada (Toronto) | Production | `api17.sapsf.com` | `performancemanager17.sapsf.com` |
| `DC18` | Europe (Rot, Alemania - Preview) | Preview | `api18.sapsf.eu` | `performancemanager18.sapsf.eu` |
| `DC19` | Latin America (São Paulo, Brasil) | Production | `api19.sapsf.com` | `performancemanager19.sapsf.com` |
| `DC22` | Middle East (Riyadh, Arabia Saudí) | Production | `api22.sapsf.com` | `performancemanager22.sapsf.com` |
| `DC23` | APJ (Tokyo, Japón) | Production | `api23.sapsf.com` | `performancemanager23.sapsf.com` |
| `DC44` | Europe (Frankfurt, Cloud Hyperscaler) | Production | `api44.sapsf.com` | `performancemanager44.sapsf.com` |
| `DC55` | Europe (Amsterdam, Cloud Hyperscaler) | Production | `api55.sapsf.eu` | `performancemanager55.sapsf.eu` |
| `DC68` | US Central (Preview Hyperscaler) | Preview | `api68sales.sapsf.com` | `pmsalesdemo8.successfactors.com` |
| *Otros* | *Resto de DCs oficiales de SAP (DC20, DC25, DC27, DC41, etc.)* | ... | ... | ... |

---

## 4. Requisitos Funcionales (FR)

* **FR-108 (MUST)**: El paquete DEBE exportar la constante inmutable `SAP_DATA_CENTERS: Record<string, DataCenterDefinition>` y la función auxiliar de resolución `resolveDataCenter(identifier: string): DataCenterDefinition | undefined`, capaz de buscar de forma insensible a mayúsculas por código (`"dc2"`, `"DC2"`), hostname (`"api2.successfactors.eu"`) o fragmento unívoco.
* **FR-109 (MUST)**: En `config.json`, un objeto de entorno PUEDE especificar `dataCenter` en sustitución de `baseUrl`. Si `baseUrl` no se proporciona, la configuración normalizada DEBE poblar `baseUrl` con el `apiBaseUrl` correspondiente al Data Center.
* **FR-110 (MUST)**: Si se especifica un `dataCenter` cuyo código no existe en el catálogo estático y no se acompaña de `baseUrl`, la validación de configuración DEBE fallar inmediatamente con un error saneado `INVALID_CONFIG` indicando la lista de Data Centers soportados.
* **FR-111 (MUST)**: Cuando un entorno defina `auth.type === "oauth"` y se omita `auth.tokenUrl`, el cargador de configuración DEBE derivar automáticamente el endpoint del token como `"${baseUrl}/oauth/token"` sin requerir configuración manual.
* **FR-112 (MUST)**: El asistente interactivo `ssff-mcp init` DEBE presentar una opción de selección de Data Center antes o junto a la entrada libre de URL. La selección de un Data Center conocido DEBE autorellenar la URL base sin que el usuario deba teclearla.
* **FR-113 (MUST)**: Si el usuario introduce en el wizard `init` o en el flag `--inline-url` una URL que contenga patrones conocidos de portal web (ej. `performancemanager` o subdominios web registrados en `webPortalDomains`), el sistema DEBE emitir una advertencia explicativa sugiriendo el endpoint de API equivalente y pidiendo confirmación.
* **FR-114 (MUST)**: El comando CLI en modo inline DEBE admitir `--datacenter <code\>` (y su alias `-d` / `--dc`), mutuamente excluyente con `--inline-url` (o con precedencia clara de `--inline-url` si se pasan ambos con advertencia).
* **FR-115 (SHOULD)**: La herramienta existente `list_environments` DEBE reflejar en su respuesta el campo informativo opcional `dataCenter: string` cuando el entorno haya sido configurado a través de dicho código.

---

## 5. Diseño Técnico e Implementación

### 5.1 Ubicación de Archivos
* **`src/datacenters.ts`**: Definición tipada de la interfaz, tabla de Data Centers, expresiones regulares de portales web y funciones de búsqueda/resolución.
* **`src/config.ts`**: Actualización de esquemas Zod (`EnvironmentConfigSchema`), lógica de hidratación de `baseUrl` y derivación de `tokenUrl`.
* **`src/init.ts`**: Integración en el asistente CLI `@inquirer/prompts` para selección con filtro difuso.
* **`src/cli.ts`**: Soporte de flags `--datacenter` / `--dc`.

### 5.2 Esquema Zod Actualizado en `src/config.ts`

```typescript
export const EnvironmentConfigSchema = z.object({
  dataCenter: z.string().trim().toUpperCase().optional(),
  baseUrl: z.string().url().optional(),
  auth: AuthConfigSchema,
  entityAllowlist: z.array(z.string()).optional(),
  defaultLocale: z.string().optional(),
}).refine(
  (data) => Boolean(data.baseUrl || data.dataCenter),
  { message: "El entorno debe definir al menos 'baseUrl' o 'dataCenter'." }
);
```

---

## 6. Consideraciones de Seguridad y Compliance (DS)

* **DS-DC-01 (Offline & Static)**: El catálogo no realiza telemetría, consultas DNS previas ni llamadas HTTP a SAP para comprobar la existencia del Data Center.
* **DS-DC-02 (Cero Inyección en URLs)**: Al derivar `baseUrl` y `tokenUrl` desde el catálogo estático interno, se elimina el riesgo de inyecciones de host o desvíos accidentales a servidores maliciosos por typos del usuario.
* **DS-DC-03 (Sanitización en Logs)**: El código del Data Center (`DC2`, etc.) es considerado metadato no confidencial y puede emitirse en logs de diagnóstico de auditoría (`stderr`), pero las credenciales asociadas siguen estando estrictamente censuradas de acuerdo con RFC 5424 y D-08.

---

## 7. Plan de Pruebas y Validación

1. **Unit Tests (`test/datacenters.test.ts`)**:
   - Resolución exacta por código (`DC2` -> `api2.successfactors.eu`).
   - Resolución insensible a mayúsculas/minúsculas (`dc4` -> `api4.successfactors.com`).
   - Detección de patrones web (`performancemanager.successfactors.eu` -> sugiere `DC2`).
   - Error ante código desconocido sin `baseUrl`.
2. **Config Tests (`test/config-datacenter.test.ts`)**:
   - Carga de `config.json` con solo `dataCenter` hidrata `baseUrl` correctamente.
   - Derivación automática de `tokenUrl` en auth OAuth 2.0.
   - Precedencia de `baseUrl` manual si ambos están definidos.
3. **CLI & Init Tests (`test/init-datacenter.test.ts`)**:
   - Comprobación de que `--dc DC2` en modo inline arranca el servidor apuntando a `api2.successfactors.eu`.

---

## 8. Estimación de Esfuerzo

* **Complejidad:** Baja (0 dependencias externas, lógica pura de mapeo y configuración).
* **Story Points:** 5 SP.
* **Tiempo Estimado:** 2 a 3 días laborables.
