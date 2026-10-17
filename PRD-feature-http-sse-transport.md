# PRD: Transporte Remoto HTTP / SSE y Despliegue Cloud (`ssff-mcp serve`)

| Metadato | Valor |
|---|---|
| **Documento** | PRD-feature-http-sse-transport.md |
| **Versión** | v1.0.0 |
| **Estado** | PROPUESTO / LISTO PARA REVISIÓN (Ready for Review) |
| **Fecha** | 2026-10-15 |
| **Componente** | `ssff-mcp` (Capa de Transporte, Servidor HTTP/SSE, Despliegue en Contenedores) |
| **Autor / Arquitectura** | AI Engineering & Cloud Infrastructure Architecture Team |
| **Alineación previa** | `PRD.md` (D-01..D-25), `PRD-phase2.md` (D-26..D-32), `PRD-phase3.md` (D-33..D-44), `PRD-phase4.md` (D-45..D-52), `archive/PRD-feature-inspect-entity.md` (D-80..D-81), `PRD-feature-datacenter-catalog.md` (D-82..D-88), `PRD-feature-compare-environments.md` (D-89..D-96). Este documento arranca en **D-97 / FR-127**. |

---

## 1. Resumen Ejecutivo y Objetivos

### 1.1 Visión General
Actualmente, `ssff-mcp` está diseñado y opera como un proceso de terminal local basado exclusivamente en transporte estándar de entrada/salida (`stdio`). Para utilizarlo, cada analista de RRHH, consultor o ingeniero debe contar con un entorno Node.js instalado localmente en su estación de trabajo, descargar o compilar el servidor, y mantener un archivo local `config.json` con credenciales de acceso o claves privadas a SAP SuccessFactors.

En entornos corporativos y grandes organizaciones, este modelo descentralizado presenta importantes barreras operativas y de seguridad:
1. **Políticas de Seguridad en Endpoint**: Los departamentos de CISO y Seguridad prohíben la presencia de credenciales técnicas o certificados corporativos de SAP en los portátiles de los empleados.
2. **Restricciones de Red e IPs Autorizadas**: Las instancias de SAP SuccessFactors frecuentemente configuran restricciones de acceso por lista blanca de IPs (*IP Whitelisting* / *Trust Centers*). Si los usuarios se conectan desde sus hogares o redes Wi-Fi dinámicas, las peticiones OData son rechazadas por SAP.
3. **Mantenimiento y Fricción de Onboarding**: Actualizar el servidor MCP, las versiones de Node.js o rotar credenciales exige actualizar individualmente el puesto de cada usuario.

La feature de **Transporte Remoto HTTP / Server-Sent Events (SSE)** transforma `ssff-mcp` en un servicio centralizado de nivel empresarial. Permite ejecutar el servidor dentro de un contenedor Docker en infraestructuras gestionadas como **Google Cloud Run**, **AWS ECS / Fargate**, **Azure Container Apps** o clusters de **Kubernetes**, operando con una IP estática de salida corporativa autorizada en SAP. Los clientes MCP (como Claude Desktop, Cursor, OpenCode, LibreChat o asistentes web internos) se conectan mediante una simple URL segura (`https://ssff-mcp.internal.corp/sse`) protegida por API Key.

### 1.2 Objetivos Clave (OKRs)
* **Soporte Oficial de Transporte MCP SSE**: Implementar el transporte nativo Server-Sent Events (`SSEServerTransport` de `@modelcontextprotocol/sdk`), gestionando los endpoints estándar `GET /sse` y `POST /message`.
* **Seguridad de Acceso Centralizada**: Autenticación perimetral obligatoria mediante API Key (`MCP_API_KEY` con soporte de cabeceras `Authorization: Bearer <key>` y `X-API-Key: <key>`), con validación en tiempo constante (`crypto.timingSafeEqual`).
* **Aislamiento Multi-Sesión en Memoria**: Gestión estanca y concurrente de múltiples clientes conectados simultáneamente, garantizando que ninguna traza, contexto o petición se cruce entre sesiones activas.
* **Soporte Cloud-Native**: Endpoint público de salud `GET /healthz` para sondas de liveness y readiness de Kubernetes/Cloud Run, apagado ordenado (*graceful shutdown*) ante señales `SIGTERM`/`SIGINT`, y empaquetado Docker optimizado y seguro (usuario no-root, imagen distroless/alpine < 150 MB).
* **Paridad Absoluta con `stdio` (Cero Regresiones)**: El comportamiento por defecto de `ssff-mcp` sigue siendo `stdio`. El modo HTTP solo se activa explícitamente mediante el subcomando `serve` o la presencia de la variable `PORT`.

---

## 2. Registro de Decisiones de Arquitectura (Ledger)

| ID | Decisión | Origen / Justificación |
|---|---|---|
| **D-97** | **Dualidad de Transporte Desacoplada**: El servidor mantiene `stdio` como modo predeterminado para CLI local. El transporte HTTP/SSE se activa exclusivamente mediante el comando `ssff-mcp serve [--port <p\>] [--host <h\>]` o si la variable de entorno `PORT` está definida. | Garantiza cero impacto sobre usuarios de terminal locales y compatibilidad total con las configuraciones actuales de Claude Desktop/Cursor en stdio. |
| **D-98** | **Uso del Servidor HTTP Nativo de Node.js (Cero Dependencias Express/Fastify)**: La capa HTTP se implementa utilizando el módulo nativo `node:http` de Node.js 20+ junto a la clase `SSEServerTransport` del SDK `@modelcontextprotocol/sdk`. | Evita inflar `package.json` con frameworks pesados, minimiza la superficie de vulnerabilidades de dependencias y mantiene el bundle ultraligero. |
| **D-99** | **Endpoints Estándar de Transporte MCP**: Se publican tres rutas:<br>1. `GET /sse`: Establece el canal de streaming unidireccional servidor -> cliente.<br>2. `POST /message?sessionId=<uuid>`: Recepción de mensajes JSON-RPC 2.0 del cliente.<br>3. `GET /healthz`: Probe de liveness/readiness sin autenticación para orquestadores. | Alineación rigurosa con la especificación del protocolo Model Context Protocol (v1.18.0+) y estándares cloud. |
| **D-100** | **Protección Obligatoria por API Key en Modo Remoto**: Si `MCP_API_KEY` está configurada, toda petición a `/sse` y `/message` debe incluir una clave válida vía `Authorization: Bearer <key>` o `X-API-Key: <key>`. La comparación se ejecuta con `crypto.timingSafeEqual` para prevenir ataques de temporización (*timing attacks*). | Protege la instancia en la nube de accesos no autorizados si se expone a través de balanceadores o ingress corporativos. |
| **D-101** | **Gestión de Sesiones Efímeras con Heartbeat y Timeout**: Cada conexión a `/sse` genera un `sessionId` criptográfico (UUID v4). El servidor envía un ping/heartbeat de comentario SSE (`: keepalive\n\n`) cada 25 segundos para evitar que proxies o Cloud Run cierren la conexión por inactividad. Sesiones sin reconexión en 5 minutos se liberan de memoria. | Evita fugas de memoria (*memory leaks*) en el proceso Node.js ante desconexiones abruptas de clientes. |
| **D-102** | **Custodia Estricta de Credenciales SAP en el Servidor**: En modo HTTP/SSE, los clientes remotos interactúan únicamente con las herramientas y recursos autorizados. **En ningún caso** el cliente remoto puede pasar contraseñas o claves privadas de SAP en la llamada; el servidor utiliza su propio `config.json` interno o variables de entorno locales (`fromEnv`, `fromCommand`). | Supera la grave vulnerabilidad de herramientas de la competencia (`sf-mcp`) que transmiten credenciales por tool call en cada prompt. |
| **D-103** | **Health Check Desacoplado de SAP (`/healthz`)**: El endpoint `GET /healthz` comprueba la salud del proceso Node.js local sin lanzar peticiones activas a SAP. Devuelve HTTP 200 con `{ status: "ok", version: "0.3.0", uptime: number }`. | Previene que micro-cortes o lentitud transitoria en los servidores de SAP marquen el contenedor como `Unhealthy` en Kubernetes y provoquen bucles de reinicio del pod (*CrashLoopBackOff*). |
| **D-104** | **Apagado Ordenado (*Graceful Shutdown*)**: Al recibir `SIGTERM` o `SIGINT`, el servidor deja de aceptar nuevas conexiones en `/sse`, envía una notificación de cierre a los clientes SSE activos, espera hasta 10 segundos a que terminen las peticiones OData en curso y cierra el listener HTTP limpiamente. | Vital para despliegues sin interrupciones (*zero-downtime rolling updates*) en Google Cloud Run y Kubernetes. |
| **D-105** | **Trazabilidad y Logging Saneado en HTTP**: Cada petición entrante a `/message` genera un log JSON en `stdout`/`stderr` con `{ method, clientIp, sessionId, durationMs, outcome }`. La IP del cliente respeta `X-Forwarded-For` cuando se active la opción de proxy de confianza. Se prohíbe terminantemente registrar el contenido de tokens en los logs. | Cumplimiento con auditoría corporativa y trazabilidad SIEM. |
| **D-106** | **Contenedor Oficial Multi-Arquitectura (Docker)**: Se proporciona un `Dockerfile` multi-stage optimizado basado en `node:20-alpine`, ejecutado como usuario sin privilegios (`USER node`), sin herramientas de compilación en la imagen final y con un tamaño total inferior a 150 MB. | Facilita el despliegue inmediato con un simple `docker build` / `docker run` o `gcloud run deploy`. |

---

## 3. Especificación del Protocolo y Endpoints HTTP

```
       MCP Client (Claude, Cursor, etc.)
                   │
                   │ 1. GET /sse (Header: X-API-Key: secret)
                   ├──────────────────────────────────────────► ssff-mcp (HTTP/SSE)
                   │                                                  │
                   │ 2. HTTP 200 OK (Stream SSE abierto)              │ Genera Session ID:
                   │    event: endpoint                               │ "uuid-1234-abcd"
                   │    data: /message?sessionId=uuid-1234-abcd       │
                   │◄─────────────────────────────────────────┤
                   │                                                  │
                   │ 3. POST /message?sessionId=uuid-1234-abcd        │
                   │    Payload: JSON-RPC (tools/call: query_entity)  │
                   ├──────────────────────────────────────────►       │ Resuelve credenciales
                   │                                                  │ locales y consulta SAP:
                   │                                                  ├────────────────────────► SAP SuccessFactors
                   │ 4. HTTP 202 Accepted                             │                          (OData v2 HTTPS)
                   │◄─────────────────────────────────────────┤◄────────────────────────┤
                   │                                                  │
                   │ 5. Evento SSE en el stream abierto:              │
                   │    event: message                                │
                   │    data: {"jsonrpc":"2.0", "result": {...}}      │
                   │◄─────────────────────────────────────────┤
```

### 3.1 Endpoints Detallados

#### A. `GET /sse`
* **Propósito:** Inicia la conexión Server-Sent Events.
* **Cabeceras Requeridas:**
  - `Accept: text/event-stream`
  - `X-API-Key: <key>` o `Authorization: Bearer <key>` (si `MCP_API_KEY` está configurada).
* **Respuestas:**
  - `200 OK`: Cabeceras `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`. El primer evento emitido contiene la URL de envío de mensajes:
    ```
    event: endpoint
    data: /message?sessionId=3fa85f64-5717-4562-b3fc-2c963f66afa6
    ```
  - `401 Unauthorized`: Si falta o es incorrecta la API Key.
  - `406 Not Acceptable`: Si la cabecera `Accept` no incluye `text/event-stream`.

#### B. `POST /message?sessionId=<uuid>`
* **Propósito:** Canal de subida para peticiones JSON-RPC 2.0.
* **Parámetros de URL:** `sessionId` (obligatorio, debe corresponder a un stream SSE activo).
* **Cabeceras:** `Content-Type: application/json`, más cabecera de autenticación.
* **Respuestas:**
  - `202 Accepted`: La petición JSON-RPC ha sido recibida y encolada para procesamiento; la respuesta se transmitirá asíncronamente por el canal SSE correspondiente.
  - `400 Bad Request`: Payload no es JSON válido o falta `sessionId`.
  - `404 Not Found`: El `sessionId` no corresponde a ninguna sesión activa o ha caducado.

#### C. `GET /healthz`
* **Propósito:** Health check para probes de orquestadores (K8s, ECS, Cloud Run).
* **Autenticación:** Ninguna (acceso público perimétrico).
* **Respuesta:**
  ```json
  {
    "status": "ok",
    "version": "0.3.0",
    "uptimeSeconds": 14205,
    "activeSessions": 3
  }
  ```

---

## 4. Requisitos Funcionales (FR)

* **FR-127 (MUST)**: El servidor DEBE soportar el subcomando CLI `ssff-mcp serve` con los argumentos opcionales `--port <number>` (o `-p`), `--host <string>` (o `-h`, por defecto `"0.0.0.0"`), y `--api-key <string>`.
* **FR-128 (MUST)**: Si la variable de entorno `PORT` está presente al ejecutar `ssff-mcp` sin subcomandos, el servidor DEBE iniciar automáticamente en modo HTTP/SSE en dicho puerto para compatibilidad directa con Cloud Run y PaaS.
* **FR-129 (MUST)**: El servidor DEBE implementar el transporte `SSEServerTransport` conectando cada cliente a una instancia aislada de `McpServer`.
* **FR-130 (MUST)**: Si se define la variable `MCP_API_KEY` (o el flag `--api-key`), todas las peticiones a `/sse` y `/message` DEBEN requerir autenticación mediante `Authorization: Bearer <key>` o `X-API-Key: <key>`. Las peticiones inválidas DEBEN recibir HTTP 401 con cuerpo JSON saneado.
* **FR-131 (MUST)**: La validación de la API Key DEBE realizarse mediante comparación criptográfica de tiempo constante (`crypto.timingSafeEqual`).
* **FR-132 (MUST)**: El endpoint `GET /healthz` DEBE responder HTTP 200 sin autenticación en menos de 10 ms, reflejando el estado de salud interno del proceso Node.js.
* **FR-133 (MUST)**: El servidor DEBE enviar un comentario SSE de heartbeat (`: keepalive\n\n`) cada 25 segundos a todas las conexiones `/sse` abiertas.
* **FR-134 (MUST)**: Ante la desconexión del cliente HTTP (evento `close` del stream SSE), el servidor DEBE liberar los recursos de transporte y destruir la sesión tras un tiempo de gracia máximo de 60 segundos.
* **FR-135 (MUST)**: El servidor DEBE gestionar señales `SIGTERM` y `SIGINT`, cerrando las conexiones activas ordenadamente en un plazo máximo de 10 segundos antes de finalizar el proceso.
* **FR-136 (MUST)**: En ningún caso las sesiones de clientes remotos DEBEN compartir estados de memoria o caché de credenciales que permitan la fuga de datos entre diferentes usuarios conectados.
* **FR-137 (MUST)**: En ausencia del comando `serve` y de la variable `PORT`, el servidor DEBE arrancar en modo `stdio` con 100% de paridad con la versión actual (D-97).
* **FR-138 (SHOULD)**: El servidor DEBE permitir configurar un límite de conexiones concurrentes (`MAX_CONCURRENT_SESSIONS`, por defecto `50`). Al superarse, nuevas conexiones a `/sse` recibirán `HTTP 503 Service Unavailable`.
* **FR-139 (MUST)**: El proyecto DEBE incluir un `Dockerfile` optimizado multi-etapa con usuario no root (`USER node`) y un archivo `.dockerignore` que excluya `node_modules`, `.git`, tests y archivos de configuración sensibles.
* **FR-140 (SHOULD)**: Se DEBE proporcionar un ejemplo de configuración de cliente para Claude Desktop y Cursor que demuestre la conexión a través de la URL remota SSE:
  ```json
  {
    "mcpServers": {
      "successfactors": {
        "url": "https://ssff-mcp.mi-empresa.internal/sse",
        "headers": {
          "X-API-Key": "mi-clave-secreta"
        }
      }
    }
  }
  ```

---

## 5. Diseño Técnico e Implementación

### 5.1 Arquitectura de Componentes
* **`src/server-http.ts`**: Servidor HTTP nativo Node.js, enrutador de rutas (`/sse`, `/message`, `/healthz`), middleware de autenticación por API Key y gestión de ciclo de vida de sesiones SSE (`Map<string, { transport: SSEServerTransport, lastActivity: number }>`).
* **`src/cli.ts`**: Integración del subcomando `serve` y detección automática de la variable `PORT`.
* **`Dockerfile`**: Empaquetado oficial en contenedor distroless/alpine.

### 5.2 Implementación del Middleware de Seguridad (API Key)

```typescript
import { timingSafeEqual } from 'node:crypto';

export function validateApiKey(providedKey: string | undefined, expectedKey: string): boolean {
  if (!providedKey) return false;
  const providedBuffer = Buffer.from(providedKey);
  const expectedBuffer = Buffer.from(expectedKey);
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(providedBuffer, expectedBuffer);
}
```

### 5.3 Dockerfile Oficial Multi-Stage

```dockerfile
# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@9
COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile
COPY src/ ./src/
RUN pnpm build

# Stage 2: Runtime
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN npm install -g pnpm@9
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=builder /app/dist ./dist

USER node
EXPOSE 8080
ENV PORT=8080
CMD ["node", "dist/cli.js", "serve"]
```

---

## 6. Seguridad y Gobernanza en Despliegues Cloud (DS)

* **DS-HTTP-01 (Sin credenciales en cliente)**: A diferencia de arquitecturas cliente-servidor inseguras, el cliente MCP remoto jamás recibe ni envía credenciales de SAP. Toda autenticación con SAP se produce de backend a backend (ssff-mcp -> SAP SuccessFactors).
* **DS-HTTP-02 (Protección contra Timing Attacks)**: La validación de la API Key utiliza buffers de longitud fija y `timingSafeEqual`, impidiendo ataques de temporización para adivinar el token.
* **DS-HTTP-03 (Contenedor No Root y Superficie Reducida)**: El contenedor ejecuta bajo el usuario no privilegiado `node` (UID 1000) en una imagen Alpine mínima, sin paquetes adicionales de compilación.
* **DS-HTTP-04 (Protección de Egress de Red)**: Al estar centralizado en la nube corporativa, el contenedor puede salir a través de un NAT Gateway con IP estática fija, cumpliendo con las políticas más rigurosas de IP Whitelisting de SAP.

---

## 7. Plan de Pruebas y Validación

1. **Unit Tests (`test/server-http.test.ts`)**:
   - Validación de API Key con cabeceras `Authorization: Bearer` y `X-API-Key`.
   - Rechazo con 401 ante claves incorrectas o ausentes.
   - Endpoint `/healthz` devuelve 200 sin autenticación.
   - Rechazo de peticiones a `/message` con `sessionId` inexistente (404).
2. **Integration Tests (SSE Stream)**:
   - Conexión a `/sse` recibe el evento `endpoint` inicial con el `sessionId`.
   - Envío de llamada JSON-RPC a `/message` despacha la respuesta al canal SSE abierto.
   - Envío de evento de keepalive cada 25 segundos.
   - Manejo de desconexión del cliente y limpieza de sesión.
3. **Container Tests**:
   - Construcción de imagen Docker y arranque en puerto 8080.
   - Comprobación de que responde a `curl http://localhost:8080/healthz`.

---

## 8. Estimación de Esfuerzo

* **Complejidad:** Media (integración de `SSEServerTransport` del SDK MCP oficial y servidor HTTP nativo sin dependencias pesadas).
* **Story Points:** 10 SP.
* **Tiempo Estimado:** 4 a 5 días laborables.
