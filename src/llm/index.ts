import { config } from "../config.ts"
import type { ProveedorLLM } from "./adapter.ts"
import { ProveedorAnthropic } from "./anthropic.ts"
import { ProveedorSimulado } from "./simulado.ts"

/** Único punto que conoce las implementaciones concretas. */
export const crearProveedor = (): ProveedorLLM => {
  switch (config.proveedor) {
    case "simulado":
      return new ProveedorSimulado()
    case "anthropic":
      if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) throw new Error("falta ANTHROPIC_API_KEY")
      return new ProveedorAnthropic({ modelo: config.modelo, esfuerzo: config.esfuerzo, timeoutMs: config.timeoutMs })
    default:
      throw new Error(`LLM_PROVIDER desconocido: "${config.proveedor}". Usa "anthropic" o "simulado".`)
  }
}
