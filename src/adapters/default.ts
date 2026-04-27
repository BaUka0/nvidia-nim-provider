import { ModelAdapter, NvidiaModelRequestProfile } from "./base";

export class DefaultAdapter implements ModelAdapter {
  matches(_modelId: string): boolean {
    return false;
  }

  getProfile(_options: { toolsEnabled?: boolean }): NvidiaModelRequestProfile {
    return {
      defaultTemperature: 0.7,
      extraSystemMessages: [],
    };
  }
}
