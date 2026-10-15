import { MODEL_LIST } from "../src/models/catalog";
import {
  daysUntilDeprecation,
  DEPRECATION_WARNING_KEY,
  formatDeprecatedModelName,
  formatDeprecationWarning,
  hasScheduledDeprecations,
  msUntilNextUtcMidnight,
  parseDeprecationDate,
  scheduleDeprecationCountdownRefresh,
} from "../src/models/deprecation";
import { NvidiaModelDiscoveryService } from "../src/models/discovery";
import { NimChatModelProvider } from "../src/provider/chat-provider";
import { makeSecrets } from "./helpers/fakes";

const MODEL_ID = "z-ai/glm-5.3";

function withDeprecationDate<T>(id: string, date: string | undefined, run: () => T): T {
  const entry = MODEL_LIST[id];
  const previous = entry.deprecationDate;
  entry.deprecationDate = date;
  try {
    return run();
  } finally {
    entry.deprecationDate = previous;
  }
}

describe("model retirement countdown", () => {
  describe("parseDeprecationDate", () => {
    it("reads YYYY-MM-DD as midnight UTC", () => {
      expect(parseDeprecationDate("2026-10-30")).toBe(Date.UTC(2026, 9, 30));
    });

    it.each(["2026-02-30", "2026-13-01", "2026-10-3", "30.10.2026", "", "2026-10-30T00:00Z"])(
      "rejects %p",
      (value) => {
        expect(parseDeprecationDate(value)).toBeUndefined();
      },
    );
  });

  describe("daysUntilDeprecation", () => {
    it("counts whole UTC days, whatever the time of day", () => {
      expect(daysUntilDeprecation("2026-10-30", new Date("2026-10-15T00:00:00Z"))).toBe(15);
      expect(daysUntilDeprecation("2026-10-30", new Date("2026-10-15T23:59:59Z"))).toBe(15);
      expect(daysUntilDeprecation("2026-10-16", new Date("2026-10-15T23:59:59Z"))).toBe(1);
      expect(daysUntilDeprecation("2026-10-15", new Date("2026-10-15T12:00:00Z"))).toBe(0);
      expect(daysUntilDeprecation("2026-10-14", new Date("2026-10-15T12:00:00Z"))).toBe(-1);
    });

    it("returns undefined for an invalid date", () => {
      expect(daysUntilDeprecation("soon", new Date())).toBeUndefined();
    });
  });

  describe("formatDeprecationWarning", () => {
    const now = new Date("2026-10-15T10:00:00Z");

    it("counts down in days", () => {
      expect(formatDeprecationWarning("2026-10-30", now)).toBe(
        "NVIDIA retires this model on October 30, 2026, in 15 days. Switch to another model before then.",
      );
    });

    it("says tomorrow one day out", () => {
      expect(formatDeprecationWarning("2026-10-16", now)).toBe(
        "NVIDIA retires this model on October 16, 2026, tomorrow. Switch to another model before then.",
      );
    });

    it("says today on the retirement day", () => {
      expect(formatDeprecationWarning("2026-10-15", now)).toBe(
        "NVIDIA retires this model today, October 15, 2026. Switch to another model.",
      );
    });

    it("reports a passed date as retired", () => {
      expect(formatDeprecationWarning("2026-10-01", now)).toBe(
        "NVIDIA retired this model on October 1, 2026. Requests to it may fail; switch to another model.",
      );
    });

    it("returns undefined without a valid date", () => {
      expect(formatDeprecationWarning(undefined, now)).toBeUndefined();
      expect(formatDeprecationWarning("2026-02-30", now)).toBeUndefined();
    });
  });

  describe("formatDeprecatedModelName", () => {
    const now = new Date("2026-10-15T10:00:00Z");

    it.each([
      ["2026-10-30", "GLM 5.3 (retires in 15 days)"],
      ["2026-10-16", "GLM 5.3 (retires tomorrow)"],
      ["2026-10-15", "GLM 5.3 (retires today)"],
      ["2026-10-01", "GLM 5.3 (retired)"],
    ])("%s gives %p", (date, expected) => {
      expect(formatDeprecatedModelName("GLM 5.3", date, now)).toBe(expected);
    });

    it("keeps the name without a valid date", () => {
      expect(formatDeprecatedModelName("GLM 5.3", undefined, now)).toBe("GLM 5.3");
      expect(formatDeprecatedModelName("GLM 5.3", "2026-02-30", now)).toBe("GLM 5.3");
    });
  });

  describe("model picker information", () => {
    const now = new Date("2026-10-15T10:00:00Z");

    function pickerInfo() {
      const discovery = new NvidiaModelDiscoveryService(makeSecrets(), "test-ua");
      return discovery.mapToChatInformation([{ id: MODEL_ID, ...MODEL_LIST[MODEL_ID] }], now)[0];
    }

    it("adds the countdown to the name and as a warning banner for a model with a retirement date", () => {
      const info = withDeprecationDate(MODEL_ID, "2026-10-30", pickerInfo);

      expect(info.name).toBe("GLM 5.3 (retires in 15 days)");
      expect(info.tooltip).toBe("NVIDIA NIM GLM 5.3");
      expect(info.warningText).toEqual({
        [DEPRECATION_WARNING_KEY]:
          "NVIDIA retires this model on October 30, 2026, in 15 days. Switch to another model before then.",
      });
    });

    it("adds no warning for a model without a retirement date", () => {
      const info = withDeprecationDate(MODEL_ID, undefined, pickerInfo);

      expect(info.name).toBe("GLM 5.3");
      expect(info).not.toHaveProperty("warningText");
    });

    it("ships no curated model with an invalid retirement date", () => {
      for (const [id, entry] of Object.entries(MODEL_LIST)) {
        if (entry.deprecationDate !== undefined) {
          expect({ id, parsed: parseDeprecationDate(entry.deprecationDate) }).toEqual({
            id,
            parsed: expect.any(Number),
          });
        }
      }
    });
  });

  describe("midnight refresh", () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it("measures the time to the next midnight UTC", () => {
      expect(msUntilNextUtcMidnight(new Date("2026-10-15T23:00:00Z"))).toBe(60 * 60 * 1000);
      expect(msUntilNextUtcMidnight(new Date("2026-10-15T00:00:00Z"))).toBe(24 * 60 * 60 * 1000);
    });

    it("schedules nothing when no curated model has a retirement date", () => {
      jest.useFakeTimers();
      const onMidnight = jest.fn();
      const ids = Object.keys(MODEL_LIST).filter((id) => MODEL_LIST[id].deprecationDate);
      const saved = ids.map((id) => MODEL_LIST[id].deprecationDate);
      ids.forEach((id) => (MODEL_LIST[id].deprecationDate = undefined));
      try {
        expect(hasScheduledDeprecations()).toBe(false);
        const timer = scheduleDeprecationCountdownRefresh(onMidnight);
        expect(jest.getTimerCount()).toBe(0);
        timer.dispose();
      } finally {
        ids.forEach((id, index) => (MODEL_LIST[id].deprecationDate = saved[index]));
      }
    });

    it("fires at every midnight UTC until disposed", () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date("2026-10-15T23:00:00Z"));
      const onMidnight = jest.fn();

      withDeprecationDate(MODEL_ID, "2026-10-30", () => {
        const timer = scheduleDeprecationCountdownRefresh(onMidnight);

        jest.advanceTimersByTime(60 * 60 * 1000 - 1);
        expect(onMidnight).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(onMidnight).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(24 * 60 * 60 * 1000);
        expect(onMidnight).toHaveBeenCalledTimes(2);

        timer.dispose();
        expect(jest.getTimerCount()).toBe(0);
        jest.advanceTimersByTime(48 * 60 * 60 * 1000);
        expect(onMidnight).toHaveBeenCalledTimes(2);
      });
    });

    it("refreshPickerInfo asks VS Code to re-read the model list", () => {
      const provider = new NimChatModelProvider(makeSecrets(), "test-ua");
      const listener = jest.fn();
      provider.onDidChangeLanguageModelChatInformation(listener);

      provider.refreshPickerInfo();

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});
