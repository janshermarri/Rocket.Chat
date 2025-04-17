import type { CountDocumentsOptions, Filter, UpdateFilter } from 'mongodb';

import type { Cursor, DispatchTransform } from './Cursor';
import type { IIdMap } from './IIdMap';
import type { Options } from './MinimongoCollection';
import type { Query } from './Query';

export interface ILocalCollection<T extends { _id: string }> {
	next_qid: number;
	queries: Record<string, Query<T, Options<T>, any>>;
	paused: boolean;
	countDocuments(selector?: Filter<T>, options?: CountDocumentsOptions): Promise<number>;
	estimatedDocumentCount(options: CountDocumentsOptions): Promise<number>;
	find(selector?: Filter<T> | T['_id']): Cursor<T, Options<T>, T>;
	find<O extends Options<T>>(selector?: Filter<T> | T['_id'], options?: O): Cursor<T, O, DispatchTransform<O['transform'], T, T>>;
	findOne(selector?: Filter<T> | T['_id']): T | undefined;
	findOne<O extends Omit<Options<T>, 'limit'>>(
		selector?: Filter<T> | T['_id'],
		options?: O,
	): DispatchTransform<O['transform'], T, T> | undefined;
	findOneAsync(selector?: Filter<T> | T['_id']): Promise<T | undefined>;
	findOneAsync<O extends Omit<Options<T>, 'limit'>>(
		selector?: Filter<T> | T['_id'],
		options?: O,
	): Promise<DispatchTransform<O['transform'], T, T> | undefined>;
	prepareInsert(doc: T): string;
	insert(doc: T, callback?: (error: Error | null, id: string) => void): string;
	insertAsync(doc: T, callback?: (error: Error | null, id: string) => void): Promise<string>;
	pauseObservers(): void;
	clearResultQueries(callback: (error: Error | null, result: number) => void): number;
	prepareRemove(selector: Filter<T>): {
		queriesToRecompute: string[];
		queryRemove: { qid: string; doc: T }[];
		remove: T['_id'][];
	};
	remove(selector: Filter<T>, callback?: (error: Error | null, result: number) => void): number;
	resumeObserversServer(): Promise<void>;
	resumeObserversClient(): void;
	retrieveOriginals(): IIdMap<T['_id'], T | undefined>;
	saveOriginals(): void;
	prepareUpdate(selector: Filter<T>): Record<string, IIdMap<T['_id'], T> | T[]>;
	finishUpdate(params: {
		options: { _returnObject?: boolean };
		updateCount: number;
		callback: (error: Error | null, result: number | { numberAffected: number; insertedId?: string }) => void;
		insertedId?: string;
		selector?: unknown;
		mod?: UpdateFilter<T>;
	}): { numberAffected: number; insertedId?: string } | number;
	updateAsync(
		selector: Filter<T>,
		mod: UpdateFilter<T>,
		callback: (
			error: Error | null,
			result:
				| number
				| {
						numberAffected: number;
						insertedId?: string;
				  },
		) => void,
	): Promise<{ numberAffected: number; insertedId?: string } | number>;
	updateAsync(
		selector: Filter<T>,
		mod: UpdateFilter<T>,
		options: { multi?: boolean; upsert?: boolean; insertedId?: string; _returnObject?: boolean } | null,
		callback: (
			error: Error | null,
			result:
				| number
				| {
						numberAffected: number;
						insertedId?: string;
				  },
		) => void,
	): Promise<{ numberAffected: number; insertedId?: string } | number>;
	update(
		selector: Filter<T>,
		mod: UpdateFilter<T>,
		callback: (
			error: Error | null,
			result:
				| number
				| {
						numberAffected: number;
						insertedId?: string;
				  },
		) => void,
	): { numberAffected: number; insertedId?: string } | number;
	update(
		selector: Filter<T>,
		mod: UpdateFilter<T>,
		options: { multi?: boolean; upsert?: boolean; insertedId?: string; _returnObject?: boolean } | null,
		callback: (
			error: Error | null,
			result:
				| number
				| {
						numberAffected: number;
						insertedId?: string;
				  },
		) => void,
	): { numberAffected: number; insertedId?: string } | number;
	upsert(
		selector: Filter<T>,
		mod: UpdateFilter<T>,
		callback: (
			error: Error | null,
			result:
				| number
				| {
						numberAffected: number;
						insertedId?: string;
				  },
		) => void,
	): { numberAffected: number; insertedId?: string } | number;
	upsert(
		selector: Filter<T>,
		mod: UpdateFilter<T>,
		options: { multi?: boolean; upsert?: boolean; insertedId?: string; _returnObject?: boolean } | null,
		callback: (
			error: Error | null,
			result:
				| number
				| {
						numberAffected: number;
						insertedId?: string;
				  },
		) => void,
	): { numberAffected: number; insertedId?: string } | number;
	upsertAsync(
		selector: Filter<T>,
		mod: UpdateFilter<T>,
		callback: (
			error: Error | null,
			result:
				| number
				| {
						numberAffected: number;
						insertedId?: string;
				  },
		) => void,
	): Promise<{ numberAffected: number; insertedId?: string } | number>;
	upsertAsync(
		selector: Filter<T>,
		mod: UpdateFilter<T>,
		options: { multi?: boolean; upsert?: boolean; insertedId?: string; _returnObject?: boolean } | null,
		callback: (
			error: Error | null,
			result:
				| number
				| {
						numberAffected: number;
						insertedId?: string;
				  },
		) => void,
	): Promise<{ numberAffected: number; insertedId?: string } | number>;
}
