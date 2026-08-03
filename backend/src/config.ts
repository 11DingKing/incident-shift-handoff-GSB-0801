function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`缺少必需的环境变量: ${name}`);
  }
  return value;
}

export const config = {
  databaseUrl: required(
    "DATABASE_URL",
    "postgres://huangding@localhost:5432/incident_handoff_gsb_0801_dev"
  ),
  port: Number(process.env.PORT ?? 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  logLevel: process.env.LOG_LEVEL ?? "info",
  isTest: process.env.NODE_ENV === "test",
};
