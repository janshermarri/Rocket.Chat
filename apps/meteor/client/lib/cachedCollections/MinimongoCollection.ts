import { Mongo } from 'meteor/mongo';
import { create } from 'zustand';

import { LocalCollection } from './LocalCollection';

export type MinimongoSelector<T> = Mongo.Selector<T>;
export type MinimongoOptions<T> = Mongo.Options<T>;

interface IDocumentMapStore<T extends { _id: string }> {
	records: T[];
	get(_id: T['_id']): T | undefined;
	find<U extends T>(predicate: (record: T) => record is U): U | undefined;
	find(predicate: (record: T) => boolean): T | undefined;
	filter<U extends T>(predicate: (record: T) => record is U): U[];
	filter(predicate: (record: T) => boolean): T[];
	replaceAll(records: T[]): void;
}

export class MinimongoCollection<T extends { _id: string }> extends Mongo.Collection<T> {
	readonly use = create<IDocumentMapStore<T>>()((set, get) => ({
		records: [],
		get: (id: T['_id']) => get().records.find((record) => record._id === id),
		find: (predicate: (record: T) => boolean) => get().records.find(predicate),
		filter: (predicate: (record: T) => boolean) => get().records.filter(predicate),
		replaceAll: (records: T[]) => {
			set({ records: records.map<T>(Object.freeze) });
			this._collection.recomputeAllResults();
		},
	}));

	protected _collection = new LocalCollection<T>(this.use);

	constructor() {
		super(null);
	}

	get state() {
		return this.use.getState();
	}

	async bulkMutate(fn: () => Promise<void>) {
		this._collection.pauseObservers();
		await fn();
		this._collection.resumeObserversClient();
	}

	replaceAll(records: T[]) {
		this.state.replaceAll(records);
	}
}
