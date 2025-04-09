import type { LocalCollection } from './LocalCollection';

export type ObserveChangesCallbacks<T extends { _id: string }> = {
	addedBefore?: (
		this: InstanceType<typeof LocalCollection._CachingChangeObserver>,
		id: T['_id'],
		fields: T,
		before: T['_id'] | null,
	) => void;
	changed?: (this: InstanceType<typeof LocalCollection._CachingChangeObserver>, id: T['_id'], fields: T) => void;
	movedBefore?: (this: InstanceType<typeof LocalCollection._CachingChangeObserver>, id: T['_id'], before: T['_id'] | null) => void;
	removed?: (this: InstanceType<typeof LocalCollection._CachingChangeObserver>, id: T['_id']) => void;
	added?: (this: InstanceType<typeof LocalCollection._CachingChangeObserver>, id: T['_id'], fields: T) => void;
	_allow_unordered?: boolean;
	_suppress_initial?: boolean;
};
