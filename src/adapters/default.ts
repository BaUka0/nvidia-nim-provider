import { ModelAdapter, NvidiaModelRequestProfile } from "./base";

export class DefaultAdapter implements ModelAdapter {
  matches(modelId: string): boolean {
    return false;
  }

  getProfile(options: { toolsEnabled?: boolean }): NvidiaModelRequestProfile {
    return {
      defaultTemperature: 0.7,
      extraSystemMessages: [],
    };
  }
}
