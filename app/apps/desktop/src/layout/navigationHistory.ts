export interface NavigationSnapshot {
  entries: readonly string[];
  index: number;
}

export class NavigationHistory {
  private entries: string[] = [];
  private index = -1;

  snapshot(): NavigationSnapshot {
    return { entries: [...this.entries], index: this.index };
  }

  reset(): void {
    this.entries = [];
    this.index = -1;
  }

  commit(path: string): void {
    if (!path || this.entries[this.index] === path) return;
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push(path);
    this.index = this.entries.length - 1;
  }

  back(): string | null {
    if (this.index <= 0) return null;
    this.index -= 1;
    return this.entries[this.index] ?? null;
  }

  forward(): string | null {
    if (this.index < 0 || this.index >= this.entries.length - 1) return null;
    this.index += 1;
    return this.entries[this.index] ?? null;
  }

  remap(from: string, to: string): void {
    const map = (path: string) => path === from
      ? to
      : path.startsWith(`${from}/`)
        ? to + path.slice(from.length)
        : path;
    this.entries = this.entries.map(map).filter((path, index, all) => index === 0 || path !== all[index - 1]);
    this.index = Math.min(this.index, this.entries.length - 1);
  }

  prune(paths: string[]): void {
    const current = this.entries[this.index] ?? null;
    const gone = (path: string) => paths.some((root) => path === root || path.startsWith(`${root}/`));
    this.entries = this.entries.filter((path) => !gone(path));
    this.index = current ? this.entries.indexOf(current) : -1;
    if (this.index < 0) this.index = this.entries.length - 1;
  }
}

export const navigationHistory = new NavigationHistory();
