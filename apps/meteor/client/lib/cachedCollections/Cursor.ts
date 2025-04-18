import { EJSON } from 'meteor/ejson';
import { Meteor } from 'meteor/meteor';
import type { Filter } from 'mongodb';

import { DiffSequence } from './DiffSequence';
import { IdMap } from './IdMap';
import type { LocalCollection } from './LocalCollection';
import { Matcher } from './Matcher';
import type { FieldSpecifier, Options, Transform } from './MinimongoCollection';
import { ObserveHandle } from './ObserveHandle';
import { OrderedDict } from './OrderedDict';
import type { Query } from './Query';
import { Sorter } from './Sorter';
import { _isPlainObject, _selectorIsId, consumePairs, createMinimongoError, hasOwn, projectionDetails } from './common';

export type DispatchTransform<TTransform, T, TProjection> = TTransform extends (...args: any) => any
	? ReturnType<TTransform>
	: TTransform extends null
		? T
		: TProjection;

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

	private _projectionFn: (doc: Partial<T>) => TProjection;

	private _transform: TOptions['transform'];

	reactive: boolean | undefined;

	// don't call this ctor directly.  use LocalCollection.find().
	constructor(collection: LocalCollection<T>, selector: Filter<T> | T['_id'], options?: TOptions) {
		this.collection = collection;
		this.sorter = null;
		this.matcher = new Matcher(selector);

		if (this._selectorIsIdPerhapsAsObject(selector)) {
			// stash for fast _id and { _id }
			this._selectorId = hasOwn.call(selector, '_id') ? (selector as { _id?: string })._id : selector;
		} else {
			this._selectorId = undefined;

			if (this.matcher.hasGeoQuery() || options?.sort) {
				this.sorter = new Sorter(options?.sort || []);
			}
		}

		this.skip = options?.skip || 0;
		this.limit = options?.limit;
		this.fields = options?.projection || options?.fields;

		this._projectionFn = this._compileProjection(this.fields || {});

		this._transform = this.wrapTransform(options?.transform);

		// by default, queries register w/ Tracker when it is available.
		if (typeof Tracker !== 'undefined') {
			this.reactive = options?.reactive === undefined ? true : options.reactive;
		}
	}

	// Wrap a transform function to return objects that have the _id field
	// of the untransformed document. This ensures that subsystems such as
	// the observe-sequence package that call `observe` can keep track of
	// the documents identities.
	//
	// - Require that it returns objects
	// - If the return value has an _id field, verify that it matches the
	//   original _id field
	// - If the return value doesn't have an _id field, add it back.
	private wrapTransform(transform: (Transform<T> & { __wrappedTransform__?: boolean }) | null | undefined) {
		if (!transform) {
			return null;
		}

		// No need to doubly-wrap transforms.
		if (transform.__wrappedTransform__) {
			return transform;
		}

		const wrapped = (doc: any) => {
			if (!hasOwn.call(doc, '_id')) {
				// XXX do we ever have a transform on the oplog's collection? because that
				// collection has no _id.
				throw new Error('can only transform documents with _id');
			}

			const id = doc._id;

			// XXX consider making tracker a weak dependency and checking
			// Package.tracker here
			const transformed = Tracker.nonreactive(() => transform(doc));

			if (!_isPlainObject(transformed)) {
				throw new Error('transform must return object');
			}

			if (hasOwn.call(transformed, '_id')) {
				if (!EJSON.equals(transformed._id, id)) {
					throw new Error("transformed document can't have different _id");
				}
			} else {
				transformed._id = id;
			}

			return transformed;
		};

		wrapped.__wrappedTransform__ = true;

		return wrapped;
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
		return this._observeFromObserveChanges(options);
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
		const ordered = Cursor._observeChangesCallbacksAreOrdered(options);

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

		const query: Query<T, TOptions, TProjection> = ordered
			? {
					cursor: this,
					dirty: false,
					distances: this.matcher.hasGeoQuery() ? new IdMap<T['_id'], number>() : undefined,
					matcher: this.matcher, // not fast pathed
					ordered,
					projectionFn: this._projectionFn,
					resultsSnapshot: null,
					sorter: this.sorter!,
				}
			: {
					cursor: this,
					dirty: false,
					matcher: this.matcher, // not fast pathed
					ordered,
					projectionFn: this._projectionFn,
					resultsSnapshot: null,
					sorter: null,
				};

		let qid: string;

		// Non-reactive queries call added[Before] and then never call anything
		// else.
		if (this.reactive) {
			qid = this.collection.claimNextQueryId();
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

		if (query.ordered) {
			query.addedBefore = wrapCallback(options.addedBefore);
			query.movedBefore = wrapCallback(options.movedBefore);
		}

		if (!options._suppress_initial && !this.collection.paused) {
			const handler = (doc: T) => {
				const fields: Partial<T> & { _id?: string } = EJSON.clone(doc);

				delete fields._id;

				if (query.ordered) {
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
		this.collection._observeQueue.drain();

		handle.isReady = true;
		handle.isReadyPromise = Promise.resolve();

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
			consumePairs(this.collection._docs, (doc, id) => {
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

	private _observeFromObserveChanges(observeCallbacks: ObserveCallbacks<TProjection>) {
		const transform = this.getTransform() || ((doc: T) => doc);
		let suppressed = !!observeCallbacks._suppress_initial;

		let observeChangesCallbacks: ObserveChangesCallbacks<T>;
		if (this._observeCallbacksAreOrdered(observeCallbacks)) {
			// The "_no_indices" option sets all index arguments to -1 and skips the
			// linear scans required to generate them.  This lets observers that don't
			// need absolute indices benefit from the other features of this API --
			// relative order, transforms, and applyChanges -- without the speed hit.
			const indices = !observeCallbacks._no_indices;

			observeChangesCallbacks = {
				addedBefore(id, fields, before) {
					const check = suppressed || !(observeCallbacks.addedAt || observeCallbacks.added);
					if (check) {
						return;
					}

					const doc = transform(Object.assign(fields, { _id: id }));

					if (observeCallbacks.addedAt) {
						observeCallbacks.addedAt(
							doc,
							// eslint-disable-next-line no-nested-ternary
							indices ? (before ? (this.docs as OrderedDict<T['_id'], T>).indexOf(before) : this.docs.size()) : -1,
							before,
						);
					} else {
						observeCallbacks.added!(doc);
					}
				},
				changed(id, fields) {
					if (!(observeCallbacks.changedAt || observeCallbacks.changed)) {
						return;
					}

					const doc = EJSON.clone(this.docs.get(id));
					if (!doc) {
						throw new Error(`Unknown id for changed: ${id}`);
					}

					const oldDoc = transform(EJSON.clone(doc));

					DiffSequence.applyChanges(doc, fields);

					if (observeCallbacks.changedAt) {
						observeCallbacks.changedAt(transform(doc), oldDoc, indices ? (this.docs as OrderedDict<T['_id'], T>).indexOf(id) : -1);
					} else {
						observeCallbacks.changed!(transform(doc), oldDoc);
					}
				},
				movedBefore(id, before) {
					if (!observeCallbacks.movedTo) {
						return;
					}

					const from = indices ? (this.docs as OrderedDict<T['_id'], T>).indexOf(id) : -1;
					// eslint-disable-next-line no-nested-ternary
					let to = indices ? (before ? (this.docs as OrderedDict<T['_id'], T>).indexOf(before) : this.docs.size()) : -1;

					// When not moving backwards, adjust for the fact that removing the
					// document slides everything back one slot.
					if (to > from) {
						--to;
					}

					observeCallbacks.movedTo(transform(EJSON.clone(this.docs.get(id)!)), from, to, before || null);
				},
				removed(id) {
					if (!(observeCallbacks.removedAt || observeCallbacks.removed)) {
						return;
					}

					// technically maybe there should be an EJSON.clone here, but it's about
					// to be removed from this.docs!
					const doc = transform(this.docs.get(id)!);

					if (observeCallbacks.removedAt) {
						observeCallbacks.removedAt(doc, indices ? (this.docs as OrderedDict<T['_id'], T>).indexOf(id) : -1);
					} else {
						observeCallbacks.removed!(doc);
					}
				},
			};
		} else {
			observeChangesCallbacks = {
				added(id, fields) {
					if (!suppressed && observeCallbacks.added) {
						observeCallbacks.added(transform(Object.assign(fields, { _id: id })));
					}
				},
				changed(id, fields) {
					if (observeCallbacks.changed) {
						const oldDoc = this.docs.get(id)!;
						const doc = EJSON.clone(oldDoc);

						DiffSequence.applyChanges(doc!, fields);

						observeCallbacks.changed(transform(doc), transform(EJSON.clone(oldDoc)));
					}
				},
				removed(id) {
					if (observeCallbacks.removed) {
						observeCallbacks.removed(transform(this.docs.get(id)!));
					}
				},
			};
		}

		const changeObserver = new _CachingChangeObserver({
			callbacks: observeChangesCallbacks,
		});

		// CachingChangeObserver clones all received input on its callbacks
		// So we can mark it as safe to reduce the ejson clones.
		// This is tested by the `mongo-livedata - (extended) scribbling` tests
		changeObserver.applyChange._fromObserve = true;
		const handle = this.observeChanges(changeObserver.applyChange);

		// If needed, re-enable callbacks as soon as the initial batch is ready.
		const setSuppressed = (h: any) => {
			if (h.isReady) suppressed = false;
			// eslint-disable-next-line no-return-assign
			else h.isReadyPromise?.then(() => (suppressed = false));
		};
		// When we call cursor.observeChanges() it can be the on from
		// the mongo package (instead of the minimongo one) and it doesn't have isReady and isReadyPromise
		if (Meteor._isPromise(handle)) {
			handle.then(setSuppressed);
		} else {
			setSuppressed(handle);
		}
		return handle;
	}

	private _observeCallbacksAreOrdered(callbacks: ObserveCallbacks<TProjection>) {
		if (callbacks.added && callbacks.addedAt) {
			throw new Error('Please specify only one of added() and addedAt()');
		}

		if (callbacks.changed && callbacks.changedAt) {
			throw new Error('Please specify only one of changed() and changedAt()');
		}

		if (callbacks.removed && callbacks.removedAt) {
			throw new Error('Please specify only one of removed() and removedAt()');
		}

		return !!(callbacks.addedAt || callbacks.changedAt || callbacks.movedTo || callbacks.removedAt);
	}

	// Is the selector just lookup by _id (shorthand or not)?
	private _selectorIsIdPerhapsAsObject(selector: unknown): selector is T['_id'] | Pick<T, '_id'> {
		return (
			_selectorIsId(selector) ||
			(_selectorIsId(selector && (selector as { _id?: string })._id) && Object.keys(selector as object).length === 1)
		);
	}

	static _observeChangesCallbacksAreOrdered<T extends { _id: string }>(callbacks: ObserveChangesCallbacks<T>) {
		if (callbacks.added && callbacks.addedBefore) {
			throw new Error('Please specify only one of added() and addedBefore()');
		}

		return !!(callbacks.addedBefore || callbacks.movedBefore);
	}

	private _checkSupportedProjection(fields: FieldSpecifier) {
		if (fields !== Object(fields) || Array.isArray(fields)) {
			throw createMinimongoError('fields option must be an object');
		}

		Object.keys(fields).forEach((keyPath) => {
			if (keyPath.split('.').includes('$')) {
				throw createMinimongoError("Minimongo doesn't support $ operator in projections yet.");
			}

			const value = fields[keyPath];

			if (typeof value === 'object' && ['$elemMatch', '$meta', '$slice'].some((key) => hasOwn.call(value, key))) {
				throw createMinimongoError("Minimongo doesn't support operators in projections yet.");
			}

			if (![1, 0, true, false].includes(value)) {
				throw createMinimongoError('Projection values should be one of 1, 0, true, or false');
			}
		});
	}

	// Knows how to compile a fields projection to a predicate function.
	// @returns - Function: a closure that filters out an object according to the
	//            fields projection rules:
	//            @param obj - Object: MongoDB-styled document
	//            @returns - Object: a document with the fields filtered out
	//                       according to projection rules. Doesn't retain subfields
	//                       of passed argument.
	private _compileProjection(fields: FieldSpecifier) {
		this._checkSupportedProjection(fields);

		const _idProjection = fields._id === undefined ? true : fields._id;
		const details = projectionDetails(fields);

		// returns transformed doc according to ruleTree
		const transform = (doc: any, ruleTree: any): any => {
			// Special case for "sets"
			if (Array.isArray(doc)) {
				return doc.map((subdoc) => transform(subdoc, ruleTree));
			}

			const result = details.including ? {} : EJSON.clone(doc);

			Object.keys(ruleTree).forEach((key) => {
				if (doc == null || !hasOwn.call(doc, key)) {
					return;
				}

				const rule = ruleTree[key];

				if (rule === Object(rule)) {
					// For sub-objects/subsets we branch
					if (doc[key] === Object(doc[key])) {
						result[key] = transform(doc[key], rule);
					}
				} else if (details.including) {
					// Otherwise we don't even touch this subfield
					result[key] = EJSON.clone(doc[key]);
				} else {
					delete result[key];
				}
			});

			return doc != null ? result : doc;
		};

		return (doc: any) => {
			const result = transform(doc, details.tree);

			if (_idProjection && hasOwn.call(doc, '_id')) {
				result._id = doc._id;
			}

			if (!_idProjection && hasOwn.call(result, '_id')) {
				delete result._id;
			}

			return result;
		};
	}
}

// XXX maybe move these into another ObserveHelpers package or something

// _CachingChangeObserver is an object which receives observeChanges callbacks
// and keeps a cache of the current cursor state up to date in this.docs. Users
// of this class should read the docs field but not modify it. You should pass
// the "applyChange" field as the callbacks to the underlying observeChanges
// call. Optionally, you can specify your own observeChanges callbacks which are
// invoked immediately before the docs field is updated; this object is made
// available as `this` to those callbacks.
export class _CachingChangeObserver<T extends { _id: string }> {
	private ordered: boolean;

	docs: IdMap<T['_id'], T> | OrderedDict<T['_id'], T>;

	applyChange: any;

	constructor(options: any = {}) {
		const orderedFromCallbacks = options.callbacks && Cursor._observeChangesCallbacksAreOrdered(options.callbacks);

		if (hasOwn.call(options, 'ordered')) {
			this.ordered = options.ordered;

			if (options.callbacks && options.ordered !== orderedFromCallbacks) {
				throw Error("ordered option doesn't match callbacks");
			}
		} else if (options.callbacks) {
			this.ordered = orderedFromCallbacks;
		} else {
			throw Error('must provide ordered or callbacks');
		}

		const callbacks = options.callbacks || {};

		if (this.ordered) {
			this.docs = new OrderedDict<T['_id'], T>();
			this.applyChange = {
				addedBefore: (id: any, fields: any, before: any) => {
					// Take a shallow copy since the top-level properties can be changed
					const doc = { ...fields };

					doc._id = id;

					if (callbacks.addedBefore) {
						callbacks.addedBefore.call(this, id, EJSON.clone(fields), before);
					}

					// This line triggers if we provide added with movedBefore.
					if (callbacks.added) {
						callbacks.added.call(this, id, EJSON.clone(fields));
					}

					// XXX could `before` be a falsy ID?  Technically
					// idStringify seems to allow for them -- though
					// OrderedDict won't call stringify on a falsy arg.
					(this.docs as OrderedDict<T['_id'], T>).putBefore(id, doc, before || null);
				},
				movedBefore: (id: any, before: any) => {
					if (callbacks.movedBefore) {
						callbacks.movedBefore.call(this, id, before);
					}

					(this.docs as OrderedDict<T['_id'], T>).moveBefore(id, before || null);
				},
			};
		} else {
			this.docs = new IdMap<T['_id'], T>();
			this.applyChange = {
				added: (id: any, fields: any) => {
					// Take a shallow copy since the top-level properties can be changed
					const doc = { ...fields };

					if (callbacks.added) {
						callbacks.added.call(this, id, EJSON.clone(fields));
					}

					doc._id = id;

					(this.docs as IdMap<T['_id'], T>).set(id, doc);
				},
			};
		}

		// The methods in _IdMap and OrderedDict used by these callbacks are
		// identical.
		this.applyChange.changed = (id: any, fields: any) => {
			const doc = this.docs.get(id);

			if (!doc) {
				throw new Error(`Unknown id for changed: ${id}`);
			}

			if (callbacks.changed) {
				callbacks.changed.call(this, id, EJSON.clone(fields));
			}

			DiffSequence.applyChanges(doc, fields);
		};

		this.applyChange.removed = (id: any) => {
			if (callbacks.removed) {
				callbacks.removed.call(this, id);
			}

			this.docs.remove(id);
		};
	}
}

type ObserveCallbacks<T> = {
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

type ObserveChangesCallbacks<T extends { _id: string }> = {
	addedBefore?: (this: _CachingChangeObserver<T>, id: T['_id'], fields: T, before: T['_id'] | null) => void;
	changed?: (this: _CachingChangeObserver<T>, id: T['_id'], fields: T) => void;
	movedBefore?: (this: _CachingChangeObserver<T>, id: T['_id'], before: T['_id'] | null) => void;
	removed?: (this: _CachingChangeObserver<T>, id: T['_id']) => void;
	added?: (this: _CachingChangeObserver<T>, id: T['_id'], fields: T) => void;
	_allow_unordered?: boolean;
	_suppress_initial?: boolean;
};
