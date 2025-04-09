import type { Cursor, Options } from './Cursor';
import type { IdMap } from './IdMap';
import type { Matcher } from './Matcher';
import type { Sorter } from './Sorter';

export type Query<T extends { _id: string }, TOptions extends Options<T>, TProjection extends T = T> = {
	cursor: Cursor<T, TOptions, TProjection>;
	dirty: boolean;
	distances?: IdMap<T['_id'], number>;
	matcher: Matcher<T>;
	ordered: boolean;
	projectionFn: (doc: Omit<T, '_id'>) => TProjection;
	resultsSnapshot?: IdMap<T['_id'], T> | T[] | null;
	sorter: Sorter<T> | null | boolean;
	results?: T[] | IdMap<T['_id'], T>;
	added?: (id: T['_id'], fields: TProjection) => void;
	changed?: (id: T['_id'], fields: TProjection) => void;
	removed?: (id: T['_id']) => void;
	addedBefore?: (id: T['_id'], fields: TProjection, before: T['_id'] | null) => void;
	movedBefore?: (id: T['_id'], before: T['_id'] | null) => void;
};
