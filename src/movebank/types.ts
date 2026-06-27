/**
 * Transport-level request/response descriptors. The client builds a structured
 * {@link MovebankRequest}; a {@link Transport} executes it (live fetch or
 * recorded fixture). This decoupling is what makes the client unit-testable
 * against recorded fixtures (brief §8.1) and keeps it un-coupled to one surface.
 */

/** Which API surface a request targets (brief §2.1). */
export type Surface = "public-json" | "v2-rest";

/** Logical operations the client performs, independent of surface/URL shape. */
export type Operation =
  | "list-studies"
  | "list-individuals"
  | "get-locations";

export interface MovebankRequest {
  surface: Surface;
  op: Operation;
  /** Stable params; used both to build a live URL and to key a fixture. */
  params: Record<string, string>;
  /** Set on a license-acceptance retry (the accepted terms' MD5). */
  licenseMd5?: string;
}

export interface RawResponse {
  status: number;
  /** Parsed JSON body (already JSON.parsed). */
  json: unknown;
}

/** Pluggable execution backend. */
export interface Transport {
  execute(req: MovebankRequest): Promise<RawResponse>;
}
