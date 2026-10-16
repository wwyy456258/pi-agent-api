export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public requestId?: string,
    public chatId?: string,
  ) { super(message); }
}

export function invalid(message: string): never {
  throw new ApiError(400, "invalid_request", message);
}

export function publicError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const code = (error as { code?: string })?.code;
  if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
    return new ApiError(415, "unsupported_media_type", "Use JSON or multipart/form-data.");
  }
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE" || code === "FST_FILES_LIMIT" || code === "FST_PARTS_LIMIT" || code?.startsWith("FST_REQ_")) {
    return new ApiError(413, "upload_limit_exceeded", "The configured upload limit was exceeded.");
  }
  if (["FST_FIELDS_LIMIT", "FST_PROTO_VIOLATION", "FST_INVALID_JSON_FIELD_ERROR", "FST_MP_PREMATURE_CLOSE", "ERR_STREAM_PREMATURE_CLOSE"].includes(code ?? "") || /^(Unexpected end of (form|file|multipart data)|Malformed part header|Multipart:)/.test((error as Error)?.message ?? "")) {
    return new ApiError(400, "invalid_request", "Invalid multipart request.");
  }
  if (code === "FST_ERR_CTP_INVALID_JSON_BODY" || code === "FST_ERR_CTP_EMPTY_JSON_BODY" ||
      error instanceof SyntaxError) {
    return new ApiError(400, "invalid_request", "Invalid JSON request.");
  }
  return new ApiError(500, "internal_error", "The service could not complete the request.");
}

export function envelope(error: ApiError, requestId: string, chatId?: string) {
  return {
    request_id: error.requestId ?? requestId,
    ...((error.chatId ?? chatId) ? { chat_id: error.chatId ?? chatId } : {}),
    error: { code: error.code, message: error.message },
  };
}
