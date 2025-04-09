import { EJSON } from 'meteor/ejson';
import { Meteor } from 'meteor/meteor';
import type { Filter, Hint, Sort } from 'mongodb';

import { IdMap } from './IdMap';
import { LocalCollection } from './LocalCollection';
import { Matcher } from './Matcher';
import type { ObserveCallbacks } from './ObserveCallbacks';
import type { ObserveChangesCallbacks } from './ObserveChangesCallbacks';
import { ObserveHandle } from './ObserveHandle';
import type { Query } from './Query';
import { Sorter } from './Sorter';
import { hasOwn } from './common';

export type SortSpecifier = Sort;

type FieldSpecifier = {
	[id: string]: number | boolean;
};

export type Selector<T> = Filter<T>;

type Transform<T> = ((doc: T) => any) | null | undefined;

export type DispatchTransform<TTransform, T, TProjection> = TTransform extends (...args: any) => any
	? ReturnType<TTransform>
	: TTransform extends null
		? T
		: TProjection;

export type Options<T> = {
	/** Sort order (default: natural order) */
	sort?: SortSpecifier | undefined;
	/** Number of results to skip at the beginning */
	skip?: number | undefined;
	/** Maximum number of results to return */
	limit?: number | undefined;
	/**
	 * Dictionary of fields to return or exclude.
	 * @deprecated use projection instead
	 */
	fields?: FieldSpecifier | undefined;
	/** Dictionary of fields to return or exclude. */
	projection?: FieldSpecifier | undefined;
	/** (Server only) Overrides MongoDB's default index selection and query optimization process. Specify an index to force its use, either by its name or index specification. */
	hint?: Hint | undefined;
	/** (Client only) Default `true`; pass `false` to disable reactivity */
	reactive?: boolean | undefined;
	/**  Overrides `transform` on the  [`Collection`](#collections) for this cursor.  Pass `null` to disable transformation. */
	transform?: Transform<T> | undefined;
};

// Cursor: a specification for a particular subset of documents, w/ a defined
// order, limit, and offset.  creating a Cursor with LocalCollection.find(),
export class Cursor<T extends { _id: string }, TOptions extends Options<T>, TProjection extends T = T> {
	collection: LocalCollection<T>;

	sorter: Sorter<T> | null = null;

	matcher: Matcher<T>;

	private _selectorId: T['_id'] | undefined;

	skip: number;

	limit: number | undefined;

	fields: FieldSpecifier | undefined;

	private _projectionFn: (doc: Omit<T, '_id'>) => TProjection;

	private _transform: TOptions['transform'];

	reactive: boolean | undefined;

	// don't call this ctor directly.  use LocalCollection.find().
	constructor(collection: LocalCollection<T>, selector: Selector<T>, options?: TOptions) {
		this.collection = collection;
		this.sorter = null;
		this.matcher = new Matcher(selector);

		if (LocalCollection._selectorIsIdPerhapsAsObject(selector)) {
			// stash for fast _id and { _id }
			this._selectorId = hasOwn.call(selector, '_id') ? (selector._id as any) : selector;
		} else {
			this._selectorId = undefined;

			if (this.matcher.hasGeoQuery() || options?.sort) {
				this.sorter = new Sorter(options?.sort || []);
			}
		}

		this.skip = options?.skip || 0;
		this.limit = options?.limit;
		this.fields = options?.projection || options?.fields;

		this._projectionFn = LocalCollection._compileProjection(this.fields || {});

		this._transform = LocalCollection.wrapTransform(options?.transform);

		// by default, queries register w/ Tracker when it is available.
		if (typeof Tracker !== 'undefined') {
			this.reactive = options?.reactive === undefined ? true : options.reactive;
		}
	}

	/**
	 * @deprecated in 2.9
	 * @summary Returns the number of documents that match a query. This method is
	 *          [deprecated since MongoDB 4.0](https://www.mongodb.com/docs/v4.4/reference/command/count/);
	 *          see `Collection.countDocuments` and
	 *          `Collection.estimatedDocumentCount` for a replacement.
	 * @memberOf Mongo.Cursor
	 * @method  count
	 * @instance
	 * @locus Anywhere
	 * @returns {Number}
	 */
	count(): number {
		if (this.reactive) {
			// allow the observe to be unordered
			this._depend({ added: true, removed: true }, true);
		}

		return this._getRawObjects({
			ordered: true,
		}).length;
	}

	/**
	 * @summary Return all matching documents as an Array.
	 * @memberOf Mongo.Cursor
	 * @method  fetch
	 * @instance
	 * @locus Anywhere
	 * @returns {Object[]}
	 */
	fetch(): DispatchTransform<TOptions['transform'], T, TProjection>[] {
		const result: DispatchTransform<TOptions['transform'], T, TProjection>[] = [];

		this.forEach((doc) => {
			result.push(doc);
		});

		return result;
	}

	[Symbol.iterator](): Iterator<DispatchTransform<TOptions['transform'], T, TProjection>> {
		if (this.reactive) {
			this._depend({
				addedBefore: true,
				removed: true,
				changed: true,
				movedBefore: true,
			});
		}

		let index = 0;
		const objects = this._getRawObjects({ ordered: true });

		return {
			next: () => {
				if (index < objects.length) {
					// This doubles as a clone operation.
					const element = this._projectionFn(objects[index++]);

					if (this._transform) {
						return { value: this._transform(element) };
					}

					return { value: element };
				}

				return { value: undefined, done: true };
			},
		};
	}

	[Symbol.asyncIterator](): AsyncIterator<DispatchTransform<TOptions['transform'], T, TProjection>> {
		const syncResult = this[Symbol.iterator]();
		return {
			async next() {
				return Promise.resolve(syncResult.next());
			},
		};
	}

	/**
	 * @callback IterationCallback
	 * @param {Object} doc
	 * @param {Number} index
	 */
	/**
	 * @summary Call `callback` once for each matching document, sequentially and
	 *          synchronously.
	 * @locus Anywhere
	 * @method  forEach
	 * @instance
	 * @memberOf Mongo.Cursor
	 * @param {IterationCallback} callback Function to call. It will be called
	 *                                     with three arguments: the document, a
	 *                                     0-based index, and <em>cursor</em>
	 *                                     itself.
	 * @param {Any} [thisArg] An object which will be the value of `this` inside
	 *                        `callback`.
	 */
	forEach<TIterationCallback extends (doc: DispatchTransform<TOptions['transform'], T, TProjection>, index: number, cursor: this) => void>(
		callback: TIterationCallback,
		thisArg?: ThisParameterType<TIterationCallback>,
	): void {
		if (this.reactive) {
			this._depend({
				addedBefore: true,
				removed: true,
				changed: true,
				movedBefore: true,
			});
		}

		this._getRawObjects({ ordered: true }).forEach((element: T, i: number) => {
			// This doubles as a clone operation.
			const projection = this._projectionFn(element);

			if (this._transform) {
				callback.call(thisArg, this._transform(projection), i, this);
				return;
			}

			callback.call(thisArg, projection as DispatchTransform<TOptions['transform'], T, TProjection>, i, this);
		});
	}

	getTransform() {
		return this._transform;
	}

	/**
	 * @summary Map callback over all matching documents.  Returns an Array.
	 * @locus Anywhere
	 * @method map
	 * @instance
	 * @memberOf Mongo.Cursor
	 * @param {IterationCallback} callback Function to call. It will be called
	 *                                     with three arguments: the document, a
	 *                                     0-based index, and <em>cursor</em>
	 *                                     itself.
	 * @param {Any} [thisArg] An object which will be the value of `this` inside
	 *                        `callback`.
	 */
	map<TIterationCallback extends (doc: DispatchTransform<TOptions['transform'], T, TProjection>, index: number, cursor: this) => unknown>(
		callback: TIterationCallback,
		thisArg?: ThisParameterType<TIterationCallback>,
	): ReturnType<TIterationCallback>[] {
		const result: ReturnType<TIterationCallback>[] = [];

		this.forEach((doc, i) => {
			result.push(callback.call(thisArg, doc, i, this) as ReturnType<TIterationCallback>);
		});

		return result;
	}

	// options to contain:
	//  * callbacks for observe():
	//    - addedAt (document, atIndex)
	//    - added (document)
	//    - changedAt (newDocument, oldDocument, atIndex)
	//    - changed (newDocument, oldDocument)
	//    - removedAt (document, atIndex)
	//    - removed (document)
	//    - movedTo (document, oldIndex, newIndex)
	//
	// attributes available on returned query handle:
	//  * stop(): end updates
	//  * collection: the collection this query is querying
	//
	// iff x is a returned query handle, (x instanceof
	// LocalCollection.ObserveHandle) is true
	//
	// initial results delivered through added callback
	// XXX maybe callbacks should take a list of objects, to expose transactions?
	// XXX maybe support field limiting (to limit what you're notified on)

	/**
	 * @summary Watch a query.  Receive callbacks as the result set changes.
	 * @locus Anywhere
	 * @memberOf Mongo.Cursor
	 * @instance
	 * @param {Object} callbacks Functions to call to deliver the result set as it
	 *                           changes
	 */
	observe(options: ObserveCallbacks<TProjection>) {
		return LocalCollection._observeFromObserveChanges(this, options);
	}

	/**
	 * @summary Watch a query.  Receive callbacks as the result set changes.
	 * @locus Anywhere
	 * @memberOf Mongo.Cursor
	 * @instance
	 */
	observeAsync(options: ObserveCallbacks<TProjection>) {
		return new Promise((resolve) => resolve(this.observe(options)));
	}

	/**
	 * @summary Watch a query. Receive callbacks as the result set changes. Only
	 *          the differences between the old and new documents are passed to
	 *          the callbacks.
	 * @locus Anywhere
	 * @memberOf Mongo.Cursor
	 * @instance
	 * @param {Object} callbacks Functions to call to deliver the result set as it
	 *                           changes
	 */
	observeChanges(options: ObserveChangesCallbacks<TProjection>) {
		const ordered = LocalCollection._observeChangesCallbacksAreOrdered(options);

		// there are several places that assume you aren't combining skip/limit with
		// unordered observe.  eg, update's EJSON.clone, and the "there are several"
		// comment in _modifyAndNotify
		// XXX allow skip/limit with unordered observe
		if (!options._allow_unordered && !ordered && (this.skip || this.limit)) {
			throw new Error(
				"Must use an ordered observe with skip or limit (i.e. 'addedBefore' " +
					"for observeChanges or 'addedAt' for observe, instead of 'added').",
			);
		}

		if (this.fields && (this.fields._id === 0 || this.fields._id === false)) {
			throw Error('You may not observe a cursor with {fields: {_id: 0}}');
		}

		const distances = this.matcher.hasGeoQuery() && ordered ? new IdMap<T['_id'], number>() : undefined;

		const query: Query<T, TOptions, TProjection> = {
			cursor: this,
			dirty: false,
			distances,
			matcher: this.matcher, // not fast pathed
			ordered,
			projectionFn: this._projectionFn,
			resultsSnapshot: null,
			sorter: ordered && this.sorter,
		};

		let qid: number;

		// Non-reactive queries call added[Before] and then never call anything
		// else.
		if (this.reactive) {
			qid = this.collection.next_qid++;
			this.collection.queries[qid] = query;
		}

		query.results = this._getRawObjects({
			ordered,
			distances: query.distances,
		});

		if (this.collection.paused) {
			query.resultsSnapshot = ordered ? [] : new IdMap<T['_id'], T>();
		}

		// wrap callbacks we were passed. callbacks only fire when not paused and
		// are never undefined
		// Filters out blacklisted fields according to cursor's projection.
		// XXX wrong place for this?

		// furthermore, callbacks enqueue until the operation we're working on is
		// done.
		const wrapCallback = <TFn extends (...args: any) => any>(fn: TFn | undefined) => {
			if (!fn) {
				// eslint-disable-next-line @typescript-eslint/no-empty-function
				return () => {};
			}

			// eslint-disable-next-line @typescript-eslint/no-this-alias
			const self = this;

			return function (this: ThisParameterType<TFn>, ...args: Parameters<TFn>) {
				if (self.collection.paused) {
					return;
				}

				self.collection._observeQueue.queueTask(() => {
					fn.apply(this, args);
				});
			};
		};

		query.added = wrapCallback(options.added);
		query.changed = wrapCallback(options.changed);
		query.removed = wrapCallback(options.removed);

		if (ordered) {
			query.addedBefore = wrapCallback(options.addedBefore);
			query.movedBefore = wrapCallback(options.movedBefore);
		}

		if (!options._suppress_initial && !this.collection.paused) {
			const handler = (doc: T) => {
				const fields: Omit<T, '_id'> & { _id?: string } = EJSON.clone(doc);

				delete fields._id;

				if (ordered) {
					query.addedBefore!(doc._id, this._projectionFn(fields), null);
				}

				query.added!(doc._id, this._projectionFn(fields));
			};
			// it means it's just an array
			if ((query.results as T[]).length) {
				for (const doc of query.results as T[]) {
					handler(doc);
				}
			}
			// it means it's an id map
			if ((query.results as IdMap<T['_id'], T>).size?.()) {
				(query.results as IdMap<T['_id'], T>).forEach(handler);
			}
		}

		const handle = Object.assign(new ObserveHandle(), {
			collection: this.collection,
			stop: () => {
				if (this.reactive) {
					delete this.collection.queries[qid];
				}
			},
			isReady: false,
			isReadyPromise: null as unknown as Promise<void>,
		});

		if (this.reactive && Tracker.active) {
			// XXX in many cases, the same observe will be recreated when
			// the current autorun is rerun.  we could save work by
			// letting it linger across rerun and potentially get
			// repurposed if the same observe is performed, using logic
			// similar to that of Meteor.subscribe.
			Tracker.onInvalidate(() => {
				handle.stop();
			});
		}

		// run the observe callbacks resulting from the initial contents
		// before we leave the observe.
		const drainResult = this.collection._observeQueue.drain();

		if (drainResult instanceof Promise) {
			handle.isReadyPromise = drainResult;
			// eslint-disable-next-line no-return-assign
			drainResult.then(() => (handle.isReady = true));
		} else {
			handle.isReady = true;
			handle.isReadyPromise = Promise.resolve();
		}

		return handle;
	}

	/**
	 * @summary Watch a query. Receive callbacks as the result set changes. Only
	 *          the differences between the old and new documents are passed to
	 *          the callbacks.
	 * @locus Anywhere
	 * @memberOf Mongo.Cursor
	 * @instance
	 * @param {Object} callbacks Functions to call to deliver the result set as it
	 *                           changes
	 */
	observeChangesAsync(options: ObserveChangesCallbacks<TProjection>) {
		return new Promise((resolve) => {
			const handle = this.observeChanges(options);
			handle.isReadyPromise.then(() => resolve(handle));
		});
	}

	// XXX Maybe we need a version of observe that just calls a callback if
	// anything changed.
	_depend(changers: Partial<Record<'added' | 'addedBefore' | 'changed' | 'movedBefore' | 'removed', boolean>>, _allowUnordered?: boolean) {
		if (Tracker.active) {
			const dependency = new Tracker.Dependency();
			const notify = dependency.changed.bind(dependency);

			dependency.depend();

			const options: ObserveChangesCallbacks<TProjection> = {
				_allow_unordered: _allowUnordered,
				_suppress_initial: true,
			};

			(['added', 'addedBefore', 'changed', 'movedBefore', 'removed'] as const).forEach((fn) => {
				if (changers[fn]) {
					options[fn] = notify;
				}
			});

			// observeChanges will stop() when this computation is invalidated
			this.observeChanges(options);
		}
	}

	_getCollectionName() {
		return null;
	}

	// Returns a collection of matching objects, but doesn't deep copy them.
	//
	// If ordered is set, returns a sorted array, respecting sorter, skip, and
	// limit properties of the query provided that options.applySkipLimit is
	// not set to false (#1201). If sorter is falsey, no sort -- you get the
	// natural order.
	//
	// If ordered is not set, returns an object mapping from ID to doc (sorter,
	// skip and limit should not be set).
	//
	// If ordered is set and this cursor is a $near geoquery, then this function
	// will use an _IdMap to track each distance from the $near argument point in
	// order to use it as a sort key. If an _IdMap is passed in the 'distances'
	// argument, this function will clear it and use it for this purpose
	// (otherwise it will just create its own _IdMap). The observeChanges
	// implementation uses this to remember the distances after this function
	// returns.
	_getRawObjects(options: { ordered: true; applySkipLimit?: boolean; distances?: IdMap<T['_id'], number> }): T[];

	_getRawObjects(options: { ordered: false; applySkipLimit?: boolean; distances?: IdMap<T['_id'], number> }): IdMap<T['_id'], T>;

	_getRawObjects(options?: { ordered?: boolean; applySkipLimit?: boolean; distances?: IdMap<T['_id'], number> }): IdMap<T['_id'], T> | T[];

	_getRawObjects(
		options: { ordered?: boolean; applySkipLimit?: boolean; distances?: IdMap<T['_id'], number> } = {},
	): IdMap<T['_id'], T> | T[] {
		// By default this method will respect skip and limit because .fetch(),
		// .forEach() etc... expect this behaviour. It can be forced to ignore
		// skip and limit by setting applySkipLimit to false (.count() does this,
		// for example)
		const applySkipLimit = options.applySkipLimit !== false;

		// XXX use OrderedDict instead of array, and make IdMap and OrderedDict
		// compatible
		const results: T[] | IdMap<T['_id'], T> = options.ordered ? [] : new IdMap<T['_id'], T>();

		// fast path for single ID value
		if (this._selectorId !== undefined) {
			// If you have non-zero skip and ask for a single id, you get nothing.
			// This is so it matches the behavior of the '{_id: foo}' path.
			if (applySkipLimit && this.skip) {
				return results;
			}

			const selectedDoc = this.collection._docs.get(this._selectorId);
			if (selectedDoc) {
				if (options.ordered) {
					(results as T[]).push(selectedDoc);
				} else {
					(results as IdMap<T['_id'], T>).set(this._selectorId, selectedDoc);
				}
			}
			return results;
		}

		// slow path for arbitrary selector, sort, skip, limit

		// in the observeChanges case, distances is actually part of the "query"
		// (ie, live results set) object.  in other cases, distances is only used
		// inside this function.
		let distances: IdMap<T['_id'], number> | undefined;
		if (this.matcher.hasGeoQuery() && options.ordered) {
			if (options.distances) {
				distances = options.distances;
				distances.clear();
			} else {
				distances = new IdMap<T['_id'], number>();
			}
		}

		Meteor._runFresh(() => {
			this.collection._docs.forEach((doc, id) => {
				const matchResult = this.matcher.documentMatches(doc);
				if (matchResult.result) {
					if (options.ordered) {
						(results as T[]).push(doc);

						if (distances && matchResult.distance !== undefined) {
							distances.set(id, matchResult.distance);
						}
					} else {
						(results as IdMap<T['_id'], T>).set(id, doc);
					}
				}

				// Override to ensure all docs are matched if ignoring skip & limit
				if (!applySkipLimit) {
					return true;
				}

				// Fast path for limited unsorted queries.
				// XXX 'length' check here seems wrong for ordered
				return !this.limit || !!this.skip || !!this.sorter || (results as T[]).length !== this.limit;
			});
		});

		if (!options.ordered) {
			return results;
		}

		if (this.sorter) {
			(results as T[]).sort(this.sorter.getComparator({ distances }));
		}

		// Return the full set of results if there is no skip or limit or if we're
		// ignoring them
		if (!applySkipLimit || (!this.limit && !this.skip)) {
			return results;
		}

		return (results as T[]).slice(this.skip, this.limit ? this.limit + this.skip : (results as T[]).length);
	}

	/**
	 * @deprecated in 2.9
	 * @summary Returns the number of documents that match a query. This method is
	 *          [deprecated since MongoDB 4.0](https://www.mongodb.com/docs/v4.4/reference/command/count/);
	 *          see `Collection.countDocuments` and
	 *          `Collection.estimatedDocumentCount` for a replacement.
	 * @memberOf Mongo.Cursor
	 * @method  countAsync
	 * @instance
	 * @locus Anywhere
	 * @returns {Promise}
	 */
	countAsync(): Promise<number> {
		try {
			return Promise.resolve(this.count());
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/**
	 * @summary Return all matching documents as an Array.
	 * @memberOf Mongo.Cursor
	 * @method  fetchAsync
	 * @instance
	 * @locus Anywhere
	 * @returns {Promise}
	 */
	fetchAsync(): Promise<DispatchTransform<TOptions['transform'], T, TProjection>[]> {
		try {
			return Promise.resolve(this.fetch());
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/**
	 * @summary Call `callback` once for each matching document, sequentially and
	 *          synchronously.
	 * @locus Anywhere
	 * @method  forEachAsync
	 * @instance
	 * @memberOf Mongo.Cursor
	 * @param {IterationCallback} callback Function to call. It will be called
	 *                                     with three arguments: the document, a
	 *                                     0-based index, and <em>cursor</em>
	 *                                     itself.
	 * @param {Any} [thisArg] An object which will be the value of `this` inside
	 *                        `callback`.
	 * @returns {Promise}
	 */
	forEachAsync<
		TIterationCallback extends (doc: DispatchTransform<TOptions['transform'], T, TProjection>, index: number, cursor: this) => void,
	>(callback: TIterationCallback, thisArg: ThisParameterType<TIterationCallback>): Promise<void> {
		try {
			return Promise.resolve(this.forEach(callback, thisArg));
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/**
	 * @summary Map callback over all matching documents.  Returns an Array.
	 * @locus Anywhere
	 * @method mapAsync
	 * @instance
	 * @memberOf Mongo.Cursor
	 * @param {IterationCallback} callback Function to call. It will be called
	 *                                     with three arguments: the document, a
	 *                                     0-based index, and <em>cursor</em>
	 *                                     itself.
	 * @param {Any} [thisArg] An object which will be the value of `this` inside
	 *                        `callback`.
	 * @returns {Promise}
	 */
	mapAsync<TIterationCallback extends (doc: DispatchTransform<TOptions['transform'], T, TProjection>, index: number, cursor: this) => any>(
		callback: TIterationCallback,
		thisArg: ThisParameterType<TIterationCallback>,
	): Promise<ReturnType<TIterationCallback>[]> {
		try {
			return Promise.resolve(this.map(callback, thisArg));
		} catch (error) {
			return Promise.reject(error);
		}
	}
}
