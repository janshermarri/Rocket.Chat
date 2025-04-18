import type { _CachingChangeObserver } from './Cursor';

export type ObserveChangesCallbacks<T extends { _id: string }> = {
	addedBefore?: (this: _CachingChangeObserver<T>, id: T['_id'], fields: T, before: T['_id'] | null) => void;
	changed?: (this: _CachingChangeObserver<T>, id: T['_id'], fields: T) => void;
	movedBefore?: (this: _CachingChangeObserver<T>, id: T['_id'], before: T['_id'] | null) => void;
	removed?: (this: _CachingChangeObserver<T>, id: T['_id']) => void;
	added?: (this: _CachingChangeObserver<T>, id: T['_id'], fields: T) => void;
	_allow_unordered?: boolean;
	_suppress_initial?: boolean;
};
