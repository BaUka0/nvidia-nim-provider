/**
 * Insertion-order map that evicts the least-recently-used entry once `maxSize`
 * is exceeded. Both `get` and `set` refresh recency so a hot key is not
 * dropped while colder keys remain.
 */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly maxSize: number) {
    super();
  }

  override get(key: K): V | undefined {
    if (!super.has(key)) {
      return undefined;
    }
    const value = super.get(key) as V;
    super.delete(key);
    super.set(key, value);
    return value;
  }

  override set(key: K, value: V): this {
    if (super.has(key)) {
      super.delete(key);
    } else {
      while (this.size >= this.maxSize) {
        const oldestKey = this.keys().next().value;
        if (oldestKey === undefined) {
          break;
        }
        super.delete(oldestKey);
      }
    }
    super.set(key, value);
    return this;
  }
}
