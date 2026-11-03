/** Types for issue-report-check.js, so the jest tests can import it. */

export interface ReportCheckDeps {
  github: unknown;
  context: unknown;
  core: { info(message: string): void };
  fetchImpl?: (
    url: string,
    init?: { signal?: AbortSignal },
  ) => Promise<{
    ok: boolean;
    text(): Promise<string>;
  }>;
}

export function run(deps: ReportCheckDeps & { modelNames?: Record<string, string> }): Promise<void>;
export function loadModelNames(catalogPath?: string): Record<string, string>;
export function needsBetterTitle(title: string): boolean;
export function describeFailure(
  report: unknown,
): { modelId?: string; code?: string; status?: string; tools: string[] } | undefined;
export function buildTitle(input: {
  failure?: { modelId?: string; code?: string; status?: string; tools: string[] };
  title: string;
  activeModel: string;
  modelNames: Record<string, string>;
}): string | undefined;
export function findSection(
  body: string,
  label: string,
): { contentStart: number; contentEnd: number; text: string } | undefined;
export function filesIn(text: string): string[];
export function isTurnReport(data: unknown): boolean;
export function isExtensionReport(data: unknown): boolean;
