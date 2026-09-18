/** Least-recently-used, oldest first, with a say in what happens to evictions. */
export class Lru<T> {
  private items = new Map<string, T>();
  private limit: number;
  private onEvict: (value: T) => void;

  constructor(limit: number, onEvict: (value: T) => void = () => {}) {
    this.limit = limit;
    this.onEvict = onEvict;
  }

  get size(): number {
    return this.items.size;
  }

  get(key: string): T | null {
    const value = this.items.get(key);
    if (value === undefined) return null;
    this.items.delete(key);
    this.items.set(key, value);
    return value;
  }

  set(key: string, value: T): T {
    this.items.delete(key);
    this.items.set(key, value);
    if (this.items.size > this.limit) {
      const oldest = this.items.keys().next().value!;
      this.onEvict(this.items.get(oldest)!);
      this.items.delete(oldest);
    }
    return value;
  }

  clear(): void {
    for (const value of this.items.values()) this.onEvict(value);
    this.items.clear();
  }
}
