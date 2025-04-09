export type ObserveCallbacks<T> = {
	addedAt?: (document: T, atIndex: number | null, before: unknown) => void;
	added?: (document: T) => void;
	changedAt?: (newDocument: T, oldDocument: T, atIndex: number) => void;
	changed?: (newDocument: T, oldDocument: T) => void;
	removedAt?: (document: T, atIndex: number) => void;
	removed?: (document: T) => void;
	movedTo?: (document: T, oldIndex: number, newIndex: number, before: unknown) => void;
	addedBefore?: (document: T, before: unknown) => void;
	movedBefore?: (document: T, before: unknown) => void;
	_suppress_initial?: boolean;
	_no_indices?: boolean;
	_allow_unordered?: boolean;
};
