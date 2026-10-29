/** A required host feature is absent. The guarded operation has not been sent. */
export class PaseoUnsupportedCapabilityError extends Error {
  readonly code = "unsupported_capability";

  constructor(
    readonly capability: string,
    message: string,
  ) {
    super(message);
    this.name = "PaseoUnsupportedCapabilityError";
  }
}
