export abstract class ResilientHttpError extends Error {
  public readonly name: string;
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class QueueFullError extends ResilientHttpError {
  constructor(public readonly maxQueue: number) {
    super(`Queue is full (maxQueue=${maxQueue}).`);
  }
}

export class QueueTimeoutError extends ResilientHttpError {
  constructor(public readonly enqueueTimeoutMs: number) {
    super(`Queue wait exceeded (enqueueTimeoutMs=${enqueueTimeoutMs}).`);
  }
}

export class RequestTimeoutError extends ResilientHttpError {
  constructor(public readonly requestTimeoutMs: number) {
    super(`Request timed out (requestTimeoutMs=${requestTimeoutMs}).`);
  }
}



export class UpstreamError extends ResilientHttpError {
  constructor(public readonly status: number) {
    super(`Upstream returned error status=${status}.`);
  }
}
