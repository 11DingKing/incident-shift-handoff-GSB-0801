export interface FieldConflict {
  field: string;
  current: unknown;
  attempted: unknown;
}

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }

  static notFound(what: string, id: string): ApiError {
    return new ApiError(404, 'NOT_FOUND', `${what} 不存在: ${id}`);
  }

  static badRequest(message: string): ApiError {
    return new ApiError(400, 'VALIDATION', message);
  }

  static versionConflict(
    what: string,
    currentVersion: number,
    conflicts: FieldConflict[],
  ): ApiError {
    return new ApiError(
      409,
      'VERSION_CONFLICT',
      `${what} 已被他人修改（当前版本 ${currentVersion}），请合并后重试`,
      { currentVersion, conflicts },
    );
  }

  static locked(what: string, id: string): ApiError {
    return new ApiError(409, 'HANDOFF_LOCKED', `${what} 已签收，不可修改: ${id}`);
  }
}
