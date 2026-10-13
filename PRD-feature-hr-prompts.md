# Product Requirement Document (PRD): MCP Prompts de Recursos Humanos (Pre-packaged HR Workflows) para ssff-mcp

- **Estado:** Ready for Review / RFC (Request for Comments)
- **Versión:** 1.0.0
- **Fecha:** Octubre 2026
- **Componente:** `ssff-mcp` (SAP SuccessFactors OData v2 MCP Server)
- **Autor / Arquitectura:** AI Engineering & HR Integration Architecture Team
- **Target SDK:** `@modelcontextprotocol/sdk` (v1.18.0+) / Node.js >= 20 / TypeScript 5.6+

---

## 1. Resumen Ejecutivo y Objetivos

### 1.1 Visión General
`ssff-mcp` proporciona actualmente una interfaz de bajo nivel, segura y de solo lectura para interactuar con SAP SuccessFactors a través de herramientas atómicas (`list_environments`, `get_metadata`, `query_entity`, `batch_get`) y recursos de catálogo (`sf://{env}/overview`, `sf://{env}/entities`, `sf://{env}/entities/{entitySet}`).

Si bien estas herramientas permiten interactuar con cualquier entidad de SuccessFactors, los modelos de lenguaje (LLMs) y los usuarios humanos a menudo carecen del conocimiento contextual profundo sobre:
1. El modelo relacional complejo de Employee Central (EC) y Foundation Objects (FO).
2. Las particularidades temporales de SuccessFactors (effective-dating, `effectiveLatestChange`, `asOfDate`).
3. La optimización de queries para prevenir cuellos de botella (usar `$select` específico, prevenir waterfalls N+1 mediante `batch_get`).
4. Las mejores prácticas para auditorías de permisos basados en roles (RBP).

La feature de **MCP Prompts de HR** introduce un catálogo de flujos de trabajo preempaquetados de alto valor para RRHH que guían a los modelos de lenguaje mediante instrucciones rectoras, plantillas estandarizadas y estrategias de consulta preoptimizadas, transformando `ssff-mcp` de un conector OData en un asistente de RRHH enterprise.

### 1.2 Objetivos Clave (OKRs)
- **Estandarización:** Implementar la especificación nativa de MCP Prompts (`prompts/list` y `prompts/get`) aprovechando las capacidades del SDK de MCP ya presente en el proyecto.
- **Catálogo Core:** Preempaquetar 4 flujos esenciales (`audit_user_permissions`, `org_chart_subtree`, `employee_full_profile`, `headcount_summary_by_department`) y 4 flujos avanzados complementarios.
- **Seguridad y Gobernanza:** Garantizar compatibilidad estricta (fail-closed) con `entityAllowlist`. Si un prompt requiere entidades restringidas, la ejecución debe denegarse de manera segura antes de despachar tráfico o instrucciones.
- **Eficiencia OData:** Promover en los prompts el uso preferente de `batch_get` (con límite de 180 peticiones por lote) frente a múltiples peticiones secuenciales, mitigando latencia y consumo de cuota API.
- **Cero Dependencias Externas:** No añadir dependencias adicionales a `package.json`; utilizar `@modelcontextprotocol/sdk` y `zod` existentes.

---

## 2. Especificación del Estándar MCP para Prompts y Compatibilidad de Clientes

### 2.1 El Protocolo JSON-RPC 2.0 para Prompts
El Model Context Protocol define el ciclo de vida de los prompts mediante dos métodos principales y una notificación opcional:

#### A. Descubrimiento: `prompts/list`
- **Request:**
  ```json
  {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "prompts/list",
    "params": {
      "cursor": "optional-pagination-token"
    }
  }
  ```
- **Response:**
  ```json
  {
    "jsonrpc": "2.0",
    "id": 1,
    "result": {
      "prompts": [
        {
          "name": "employee_full_profile",
          "title": "Employee 360° Profile",
          "description": "Compiles a comprehensive 360-degree employee profile using EmpEmployment, EmpJob, PerPersonal, and User.",
          "arguments": [
            {
              "name": "userId",
              "description": "Target employee user ID",
              "required": true
            },
            {
              "name": "environment",
              "description": "Environment alias configured in ssff-mcp",
              "required": false
            }
          ]
        }
      ]
    }
  }
  ```
- **Capacidades:** El servidor anuncia `capabilities: { prompts: { listChanged: true } }` durante el handshake `initialize`.

#### B. Ejecución: `prompts/get`
- **Request:**
  ```json
  {
    "jsonrpc": "2.0",
    "id": 2,
    "method": "prompts/get",
    "params": {
      "name": "employee_full_profile",
      "arguments": {
        "userId": "100234",
        "environment": "production"
      }
    }
  }
  ```
- **Response:**
  ```json
  {
    "jsonrpc": "2.0",
    "id": 2,
    "result": {
      "description": "Complete profile extraction plan for user 100234",
      "messages": [
        {
          "role": "user",
          "content": {
            "type": "text",
            "text": "Act as an HR Operations Specialist. You are tasked with assembling a comprehensive 360° Employee Profile for userId: '100234'..."
          }
        }
      ]
    }
  }
  ```

### 2.2 Estructura y Semántica de Mensajes (`PromptMessage`)
- **Restricción de Rol:** La especificación estándar MCP define `Role = "user" | "assistant"`. **NO existe el rol `"system"` en el estándar oficial de MCP**.
- **Modelado de Instrucciones:** Las directivas rectoras para el LLM deben estructurarse dentro de un mensaje con `role: "user"`, utilizando formateo delimitado explícito (ej. `<system_context>`, `<instruction_plan>`, `<execution_rules>`).
- **Few-Shot Prompting:** Se pueden alternar mensajes `user` y `assistant` para guiar al modelo con ejemplos sintéticos de cómo invocar `query_entity` o `batch_get` y cómo estructurar el informe final.
- **Embedded Resources:** MCP permite incluir en `PromptMessage.content` objetos de tipo `resource`:
  ```json
  {
    "type": "resource",
    "resource": {
      "uri": "sf://production/entities/User",
      "mimeType": "application/json"
    }
  }
  ```
  Esto permite que un prompt adjunte directamente el catálogo o esquema de la entidad relevante para que el LLM lo conozca antes de ejecutar la primera llamada.

### 2.3 Matriz de Compatibilidad de Clientes MCP

| Cliente | Soporte de Prompts | Mecanismo de Interacción | Notas de Experiencia de Usuario |
| :--- | :---: | :--- | :--- |
| **Claude Desktop** | **Completo (Nativo)** | Slash commands (`/`) o menú desplegable de prompts en la barra de chat. | Abre un diálogo nativo modal solicitando argumentos requeridos y opcionales. Inyecta los mensajes directamente al chat. |
| **OpenCode** | **Completo (Nativo)** | Comandos en TUI (`/prompt <nombre>`) y vía Agent Client Protocol (ACP). | Permite autocompletado y paso de argumentos en línea (`/employee_full_profile userId=100234`). |
| **Zed** | **Completo (Nativo)** | Asistente de Zed mediante context servers / ACP. | Soporta invocación de plantillas con parámetros y auto-recarga de catálogo mediante `notifications/prompts/list_changed`. |
| **Cursor** | **Indirecto / No Nativo** | No dispone de menú nativo para slash commands de prompts MCP. | Soporta todas las **herramientas** (`query_entity`, `batch_get`). Los prompts se pueden mapear como instrucciones de proyecto (`.cursorrules`) o invocar como recetas de workflow. |
| **Codex / Pi** | **Parcial / Variable** | Depende del harness de integración / CLI wrapper. | Ejecutables de terminal que implementen MCP client pueden invocar `client.getPrompt` para inicializar sesiones de agente. |

---

## 3. Catálogo Detallado de HR Prompts Preempaquetados

### 3.1 Prompt 1: `audit_user_permissions`
- **Identificador:** `audit_user_permissions`
- **Título:** Audit User Role-Based Permissions (RBP)
- **Categoría:** Seguridad, Gobernanza y Cumplimiento (SOX / GDPR)
- **Entidades SuccessFactors Requeridas:** `User`, `RBPRole`, `RBPGroup`
- **Argumentos (Zod Schema):**
  ```typescript
  {
    environment: z.string().optional().describe("Configured environment alias"),
    userId: z.string().min(1).describe("Target SuccessFactors User ID to audit"),
    highlightAdmin: z.boolean().optional().describe("Whether to highlight administrative and high-privilege permissions (default true)"),
    checkSoD: z.boolean().optional().describe("Evaluate Segregation of Duties conflicts (default true)")
  }
  ```
- **Flujo de Ejecución Instruido al LLM:**
  1. *Fase 1:* Consultar datos del usuario mediante `query_entity`:
     `entityPath="User('${userId}')"`, `select="userId,username,status,title,department,division,email,hireDate"`.
  2. *Fase 2:* Consultar roles de permisos asociados (`RBPRole` con filtro o expansión).
  3. *Fase 3:* Inspeccionar grupos de permisos asignados (`RBPGroup`).
  4. *Fase 4:* Análisis crítico por el LLM:
     - Detección de cuentas inactivas con roles activos (`status eq 'f'` o inactivo con permisos vigentes).
     - Identificación de permisos de superusuario (`Manage Integration Tools`, `Employee Export`, acceso a contraseñas/seguridad).
     - Conflictos de SoD (ej. permiso para modificar nómina y aprobar pagos simultáneamente).

---

### 3.2 Prompt 2: `org_chart_subtree`
- **Identificador:** `org_chart_subtree`
- **Título:** Organization Hierarchy Subtree Extraction
- **Categoría:** Estructura Organizativa y Planificación de Plantilla
- **Entidades SuccessFactors Requeridas:** `EmpJob`, `User`
- **Argumentos (Zod Schema):**
  ```typescript
  {
    environment: z.string().optional().describe("Configured environment alias"),
    managerId: z.string().min(1).describe("Root manager User ID to traverse from"),
    maxDepth: z.number().int().min(1).max(4).optional().describe("Maximum tree depth (default 2, max 4)"),
    activeOnly: z.boolean().optional().describe("Include only active employee contracts (default true)")
  }
  ```
- **Estrategia Algorítmica con `batch_get` (BFS en Lotes):**
  - **Nivel 1 (Direct Reports):**
    Ejecutar una llamada a `query_entity`:
    ```
    entityPath: "EmpJob"
    filter: "managerId eq '${managerId}' and emplStatus eq 'A'"
    select: "userId,managerId,jobTitle,department,location"
    ```
  - **Nivel 2 (Subordinados Indirectos agrupados):**
    Tomar todos los `userId` obtenidos en el Nivel 1. Construir un array de peticiones para **`batch_get`** (una petición por cada manager del Nivel 1).
    Esto resuelve todo el segundo nivel en un único viaje de red HTTP, respetando el límite de 180 peticiones por batch y el techo de 1000 registros.
  - **Nivel 3+ (si `maxDepth > 2`):**
    Repetir la estrategia en batch con los nuevos líderes descubiertos.

---

### 3.3 Prompt 3: `employee_full_profile`
- **Identificador:** `employee_full_profile`
- **Título:** Employee 360° Comprehensive Profile
- **Categoría:** Operaciones de RRHH / Gestión del Talento
- **Entidades SuccessFactors Requeridas:** `User`, `EmpJob`, `PerPersonal`, `EmpEmployment`
- **Entidades Opcionales:** `PerEmail`, `PerPhone`, `EmpCompensation`
- **Argumentos (Zod Schema):**
  ```typescript
  {
    environment: z.string().optional().describe("Configured environment alias"),
    userId: z.string().min(1).describe("Target employee User ID"),
    asOfDate: z.string().optional().describe("Effective date snapshot in YYYY-MM-DD format (defaults to current date)"),
    includeCompensation: z.boolean().optional().describe("Whether to attempt reading compensation grade/data (default false)")
  }
  ```
- **Estrategia de Optimización OData v2:**
  - Instruir al LLM a ejecutar una única llamada a `batch_get` con consultas concurrentes de campos estrictamente seleccionados:
    1. `User('${userId}')` con `$select=userId,username,status,title,department,division,location,email,hireDate`.
    2. `EmpJob?$filter=userId eq '${userId}' and effectiveLatestChange eq true` con `$select=userId,jobTitle,department,division,location,managerId,payGrade,emplStatus,startDate`.
    3. `PerPersonal?$filter=personIdExternal eq '${userId}'` con `$select=personIdExternal,firstName,lastName,gender,maritalStatus,nationality,dateOfBirth`.
    4. `EmpEmployment?$filter=userId eq '${userId}'` con `$select=userId,startDate,endDate,seniorityDate,originalStartDate`.

---

### 3.4 Prompt 4: `headcount_summary_by_department`
- **Identificador:** `headcount_summary_by_department`
- **Título:** Headcount and Department Distribution Summary
- **Categoría:** Analítica de Personas (People Analytics) & Reporting Directivo
- **Entidades SuccessFactors Requeridas:** `FODepartment`, `EmpJob`
- **Argumentos (Zod Schema):**
  ```typescript
  {
    environment: z.string().optional().describe("Configured environment alias"),
    departmentCode: z.string().optional().describe("Specific department code to filter (optional, leave empty for all)"),
    status: z.enum(["active", "all"]).optional().describe("Filter active employees only or include suspended/terminated (default 'active')")
  }
  ```
- **Flujo de Ejecución Instruido al LLM:**
  1. *Fase 1 (Catálogo de Departamentos):* Consultar `FODepartment`:
     `entityPath="FODepartment"`, `filter="status eq 'A'"`, `select="externalCode,name,description"`.
  2. *Fase 2 (Censo de Empleados):* Consultar `EmpJob`:
     `entityPath="EmpJob"`, `filter="emplStatus eq 'A'"`, `select="userId,department,jobTitle"`, `inlinecount="allpages"`, `top=1000`.
  3. *Fase 3 (Agregación):* Cruzar en memoria `EmpJob.department` con `FODepartment.externalCode`.

---

## 4. Compatibilidad con `entityAllowlist` y Modelo de Seguridad Fail-Closed

1. **Metadata Declarativa:** Cada prompt define:
   - `requiredEntities: string[]` (Entidades indispensables).
   - `optionalEntities?: string[]` (Entidades adicionales opcionales).
2. **Evaluación Stateless por Petición:** En el callback de `prompts/get`:
   - Se carga la configuración fresca: `await loadFreshConfig(args.environment)`.
   - Se verifica cada entidad en `requiredEntities` con `isEntityAllowed(entityAllowlist, entity)`.
   - Si **cualquier entidad requerida es denegada**, se lanza inmediatamente:
     ```typescript
     throw new SanitizedError(
       "ENTITY_NOT_ALLOWED",
       `Prompt "${promptName}" requires entity "${entity}", which is not permitted by the configured entityAllowlist`,
     );
     ```
3. **Manejo de Entidades Opcionales:** Si una entidad de `optionalEntities` no está permitida, el prompt no se cancela, sino que inyecta en las instrucciones una directiva explícita indicando que esa entidad específica debe omitirse.

---

## 5. Diseño Técnico y Arquitectura de Software en `ssff-mcp`

### 5.1 Estructura Modular del Código
- **`src/prompts.ts`**: Contiene las definiciones de esquemas Zod, las plantillas de mensajes, la validación de allowlist y la función de registro de prompts.
- **`src/tools.ts`**: Llama a `registerHrPrompts(server, deps, loadFreshConfig)` tras registrar las herramientas y recursos.

### 5.2 Registro en `McpServer`
```typescript
export function registerHrPrompts(
  server: McpServer,
  loadFreshConfig: ConfigLoader,
): void {
  for (const promptDef of HR_PROMPTS_CATALOG) {
    server.registerPrompt(
      promptDef.name,
      {
        title: promptDef.title,
        description: `${promptDef.description} [Requires: ${promptDef.requiredEntities.join(", ")}]`,
        argsSchema: promptDef.argsSchema,
      },
      async (rawArgs) => {
        const args = rawArgs as Record<string, unknown>;
        const requestedEnv = typeof args.environment === "string" ? args.environment : undefined;
        
        const config = await loadFreshConfig(requestedEnv);
        
        for (const reqEntity of promptDef.requiredEntities) {
          if (!isEntityAllowed(config.entityAllowlist, reqEntity)) {
            throw new SanitizedError(
              "ENTITY_NOT_ALLOWED",
              `Prompt "${promptDef.name}" requires entity "${reqEntity}", which is not permitted by the configured entityAllowlist`,
            );
          }
        }

        const allowedOptional = (promptDef.optionalEntities ?? []).filter((optEntity) =>
          isEntityAllowed(config.entityAllowlist, optEntity),
        );

        const messages = promptDef.buildMessages(args, allowedOptional);

        return {
          description: promptDef.description,
          messages,
        };
      },
    );
  }
}
```

---

## 6. Evaluación de Esfuerzo, Estimación y Matriz de Riesgos

### 6.1 Estimación de Esfuerzo

| Tarea / Componente | Esfuerzo Estimado | Complejidad |
| :--- | :---: | :---: |
| **Spike & Arquitectura:** Diseño de `src/prompts.ts` e integración con `McpServer` | 1 día | Baja |
| **Core HR Prompts:** Implementación de `audit_user_permissions` y `org_chart_subtree` | 2 días | Media |
| **Core Profile & Headcount:** Implementación de `employee_full_profile` y `headcount_summary_by_department` | 2 días | Media |
| **Gobernanza Allowlist:** Integración fail-closed y manejo de entidades opcionales | 1 día | Baja |
| **Suite de Tests:** `test/prompts.test.ts` con cobertura exhaustiva | 2 días | Media |
| **TOTAL** | **8 días hábiles** | **Baja-Media** |

### 6.2 Matriz de Riesgos
* **Cero dependencias nuevas**: Se apoya 100% en el SDK de MCP y Zod existentes.
* **Cero riesgo de regresión en tools**: No modifica la lógica de ejecución de `query_entity` ni `batch_get`.
