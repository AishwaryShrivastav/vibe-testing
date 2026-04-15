export function interpolateEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    const envValue = process.env[varName]
    if (!envValue) throw new Error(`Missing env var: ${varName}`)
    return envValue
  })
}

export function interpolateConfig<T extends Record<string, unknown>>(config: T): T {
  const result = { ...config }
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'string') {
      result[key as keyof T] = interpolateEnv(value) as T[keyof T]
    } else if (typeof value === 'object' && value !== null) {
      result[key as keyof T] = interpolateConfig(value as Record<string, unknown>) as T[keyof T]
    }
  }
  return result
}
