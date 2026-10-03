# Agente conversacional "Órdenes de Compra SAP" — Reto 03

Agente que lee el paquete de una solicitud de compra (correo, Excel de solicitud, cotización, aprobación y factura), lo valida contra los maestros (RC1–RC10), construye la OC con trazabilidad, genera la evidencia de aprobación (TXT + PDF) y la crea en un SAP simulado. Las excepciones se bloquean o se devuelven al humano para confirmación.

El planteamiento completo de la solución está en [`SOLUCION.md`](SOLUCION.md).

## Requisitos

- [Bun](https://bun.sh) ≥ 1.2 (incluye TypeScript, no hace falta Node).
- Una clave de Anthropic para el modo con modelo real. Sin clave, la app arranca en **modo simulado**: un guion determinista que usa las mismas herramientas.

## Levantar en local (un comando)

```bash
cp .env.example .env        # y escribe tu ANTHROPIC_API_KEY
bun install && bun run dev  # front + backend en http://localhost:3006
```

Bun carga `.env` automáticamente. Para probar la interfaz sin clave: `LLM_PROVIDER=simulado bun run dev`.

### Variables de entorno

| Variable | Defecto | Uso |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` | `anthropic` (modelo real) o `simulado` (sin clave). Si falta la clave, el servidor cae a `simulado` y lo indica en `/api/health` y en el front. |
| `ANTHROPIC_API_KEY` | — | Clave del modelo. Solo vive en el backend. |
| `LLM_MODEL` | `claude-opus-5-5` | Modelo. |
| `LLM_EFFORT` | `medium` | Esfuerzo de razonamiento (`low`…`max`). |
| `LLM_TIMEOUT_MS` | `90000` | Timeout por llamada al modelo. |
| `MAX_ITERACIONES` | `25` | Tope de iteraciones herramienta → modelo por turno. |
| `MAX_TOKENS_SESION` | `400000` | Tope de tokens por sesión (costo). |
| `MAX_CARACTERES_MENSAJE` | `2000` | Longitud máxima de un mensaje del usuario. |
| `PORT` | `3006` | Puerto HTTP. |
| `ACCESS_KEY` | vacío | Si se define, el front pide esta clave y la API la exige (`x-access-key`). |

## Demo sin modelo

```bash
bun install && bun run demo.ts
```

Limpia `out/`, procesa los 6 casos llamando directamente a las herramientas e imprime por caso `apta`, bloqueos, confirmaciones, `retroactiva` y número de OC o motivo. Ejecuta `sol-001` dos veces (idempotencia) y confirma explícitamente `sol-004`, `sol-005` y `sol-006`. Resultado esperado:

| Caso | Resultado |
|---|---|
| sol-001 | OC 4500000001 sin intervención; la segunda ejecución devuelve la misma OC (idempotente) |
| sol-002 | Bloqueado RC1 (proveedor inexistente) |
| sol-003 | Bloqueado RC2 (aprobador de otro centro de costo; el aprobador de CC-2020 tampoco tiene tope) |
| sol-004 | Pendiente RC5 (cotización 6 % sobre la solicitud) → confirmado → OC 4500000002 |
| sol-005 | Pendiente RC8 (factura anterior a la solicitud) → confirmado → OC 4500000003, `retroactiva = true` |
| sol-006 | Pendiente RC6 (IVA derivado C1) + derivado RC7 (Z030) → confirmado → OC 4500000004 |

## Pruebas

```bash
bun test            # 26 pruebas: reglas, idempotencia, payload alterado, HU-6, ciclo del agente, módulo
bun run typecheck   # TypeScript estricto, sin any
```

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, tokensSesion, error? }` |
| `GET` | `/api/sessions/:id` | Historial visible de la sesión (mensajes, llamadas a herramientas, errores) |
| `GET` | `/api/health` | `{ ok, provider, model, aviso, accesoProtegido, herramientas }`, sin claves |
| `GET` | `/api/casos` | Casos disponibles en `fixtures/reto-03/solicitudes/` |
| `GET` | `/api/archivo?ruta=out/...` | Solo lectura de artefactos: `control.csv`, `sap/ordenes.jsonl`, `<caso>/aprobacion.{txt,pdf}`, `<caso>/trazabilidad.json` |

`toolCalls[]`: `{ nombre, argumentos, ok, resumen, resultado, ms }`. Una sesión procesa un mensaje a la vez (409 si llega otro en paralelo).

## Archivos generados en `out/`

| Archivo | Contenido |
|---|---|
| `sap/ordenes.jsonl` | OC creadas en el SAP simulado (número secuencial desde 4500000001) |
| `control.csv` | Un intento por fila: `solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, ts` |
| `<caso>/trazabilidad.json` | Fuente de cada campo del payload |
| `<caso>/aprobacion.txt` / `.pdf` | Evidencia de aprobación con sha256 |
| `log.jsonl` | Cada llamada a herramienta desde el chat |
| `sesiones/<id>.json` | Sesiones persistidas |

## Despliegue

- **Docker**: `docker build -t agente-oc-sap . && docker run -p 3006:3006 -e ANTHROPIC_API_KEY=... agente-oc-sap`
- **Render**: el repo incluye `render.yaml` (Blueprint). Crea el servicio desde el repositorio y carga `ANTHROPIC_API_KEY` (y opcionalmente `ACCESS_KEY`) en el panel.

**Link de prueba:** _pendiente de publicar_ · **Clave de acceso:** _la definida en `ACCESS_KEY`, si aplica_

## Módulo reutilizable (bonus)

`modulo/` empaqueta el agente sin el servidor: `agent.md` (system prompt), `tools/oc.ts` (herramientas) y `skill/ordenes-compra/SKILL.md` (conocimiento). Se genera desde las mismas fuentes de la app con `bun run modulo`, y `bun run modulo:check` (también en `bun test`) falla si diverge.

## Estructura

```
agent/prompt.md               comportamiento (system prompt)
src/knowledge/                conocimiento del proceso (consultable por el agente)
src/tools/                    ejecución: herramientas tipadas con zod (oc_*, conocimiento_*)
src/lib/                      reglas RC1–RC10, parseo, payload, evidencia, log de control
src/sap/                      SapAdapter + mock sobre out/sap/
src/llm/                      interfaz ProveedorLLM + Anthropic + simulado
src/agent/                    ciclo del agente, sesiones, confirmación humana
src/server.ts                 API HTTP + front estático
web/                          front de chat (HTML/CSS/JS sin dependencias)
demo.ts                       verificación sin modelo
tests/                        bun test
modulo/                       bonus: agente empaquetado
```
