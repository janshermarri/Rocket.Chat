export interface IIdMap<TId, TValue> {
	get(id: TId): TValue | undefined;
	set(id: TId, value: TValue): void;
	remove(id: TId): void;
	has(id: TId): boolean;
	empty(): boolean;
	clear(): void;
	forEach(iterator: (value: TValue, key: TId) => boolean | void): void;
	forEachAsync(iterator: (value: TValue, key: TId) => Promise<boolean | void>): Promise<void>;
	size(): number;
}
