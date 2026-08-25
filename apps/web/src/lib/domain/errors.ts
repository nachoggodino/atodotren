export class ValidationError extends Error {
  readonly code: string;

  constructor(message: string, code = "invalid-request") {
    super(message);
    this.name = "ValidationError";
    this.code = code;
  }
}

export class NotFoundError extends Error {
  readonly code: string;

  constructor(message = "Resource not found", code = "not-found") {
    super(message);
    this.name = "NotFoundError";
    this.code = code;
  }
}

export class DataUnavailableError extends Error {
  readonly code: string;

  constructor(message: string, code = "data-unavailable") {
    super(message);
    this.name = "DataUnavailableError";
    this.code = code;
  }
}

export class DataContractError extends Error {
  readonly context: string;

  constructor(context: string, message: string) {
    super(`${context}: ${message}`);
    this.name = "DataContractError";
    this.context = context;
  }
}
