# Proceso de órdenes de compra (OC) en SAP — Periferia IT Group

Conocimiento del proceso que consulta el agente. Describe el *qué* y el *por qué*; la ejecución de cada regla vive en `src/lib/reglas.ts`.

## Proceso y actores

Cada compra llega a Administración por correo con tres piezas: Excel de solicitud, cotización del proveedor y correo de aprobación del líder. A veces llega también la factura.

- **Solicitante**: envía el paquete. No usa el agente.
- **Líder aprobador**: responde el correo con "Aprobado". No usa el agente.
- **Analista administrativa**: conversa con el agente, revisa la OC y confirma excepciones.
- **Contabilidad / Auditoría**: consume `out/control.csv` y la evidencia de aprobación.
- **SAP**: sistema de registro (simulado en este reto, en `out/sap/ordenes.jsonl`).

Flujo del agente: leer paquete → validar (RC1–RC10) → construir payload → generar evidencia → crear OC (o bloquear / pedir confirmación).

## Tipos de resultado de una validación

- **Bloqueo**: impide crear la OC. El agente no lo resuelve; explica la razón y la acción sugerida.
- **Confirmación**: permite crear la OC solo si la analista confirma explícitamente en su siguiente mensaje.
- **Derivado**: valor que el agente completó desde un maestro (por ejemplo condiciones de pago del proveedor). Siempre se informa.

## RC1 Proveedor existente y activo

El proveedor debe existir en el maestro de proveedores, buscado por NIT (sin puntos ni dígito de verificación) o, si la solicitud no trae NIT, por nombre normalizado (sin tildes, mayúsculas, puntuación ni sufijo societario S.A.S./S.A./Ltda.). Además debe estar activo. **Bloqueo.**
Acción sugerida: pedir a Compras la creación o reactivación del proveedor en SAP, o pedir al solicitante una cotización de un proveedor registrado.

## RC2 Aprobación válida

Debe existir un correo de aprobación, contener la palabra "Aprobado" (y no "no aprobado") y venir de un correo listado como aprobador del centro de costo de la solicitud. **Bloqueo.**
Acción sugerida: solicitar la aprobación a un aprobador autorizado del centro de costo con tope suficiente; si ninguno alcanza, escalar a la matriz de aprobación.

## RC3 Tope del aprobador

El valor total de la solicitud debe ser menor o igual al tope del aprobador en ese centro de costo. **Bloqueo.**

## RC4 Subárea del centro de costo

La subárea debe pertenecer al centro de costo, y el centro de costo debe existir. **Bloqueo.**

## RC5 Cotización vs solicitud

`|total cotización − valor total solicitud| / valor total solicitud` debe ser ≤ 2 %. Si excede, o no hay cotización, o la moneda difiere: **confirmación** mostrando ambos valores. La OC se crea por el valor de la solicitud, que es lo que aprobó el líder; el agente nunca ajusta el monto para que cuadre con la cotización.

## RC6 Indicador de IVA

Si la solicitud no informa indicador de IVA, se deriva del maestro del proveedor (`indicador_iva_default`) y se pide **confirmación**. Si informa un código que no existe en el maestro de indicadores, es **bloqueo**.

## RC7 Condiciones de pago

Si la solicitud no informa condiciones de pago, se derivan del proveedor (`condiciones_pago_default`) y solo se informa (**derivado**). Un código inexistente en el maestro es **bloqueo**.

## RC8 OC retroactiva

Si el paquete trae una factura con fecha anterior a la fecha de solicitud, la OC es **retroactiva**: se pide **confirmación** y queda `retroactiva = true` en `out/control.csv`. La dirección quiere medir este desvío: muchas OC se crean después de la factura, saltándose la cotización.

## RC9 Fecha de aprobación

La fecha de la aprobación debe ser igual o posterior a la fecha de la solicitud (se compara la fecha local escrita en el correo). Si es anterior: **confirmación**.

## RC10 Aritmética de la solicitud

`cantidad × valor_unitario` debe igualar `valor_total` con tolerancia de ± 1 unidad monetaria. Si no: **bloqueo**; pedir al solicitante que corrija el Excel.

## Confirmación humana

Cuando hay confirmaciones, el agente muestra la OC y pregunta. Solo el mensaje inmediatamente siguiente de la analista puede confirmar ("confirmo", "sí", "adelante"). Una respuesta con negación o ambigua no confirma. Las excepciones confirmadas quedan en `excepciones[].confirmado_por` de la OC.

## Estructura de la OC (payload SAP)

- `sociedad` y `organizacion_compras`: "1000" (constantes de la compañía).
- `proveedor`: código SAP, NIT y nombre, siempre desde el maestro.
- `condiciones_pago`: código (Z000 inmediato, Z015, Z030, Z060 días fecha factura).
- `aprobador`: correo, fecha y sha256 de la evidencia de aprobación.
- `posiciones`: numeradas 10, 20, 30…; descripción máximo 40 caracteres (texto breve SAP; se recorta sin cortar palabras y el original queda en la trazabilidad); precio unitario de la solicitud.
- `excepciones`: confirmaciones de la validación, con quién las confirmó.

Cada valor es trazable a su fuente (`solicitud`, `cotizacion`, `correo`, `aprobacion`, `maestro.<nombre>`, `derivado` o `constante`) en `out/<caso>/trazabilidad.json`.

## Unidad de medida

Se infiere del ítem cotizado (o de la descripción si no hay cotización): si empieza por "Hora…" → `H`; por "Mes…" o "Mensualidad…" → `MES`; en otro caso → `UN`. Una licencia "12 meses" es una unidad (`UN`), no un mes.

## Indicadores de IVA y condiciones de pago

- IVA: C0 excluido/no gravado (0 %), C1 IVA 19 %, C2 IVA 5 %.
- Pago: Z000 pago inmediato, Z015 15 días, Z030 30 días, Z060 60 días fecha factura.

## Evidencia de aprobación

El correo de aprobación se convierte en `out/<caso>/aprobacion.txt` (encabezados de, para, CC, fecha, asunto + cuerpo + sha256 del contenido) y `aprobacion.pdf` con el mismo contenido. El sha256 se copia en la OC para que Auditoría verifique que la evidencia no cambió.

## Idempotencia y log de control

Crear dos veces la misma solicitud devuelve el número de OC existente; no crea otra. Cada intento de creación (exitoso, idempotente, bloqueado, pendiente o error) agrega una fila a `out/control.csv`: `solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, ts`.

## Qué pedir al solicitante

- Falta el Excel de solicitud o el correo: reenviar el paquete completo.
- JSON o monto ilegible: reenviar el Excel corregido con montos numéricos.
- Falta la cotización: adjuntar la cotización del proveedor (o confirmar crear sin ella).
- Falta la aprobación o no dice "Aprobado": pedir la aprobación explícita al líder autorizado.
