/**
 * Shared VS Code configuration mock used by unit tests so config lookups do
 * not drift between `config.test.ts` and provider tests.
 */
export function createConfigGetMock(store: Record<string, unknown> = {}) {
  return (key: string, defaultValue?: unknown) => {
    if (key in store) {
      return store[key];
    }
    return defaultValue;
  };
}

export function createWorkspaceConfigurationMock(store: Record<string, unknown> = {}) {
  return {
    get: createConfigGetMock(store),
    update: jest.fn(),
    has: jest.fn((key: string) => key in store),
    inspect: jest.fn(),
  };
}
