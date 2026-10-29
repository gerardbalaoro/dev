import { stripVTControlCharacters } from "node:util";

export class Tail {
  private readonly capacity;

  private lines: string[] = [];
  private pending = "";

  constructor(capacity = 40) {
    this.capacity = capacity;
  }

  write(chunk: string): string[] {
    const parts = (this.pending + stripVTControlCharacters(chunk).replaceAll("\r", "\n")).split(
      "\n"
    );
    this.pending = (parts.pop() ?? "").slice(-4000);
    const completed = parts.map((line) => line.slice(-4000));
    this.lines = [...this.lines, ...completed].slice(-this.capacity);
    return completed;
  }

  getLines(count: number): string[] {
    return [...this.lines, ...(this.pending ? [this.pending] : [])].slice(-count);
  }
}

export interface Output {
  write: (chunk: string) => void;
  finish: (code: number) => void;
}
