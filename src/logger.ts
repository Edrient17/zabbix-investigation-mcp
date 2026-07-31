import type { AppConfig } from "./types.js";

const priorities = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
} as const;

export class Logger {
  constructor(private readonly level: AppConfig["logLevel"]) {}

  debug(message: string, fields: Record<string, unknown> = {}): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields: Record<string, unknown> = {}): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields: Record<string, unknown> = {}): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields: Record<string, unknown> = {}): void {
    this.write("error", message, fields);
  }

  private write(
    level: keyof typeof priorities,
    message: string,
    fields: Record<string, unknown>,
  ): void {
    if (priorities[level] < priorities[this.level]) {
      return;
    }

    const record = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...fields,
    });

    if (level === "error") {
      console.error(record);
    } else {
      console.log(record);
    }
  }
}
