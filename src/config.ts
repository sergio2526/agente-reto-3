const entero = (valor: string | undefined, defecto: number): number => {
  const n = Number(valor)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defecto
}

export const config = {
  proveedor: process.env.LLM_PROVIDER ?? "anthropic",
  modelo: process.env.LLM_MODEL ?? "claude-opus-5-5",
  esfuerzo: process.env.LLM_EFFORT ?? "medium",
  timeoutMs: entero(process.env.LLM_TIMEOUT_MS, 90_000),
  maxIteraciones: entero(process.env.MAX_ITERACIONES, 25),
  maxTokensSesion: entero(process.env.MAX_TOKENS_SESION, 400_000),
  maxCaracteresMensaje: entero(process.env.MAX_CARACTERES_MENSAJE, 2_000),
  puerto: entero(process.env.PORT, 3006),
  claveAcceso: process.env.ACCESS_KEY ?? "",
  directorio: process.cwd(),
} as const
