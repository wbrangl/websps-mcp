/** Error codes reported by the device in `{"ok":false,"error":{"code":N}}`. */
export const DeviceErrorCode = {
  AUTH: 1,
  FORBIDDEN: 2,
  PARAMS: 3,
  NOT_FOUND: 4,
  BUSY: 5,
  VALIDATION: 6,
  INTERNAL: 99,
} as const;

/** Errors raised by the server itself; kept in a separate range from the device codes. */
export const ServerErrorCode = {
  SERVER_ERROR: 1000,
  CIRCUIT_OPEN: 1001,
  AUTH_BLOCKED: 1002,
  UNREACHABLE: 1003,
  TIMEOUT: 1004,
  BAD_RESPONSE: 1005,
  UNKNOWN_DEVICE: 1006,
  INVALID_INPUT: 1007,
} as const;

const NAMES = new Map<number, string>(
  [...Object.entries(DeviceErrorCode), ...Object.entries(ServerErrorCode)].map(([name, code]) => [
    code,
    name,
  ]),
);

const HINTS: Record<number, string> = {
  [DeviceErrorCode.AUTH]:
    "Device rejected the credentials or the IP is locked out. Not retried automatically; check the configured user/password.",
  [DeviceErrorCode.FORBIDDEN]:
    "The device user lacks the permission for this method. Ask the administrator to adjust the user's permission mask.",
  [DeviceErrorCode.PARAMS]: "Invalid or missing parameter. Fix the arguments; do not retry as is.",
  [DeviceErrorCode.NOT_FOUND]: "The key, file or channel does not exist on the device.",
  [DeviceErrorCode.BUSY]: "Device stayed busy after several retries. Try again later.",
  [DeviceErrorCode.VALIDATION]:
    "Value rejected by the device (range, file name format or expected_hash conflict).",
  [DeviceErrorCode.INTERNAL]: "Internal device error. Do not retry; check the device log.",
  [ServerErrorCode.SERVER_ERROR]:
    "Unexpected server error; details are in the server's stderr log.",
  [ServerErrorCode.CIRCUIT_OPEN]:
    "Requests to this device are paused after an authentication failure to avoid a lockout. Wait and retry after the given time.",
  [ServerErrorCode.AUTH_BLOCKED]:
    "Authentication failed again after the waiting period. The device stays blocked until the credentials in the server configuration are fixed.",
  [ServerErrorCode.UNREACHABLE]:
    "Device not reachable. Check network, URL and that the device is on.",
  [ServerErrorCode.TIMEOUT]: "Device did not answer in time. It may be busy or unreachable.",
  [ServerErrorCode.BAD_RESPONSE]: "Device sent an unexpected response.",
  [ServerErrorCode.UNKNOWN_DEVICE]:
    "Pass `device` with one of the configured aliases (see devices_list).",
  [ServerErrorCode.INVALID_INPUT]: "Fix the arguments; the request was not sent to the device.",
};

export interface ErrorPayload {
  code: number;
  name: string;
  message: string;
  hint?: string;
  device?: string;
}

export class WebspsError extends Error {
  readonly code: number;
  readonly hint: string | undefined;
  readonly device: string | undefined;

  constructor(code: number, message: string, options: { device?: string; hint?: string } = {}) {
    super(message);
    this.code = code;
    this.hint = options.hint ?? HINTS[code];
    this.device = options.device;
  }

  get errorName(): string {
    return NAMES.get(this.code) ?? "UNKNOWN";
  }

  toPayload(): ErrorPayload {
    return {
      code: this.code,
      name: this.errorName,
      message: this.message,
      ...(this.hint !== undefined && { hint: this.hint }),
      ...(this.device !== undefined && { device: this.device }),
    };
  }
}
