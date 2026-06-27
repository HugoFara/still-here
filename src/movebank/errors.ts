/**
 * Movebank error taxonomy.
 *
 * The single most important distinction (brief §2.3): permission-denied
 * (the API now refuses data you may not see) vs. tag-went-quiet (a valid
 * request that simply has no points). They look superficially identical — both
 * "no points" — but mean completely different things and drive different product
 * behavior. Permission-denied → retire silently. Tag-quiet → QUIET narrative.
 *
 * Here, permission-denied is an explicit error type; genuine no-data is NOT an
 * error — it is an empty-but-valid result the caller receives normally.
 *
 * (Fields are declared explicitly rather than via constructor parameter
 * properties, which Node's type-stripping runtime does not support.)
 */

export class MovebankError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The API refuses this data: not public to us / access revoked. ≠ tag death. */
export class PermissionDeniedError extends MovebankError {
  readonly studyId: string;
  constructor(
    studyId: string,
    message = "Movebank denied access to this data (contact the data owner).",
  ) {
    super(message);
    this.studyId = studyId;
  }
}

/**
 * The study requires accepting its License Terms before first download. Carries
 * the terms + the MD5 the caller passes back to accept them (brief §2.3).
 * Accepting is a legal act, so by default the client throws this rather than
 * silently agreeing — unless an explicit accept policy is provided.
 */
export class LicenseTermsRequiredError extends MovebankError {
  readonly studyId: string;
  readonly termsText: string;
  readonly termsMd5: string;
  readonly termsUrl: string | undefined;
  constructor(studyId: string, termsText: string, termsMd5: string, termsUrl?: string) {
    super(
      `Study ${studyId} requires accepting license terms (md5 ${termsMd5}) before download.`,
    );
    this.studyId = studyId;
    this.termsText = termsText;
    this.termsMd5 = termsMd5;
    this.termsUrl = termsUrl;
  }
}

/** Transport-level failure (network / non-2xx that isn't a known semantic). */
export class MovebankHttpError extends MovebankError {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`HTTP ${status}: ${message}`);
    this.status = status;
  }
}

/** Throttled. Cache aggressively; do not hammer (brief §2.3). */
export class RateLimitError extends MovebankError {
  readonly retryAfterSeconds: number | undefined;
  constructor(retryAfterSeconds?: number) {
    super("Movebank rate limit hit; back off and retry later.");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
